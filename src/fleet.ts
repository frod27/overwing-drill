/**
 * The fleet and the three things that stop it. Each agent is a function handed an abort signal, its
 * surfaces and a token meter, and nothing else. The fleet ends when every agent is done, or at once
 * when any of these happens: the kill switch is pulled, the wall clock runs out, or the token cap is
 * reached. An agent that does not stop on its own is abandoned after a short grace: the fleet is
 * reported stopped within seconds whatever an agent is doing.
 */
import { existsSync } from "node:fs";

export type StopReason = "completed" | "kill switch: signal" | "kill switch: stop file" | "kill switch: stopped from Overwing" | "limit: wall clock" | "limit: tokens" | "error";

/** One source of "stop": aborts once, and remembers why. */
export class KillSwitch {
  readonly controller = new AbortController();
  reason: StopReason | null = null;
  at: number | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private cleanups: (() => void)[] = [];

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  pull(reason: StopReason): void {
    if (this.reason !== null) return;
    this.reason = reason;
    this.at = Date.now();
    this.controller.abort(new Error(reason));
    this.release();
  }

  /** Ctrl-C and a container's stop both pull the switch. */
  watchSignals(proc: Pick<NodeJS.Process, "on" | "off"> = process): void {
    const onSignal = (): void => this.pull("kill switch: signal");
    proc.on("SIGINT", onSignal);
    proc.on("SIGTERM", onSignal);
    this.cleanups.push(() => {
      proc.off("SIGINT", onSignal);
      proc.off("SIGTERM", onSignal);
    });
  }

  /** A file that, once it exists, stops the fleet: `overwing-drill stop` creates it, and so can anyone with a shell. */
  watchFile(path: string, everyMs = 250): void {
    this.every(everyMs, () => {
      if (existsSync(path)) this.pull("kill switch: stop file");
    });
  }

  /** The drill's status on Overwing, read every two seconds. Anything but "run" stops the fleet; so does losing sight of it for too long. */
  watchRemote(shouldRun: () => Promise<boolean>, everyMs = 2000, maxMisses = 5): void {
    let misses = 0;
    let busy = false;
    this.every(everyMs, () => {
      if (busy) return;
      busy = true;
      // A check that never answers must not leave the switch blind: past two intervals it is a miss.
      let late: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        late = setTimeout(() => reject(new Error("no answer")), everyMs * 2);
      });
      Promise.race([shouldRun(), timeout])
        .then((run) => {
          misses = 0;
          if (!run) this.pull("kill switch: stopped from Overwing");
        })
        .catch(() => {
          // A drill nobody can stop from outside must not keep running.
          if (++misses >= maxMisses) this.pull("kill switch: stopped from Overwing");
        })
        .finally(() => {
          clearTimeout(late);
          busy = false;
        });
    });
  }

  private every(ms: number, fn: () => void): void {
    const t = setInterval(fn, ms);
    t.unref?.();
    this.timers.push(t);
  }

  /** Stops watching. Called when the fleet has ended for any reason. */
  release(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const c of this.cleanups) c();
    this.cleanups = [];
  }
}

/** Tokens the whole fleet has used. Reaching the cap pulls the switch. */
export class TokenMeter {
  used = 0;
  private max: number;
  private kill: KillSwitch;
  constructor(max: number, kill: KillSwitch) {
    this.max = max;
    this.kill = kill;
  }
  /** Adds what one model call used. False when the fleet is now over its cap. */
  add(n: number): boolean {
    this.used += Math.max(0, Math.floor(n));
    if (this.used >= this.max) {
      this.kill.pull("limit: tokens");
      return false;
    }
    return true;
  }
  get left(): number {
    return Math.max(0, this.max - this.used);
  }
}

export type AgentContext = { index: number; actor: string; signal: AbortSignal; tokens: TokenMeter };
export type Agent = (ctx: AgentContext) => Promise<void>;

export type FleetResult = {
  reason: StopReason;
  agents: number;
  finished: number;
  failed: number;
  /** Agents that returned because the fleet was told to stop. */
  interrupted: number;
  /** Agents that had not returned when the grace ran out. */
  abandoned: number;
  tokens: number;
  seconds: number;
  /** Milliseconds from the stop being called for to the fleet being reported stopped. Null when it simply finished. */
  stopMs: number | null;
  errors: string[];
};

export type Limits = { max_agents: number; max_tokens: number; max_seconds: number };

/** How long agents get to return once the fleet is told to stop. */
export const STOP_GRACE_MS = 3000;

/**
 * Runs the agents together under the limits. Refuses a fleet larger than `max_agents` before anything
 * starts. Never throws for what an agent does: an agent's failure is counted and the rest go on.
 */
export async function runFleet(agents: readonly Agent[], limits: Limits, kill: KillSwitch, opts: { graceMs?: number; clock?: () => number } = {}): Promise<FleetResult> {
  if (agents.length > limits.max_agents) throw new Error(`The fleet has ${agents.length} agents and the scope allows ${limits.max_agents}. Nothing was started.`);
  const clock = opts.clock ?? Date.now;
  const started = clock();
  const tokens = new TokenMeter(limits.max_tokens > 0 ? limits.max_tokens : Number.MAX_SAFE_INTEGER, kill);
  const wallClock = setTimeout(() => kill.pull("limit: wall clock"), limits.max_seconds * 1000);
  let finished = 0;
  let failed = 0;
  let interrupted = 0;
  const errors: string[] = [];
  const running = agents.map((agent, index) =>
    Promise.resolve()
      .then(() => agent({ index, actor: `drill-agent-${String(index + 1).padStart(2, "0")}`, signal: kill.signal, tokens }))
      .then(
        () => {
          finished++;
        },
        (e: unknown) => {
          // An agent cut off by the stop is not a failure of its own.
          if (kill.signal.aborted) {
            interrupted++;
            return;
          }
          failed++;
          if (errors.length < 10) errors.push(e instanceof Error ? e.message : String(e));
        },
      ),
  );
  const all = Promise.all(running).then(() => "done" as const);
  const stopped = new Promise<"stopped">((resolveStopped) => {
    if (kill.signal.aborted) resolveStopped("stopped");
    else kill.signal.addEventListener("abort", () => resolveStopped("stopped"), { once: true });
  });
  let outcome = await Promise.race([all, stopped]);
  let abandoned = 0;
  if (outcome === "stopped") {
    // Agents were told to stop through their signal. They get a short grace to return; then they are left behind.
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const grace = new Promise<"grace">((r) => {
      graceTimer = setTimeout(() => r("grace"), opts.graceMs ?? STOP_GRACE_MS);
    });
    const settled = await Promise.race([all, grace]);
    clearTimeout(graceTimer);
    if (settled === "grace") abandoned = agents.length - finished - failed - interrupted;
    outcome = "stopped";
  }
  clearTimeout(wallClock);
  const ended = clock();
  const reason: StopReason = kill.reason ?? "completed";
  kill.release();
  return { reason, agents: agents.length, finished, failed, interrupted, abandoned, tokens: tokens.used, seconds: Math.round((ended - started) / 100) / 10, stopMs: kill.at === null ? null : Math.max(0, ended - kill.at), errors };
}

/** Sleeps, and ends early with an error when the fleet is told to stop. Agents wait with this, never with a bare timer. */
export function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolvePause, reject) => {
    if (signal.aborted) return reject(new Error("stopped"));
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolvePause();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(new Error("stopped"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
