import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KillSwitch, STOP_GRACE_MS, pause, runFleet, type Agent } from "../src/fleet.ts";

const limits = (over: Partial<{ max_agents: number; max_tokens: number; max_seconds: number }> = {}) => ({ max_agents: 10, max_tokens: 0, max_seconds: 30, ...over });
/** An agent that works until it is told to stop, honouring the signal. */
const patient: Agent = async ({ signal }) => {
  for (;;) await pause(50, signal);
};
/** An agent that ignores the signal entirely: the worst case for a stop. */
const stubborn: Agent = () => new Promise<void>(() => undefined);
const quick: Agent = async ({ signal }) => pause(20, signal);

describe("the fleet's limits and its kill switch", () => {
  it("runs to the end when nothing stops it", async () => {
    const r = await runFleet([quick, quick, quick], limits(), new KillSwitch());
    assert.deepEqual([r.reason, r.agents, r.finished, r.failed, r.interrupted, r.abandoned, r.stopMs], ["completed", 3, 3, 0, 0, 0, null]);
  });

  it("refuses a fleet larger than the cap before starting any agent", async () => {
    let started = 0;
    const counting: Agent = async () => {
      started++;
    };
    await assert.rejects(() => runFleet(Array.from({ length: 4 }, () => counting), limits({ max_agents: 3 }), new KillSwitch()), /has 4 agents and the scope allows 3. Nothing was started/);
    assert.equal(started, 0);
  });

  it("stops the whole fleet when the wall clock runs out", async () => {
    const began = Date.now();
    const r = await runFleet([patient, patient, patient, patient], limits({ max_seconds: 1 }), new KillSwitch());
    assert.equal(r.reason, "limit: wall clock");
    assert.equal(r.abandoned, 0, "agents that honour the signal return on their own");
    assert.ok(Date.now() - began < 2500, `took ${Date.now() - began} ms`);
    assert.ok(r.stopMs !== null && r.stopMs < 1000);
  });

  it("stops the whole fleet when the token cap is reached, counting every agent's tokens together", async () => {
    const spender: Agent = async ({ tokens, signal }) => {
      for (;;) {
        if (!tokens.add(400)) return;
        await pause(10, signal);
      }
    };
    const r = await runFleet([spender, spender, patient], limits({ max_tokens: 2000 }), new KillSwitch());
    assert.equal(r.reason, "limit: tokens");
    assert.ok(r.tokens >= 2000 && r.tokens <= 2800, `${r.tokens} tokens`);
    assert.equal(r.abandoned, 0);
  });

  it("stops within seconds when the switch is pulled, whatever the agents are doing", async () => {
    const kill = new KillSwitch();
    const began = Date.now();
    setTimeout(() => kill.pull("kill switch: signal"), 200);
    const r = await runFleet([patient, patient, patient, stubborn, stubborn], limits({ max_seconds: 600 }), kill, { graceMs: 400 });
    const took = Date.now() - began;
    assert.equal(r.reason, "kill switch: signal");
    assert.equal(r.interrupted, 3, "the three that honoured the signal returned");
    assert.equal(r.abandoned, 2, "the two that ignored the signal are left behind, not waited for");
    assert.ok(r.stopMs !== null && r.stopMs < 1000, `reported stopped ${r.stopMs} ms after the pull`);
    assert.ok(took < 2000, `took ${took} ms`);
  });

  it("is reported stopped within five seconds even when no agent honours the signal, with the default grace", async () => {
    const kill = new KillSwitch();
    setTimeout(() => kill.pull("kill switch: stopped from Overwing"), 100);
    const r = await runFleet(Array.from({ length: 6 }, () => stubborn), limits({ max_seconds: 600 }), kill);
    assert.equal(r.abandoned, 6);
    assert.ok(r.stopMs !== null && r.stopMs >= STOP_GRACE_MS - 50 && r.stopMs < 5000, `${r.stopMs} ms`);
  });

  it("is pulled by a stop file appearing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "drill-stop-"));
    try {
      const kill = new KillSwitch();
      kill.watchFile(join(dir, "stop"), 50);
      setTimeout(() => void writeFile(join(dir, "stop"), "now"), 150);
      const r = await runFleet([patient, patient], limits({ max_seconds: 600 }), kill);
      assert.equal(r.reason, "kill switch: stop file");
      assert.ok(r.seconds < 2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("is pulled when Overwing says the drill should not run, and when Overwing cannot be reached for long", async () => {
    let run = true;
    const kill = new KillSwitch();
    kill.watchRemote(async () => run, 40);
    setTimeout(() => (run = false), 150);
    const r = await runFleet([patient, patient], limits({ max_seconds: 600 }), kill);
    assert.equal(r.reason, "kill switch: stopped from Overwing");
    assert.ok(r.seconds < 2);

    const blind = new KillSwitch();
    blind.watchRemote(async () => Promise.reject(new Error("unreachable")), 30, 3);
    const lost = await runFleet([patient], limits({ max_seconds: 600 }), blind);
    assert.equal(lost.reason, "kill switch: stopped from Overwing", "a drill nobody can stop from outside does not keep running");
    assert.ok(lost.seconds < 2);

    // Overwing accepts the connection and never answers: that is a miss too, not a wait without end.
    const hung = new KillSwitch();
    hung.watchRemote(() => new Promise<boolean>(() => undefined), 30, 3);
    const silent = await runFleet([patient], limits({ max_seconds: 600 }), hung);
    assert.equal(silent.reason, "kill switch: stopped from Overwing");
    assert.ok(silent.seconds < 2, `${silent.seconds} s`);
  });

  it("is pulled by an interrupt or a terminate signal, and stops listening afterwards", async () => {
    for (const name of ["SIGINT", "SIGTERM"]) {
      const proc = new EventEmitter();
      const kill = new KillSwitch();
      kill.watchSignals(proc as unknown as NodeJS.Process);
      setTimeout(() => proc.emit(name), 100);
      const r = await runFleet([patient], limits({ max_seconds: 600 }), kill);
      assert.equal(r.reason, "kill switch: signal", name);
      assert.equal(proc.listenerCount(name), 0, "the handlers are removed once the fleet has ended");
    }
  });

  it("remembers the first reason only, and a pulled switch stops a fleet before it starts work", async () => {
    const kill = new KillSwitch();
    kill.pull("kill switch: stop file");
    kill.pull("limit: tokens");
    assert.equal(kill.reason, "kill switch: stop file");
    let worked = false;
    const r = await runFleet([async ({ signal }) => {
      await pause(10, signal);
      worked = true;
    }], limits(), kill);
    assert.equal(r.reason, "kill switch: stop file");
    assert.equal(worked, false);
  });

  it("counts an agent's own failure and lets the rest finish", async () => {
    const failing: Agent = async () => {
      throw new Error("surface refused a write");
    };
    const r = await runFleet([quick, failing, quick], limits(), new KillSwitch());
    assert.deepEqual([r.reason, r.finished, r.failed], ["completed", 2, 1]);
    assert.deepEqual(r.errors, ["surface refused a write"]);
  });
});
