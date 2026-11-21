/**
 * Where the runner's key goes. Overwing's address is the runner's own: its command line's, else its
 * environment's, else the default. The scope file is the one input somebody else wrote, and it never
 * chooses: a scope that names another address is refused before anything is sent.
 *
 * Nothing here reaches the network. Overwing is a server on this machine that remembers what it was
 * asked, or a fetch that only records the request. This file needs nothing outside the package.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_OVERWING_URL, chooseOverwing, overwing, readOverwingAddress } from "../src/client.ts";
import { runDrill, type RunOptions, type RunResult } from "../src/run.ts";
import { newKeyPair, signScope, type Scope } from "../src/scope.ts";

/** Plainly not a key. */
const KEY = "made-up-key-for-these-tests";
const DRILL = "swdr_" + "x".repeat(20);

type Asked = { method: string; path: string; authorization: string | null };
type Listener = { url: string; asked: Asked[]; close: () => Promise<void> };

/** A server on this machine that answers every request as Overwing would for one drill, and remembers every request. */
function listen(publicKeyPem: string, status = "created"): Promise<Listener> {
  const asked: Asked[] = [];
  const server = createServer((req, res) => {
    asked.push({ method: req.method ?? "", path: (req.url ?? "").split("?")[0] ?? "", authorization: req.headers.authorization ?? null });
    req.resume();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: DRILL, status, should_run: false, public_key: publicKeyPem }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const close = (): Promise<void> =>
        new Promise((done) => {
          server.closeAllConnections();
          server.close(() => done());
        });
      resolve({ url: `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`, asked, close });
    });
  });
}

/** A fetch that reaches nothing: it records the request and answers that there is no such drill. */
function recorder(): { calls: { url: string; authorization: string | null }[]; fetch: typeof fetch } {
  const calls: { url: string; authorization: string | null }[] = [];
  const fake: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
    return new Response(JSON.stringify({ error: "No such drill: this is a test." }), { status: 404, headers: { "Content-Type": "application/json" } });
  };
  return { calls, fetch: fake };
}

const scopeFor = (overwingUrl: string, dir: string): Scope => ({
  version: 1,
  drill_id: DRILL,
  environment: "staging",
  overwing_url: overwingUrl,
  hosts: [],
  surfaces: [{ id: "scratch", kind: "directory", path: join(dir, "scratch") }],
  limits: { max_agents: 2, max_tokens: 0, max_seconds: 5 },
  fleet: { agents: 2, mode: "scripted", seed: 1 },
  not_after: new Date(Date.now() + 3600_000).toISOString(),
});

const run = (more: Partial<RunOptions> & Pick<RunOptions, "signed">): Promise<RunResult> => runDrill({ key: KEY, env: {}, pollMs: 50, staggerMs: 1, ...more });
const refusal = (r: RunResult): { stage: string; error: string } => {
  assert.equal(r.ok, false, "the drill must not start");
  return r.ok ? { stage: "", error: "" } : r;
};
const drillPath = `/api/v1/swarm/drills/${DRILL}`;

describe("the address the runner's key is sent to", () => {
  it("refuses a scope that names another address before anything is sent, so an edited scope gets neither the key nor a drill", async () => {
    const dir = await mkdtemp(join(tmpdir(), "drill-address-"));
    const customer = newKeyPair();
    const intruder = newKeyPair();
    const real = await listen(customer.publicKeyPem);
    const rogue = await listen(intruder.publicKeyPem);
    try {
      // The scope file as someone who can edit it would leave it: pointed at a server of their own, and
      // signed with a key of their own, which that server will say is the drill's registered key.
      const signed = signScope(scopeFor(rogue.url, dir), intruder.privateKeyPem);
      const used: string[] = [];
      const watched: typeof fetch = (input, init) => {
        used.push(String(input));
        return fetch(input, init);
      };

      const told = refusal(await run({ signed, overwingUrl: real.url, fetch: watched }));
      assert.equal(told.stage, "address");
      assert.ok(told.error.includes(rogue.url) && told.error.includes(real.url), `the message names both addresses: ${told.error}`);
      assert.match(told.error, /--overwing-url <address>/, "and says how to give the runner an address");
      assert.match(told.error, /from --overwing-url/);

      // With nothing given, the runner's address is the default, and the scope's is still not taken.
      const byDefault = refusal(await run({ signed, fetch: watched }));
      assert.equal(byDefault.stage, "address");
      assert.ok(byDefault.error.includes(rogue.url) && byDefault.error.includes(`${DEFAULT_OVERWING_URL} (the default)`), byDefault.error);

      const byEnvironment = refusal(await run({ signed, env: { OVERWING_URL: real.url }, fetch: watched }));
      assert.equal(byEnvironment.stage, "address");
      assert.match(byEnvironment.error, /from OVERWING_URL/);

      assert.deepEqual(rogue.asked, [], "the address in the scope file was never called, so it never saw the key");
      assert.deepEqual(real.asked, [], "and nothing was sent to the runner's own address for a scope it refused");
      assert.deepEqual(used, [], "no request was made at all");
      assert.deepEqual(await readdir(dir), [], "no surface was touched");
    } finally {
      await real.close();
      await rogue.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("takes the address from the command line, else the environment, else the default, and sends the key only there", async () => {
    const dir = await mkdtemp(join(tmpdir(), "drill-address-"));
    const keys = newKeyPair();
    const sign = (overwingUrl: string) => signScope(scopeFor(overwingUrl, dir), keys.privateKeyPem);
    try {
      const cases: { name: string; scope: string; flag?: string; env?: Record<string, string>; sentTo: string }[] = [
        { name: "the default", scope: "https://overwing.ai", sentTo: "https://overwing.ai" },
        { name: "the default, with the scope's address written another way", scope: "https://OVERWING.ai:443/", sentTo: "https://overwing.ai" },
        // Same origin, so the scope is not refused; but nothing in the scope's address is used, not even a path.
        { name: "the default, whatever path the scope's address has", scope: "https://overwing.ai/a/path/of/the/scope", sentTo: "https://overwing.ai" },
        { name: "a path in the runner's own address is kept", scope: "https://overwing.two.example", flag: "https://overwing.two.example/behind/a/proxy/", sentTo: "https://overwing.two.example/behind/a/proxy" },
        { name: "an empty OVERWING_URL is no address", scope: "https://overwing.ai", env: { OVERWING_URL: "" }, sentTo: "https://overwing.ai" },
        { name: "OVERWING_URL", scope: "https://overwing.one.example", env: { OVERWING_URL: "https://overwing.one.example" }, sentTo: "https://overwing.one.example" },
        { name: "--overwing-url, over OVERWING_URL", scope: "https://overwing.two.example", flag: "https://overwing.two.example/", env: { OVERWING_URL: "https://overwing.one.example" }, sentTo: "https://overwing.two.example" },
      ];
      for (const c of cases) {
        const seen = recorder();
        const r = refusal(await run({ signed: sign(c.scope), overwingUrl: c.flag, env: c.env ?? {}, fetch: seen.fetch }));
        // The stand-in knows no such drill, so the runner stops there: after exactly one request, to the address it was given.
        assert.equal(r.stage, "overwing", `${c.name}: ${r.error}`);
        assert.deepEqual(seen.calls, [{ url: `${c.sentTo}${drillPath}`, authorization: `Bearer ${KEY}` }], c.name);
      }

      // The command line wins over the environment, so a scope written for the environment's address is refused.
      const seen = recorder();
      const r = refusal(await run({ signed: sign("https://overwing.one.example"), overwingUrl: "https://overwing.two.example", env: { OVERWING_URL: "https://overwing.one.example" }, fetch: seen.fetch }));
      assert.equal(r.stage, "address");
      assert.deepEqual(seen.calls, []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("accepts only https for the address, or http to this machine", async () => {
    for (const address of ["https://overwing.ai", "https://overwing.ai/", "https://overwing.one.example:8443", "http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"]) {
      assert.equal(readOverwingAddress(address, "in a test").ok, true, address);
    }
    const refused = (address: string): string => {
      const r = readOverwingAddress(address, "in a test");
      assert.equal(r.ok, false, address);
      return r.ok ? "" : r.error;
    };
    for (const address of ["http://overwing.ai", "http://overwing.one.example:3000", "http://localhost.one.example", "http://127.0.0.1.one.example", "http://192.168.1.10:3000", "http://0.0.0.0:3000", "http://[::2]:3000", "ftp://overwing.ai", "localhost:3000"]) {
      assert.match(refused(address), /must start with https:\/\//, address);
    }
    for (const address of ["overwing.ai", "", "https://", "not an address"]) assert.match(refused(address), /is not an address/, address);
    for (const address of ["https://someone@overwing.ai", "https://overwing.ai/?next=elsewhere", "https://overwing.ai/#part"]) assert.match(refused(address), /an address alone/, address);
    // What was given is not repeated in the message: a name and a word put in an address stay out of the log.
    assert.ok(!refused("https://someone:madeupword@overwing.ai").includes("madeupword"));

    assert.deepEqual(chooseOverwing(undefined, {}), { ok: true, value: { base: "https://overwing.ai", origin: "https://overwing.ai", from: "the default" } });
    assert.equal(DEFAULT_OVERWING_URL, "https://overwing.ai");

    // The runner refuses such an address before it asks anything, and the client would not have built a request for it either.
    const dir = await mkdtemp(join(tmpdir(), "drill-address-"));
    try {
      const seen = recorder();
      const plain = "http://overwing.one.example";
      const r = refusal(await run({ signed: signScope(scopeFor(plain, dir), newKeyPair().privateKeyPem), overwingUrl: plain, fetch: seen.fetch }));
      assert.equal(r.stage, "address");
      assert.match(r.error, /must start with https:\/\//);
      assert.deepEqual(seen.calls, []);
      assert.throws(() => overwing({ baseUrl: plain, key: KEY, fetch: seen.fetch }), /must start with https:\/\//);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

/** Runs the command-line program as a customer would, with nothing in its environment but what is given. */
function cli(args: string[], env: Record<string, string>, cwd: string): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { cwd, env: { PATH: process.env.PATH ?? "", ...env } as unknown as NodeJS.ProcessEnv, timeout: 30_000 }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : typeof error.code === "number" ? error.code : -1, out: stdout, err: stderr });
    });
  });
}

describe("overwing-drill on the command line", () => {
  it("gives --overwing-url and OVERWING_URL to the runner, and never the scope file's address", async () => {
    const dir = await mkdtemp(join(tmpdir(), "drill-cli-"));
    const customer = newKeyPair();
    const intruder = newKeyPair();
    // A drill that has already run: the runner reads it, says so and stops, which is enough to see where it asked.
    const real = await listen(customer.publicKeyPem, "completed");
    const rogue = await listen(intruder.publicKeyPem);
    try {
      const good = join(dir, "scope.signed.json");
      const edited = join(dir, "edited.signed.json");
      await writeFile(good, JSON.stringify(signScope(scopeFor(real.url, dir), customer.privateKeyPem)));
      await writeFile(edited, JSON.stringify(signScope(scopeFor(rogue.url, dir), intruder.privateKeyPem)));
      const key = { OVERWING_API_KEY: KEY };
      const one = { method: "GET", path: drillPath, authorization: `Bearer ${KEY}` };

      const byFlag = await cli(["run", "--scope", good, "--overwing-url", real.url], key, dir);
      assert.equal(byFlag.code, 1, byFlag.err);
      assert.match(byFlag.err, /did not start \(overwing\): This drill is completed/);
      assert.deepEqual(real.asked, [one], "the flag's address was asked, with the key");

      const byEquals = await cli(["run", `--scope=${good}`, `--overwing-url=${real.url}`], key, dir);
      assert.match(byEquals.err, /did not start \(overwing\): This drill is completed/);
      assert.deepEqual(real.asked, [one, one]);

      const byEnvironment = await cli(["run", "--scope", good], { ...key, OVERWING_URL: real.url }, dir);
      assert.match(byEnvironment.err, /did not start \(overwing\): This drill is completed/);
      assert.deepEqual(real.asked, [one, one, one]);

      // The edited scope, run the way the README says to run a drill: refused, with both addresses named.
      const refusedRun = await cli(["run", "--scope", edited], key, dir);
      assert.equal(refusedRun.code, 1);
      assert.match(refusedRun.err, /did not start \(address\)/);
      assert.ok(refusedRun.err.includes(rogue.url) && refusedRun.err.includes("https://overwing.ai (the default)"), refusedRun.err);
      assert.match(refusedRun.err, /--overwing-url <address>/);

      const refusedWithFlag = await cli(["run", "--scope", edited, "--overwing-url", real.url], key, dir);
      assert.equal(refusedWithFlag.code, 1);
      assert.ok(refusedWithFlag.err.includes(rogue.url) && refusedWithFlag.err.includes(real.url), refusedWithFlag.err);

      // `check` makes the same refusal, and says which address a run would use.
      const refusedCheck = await cli(["check", "--scope", edited], {}, dir);
      assert.equal(refusedCheck.code, 1);
      assert.ok(refusedCheck.err.includes(rogue.url) && refusedCheck.err.includes("https://overwing.ai"), refusedCheck.err);
      const passedCheck = await cli(["check", "--scope", good, "--overwing-url", real.url], {}, dir);
      assert.equal(passedCheck.code, 0, passedCheck.err);
      assert.ok(passedCheck.out.includes(`Overwing: ${real.url} (from --overwing-url)`), passedCheck.out);

      // A flag with nothing after it, and an address that is not https, are mistakes and not "use the default".
      const noValue = await cli(["run", "--scope", good, "--overwing-url"], key, dir);
      assert.equal(noValue.code, 1);
      assert.match(noValue.err, /--overwing-url needs an address/);
      const plain = await cli(["run", "--scope", good, "--overwing-url", "http://overwing.one.example"], key, dir);
      assert.equal(plain.code, 1);
      assert.match(plain.err, /did not start \(address\): Overwing's address must start with https:\/\//);

      assert.deepEqual(rogue.asked, [], "the address in the edited scope was never called");
      assert.deepEqual(real.asked, [one, one, one], "and nothing more was sent to the real one");
    } finally {
      await real.close();
      await rogue.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("says in its help where the key goes", async () => {
    const help = await cli(["help"], {}, tmpdir());
    assert.equal(help.code, 0);
    assert.match(help.out, /run\s+--scope <signed\.json> \[--overwing-url <address>\]/);
    assert.match(help.out, /--overwing-url, else OVERWING_URL, else https:\/\/overwing\.ai/);
    assert.match(help.out, /never taken\s+from the scope file/);
  });
});
