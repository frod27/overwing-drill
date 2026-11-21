/**
 * One drill, start to finish. The order is the safety argument: nothing touches a surface until the
 * scope has been validated, checked against production, verified against the key registered for the
 * drill, and accepted by Overwing, and until every way of stopping the fleet is being watched.
 *
 * Nothing is sent anywhere, the runner's key least of all, until the runner knows where Overwing is
 * from its own command line or environment. The scope file is the one input someone else wrote: it
 * may name Overwing's address, and it is refused if that is not the runner's own.
 *
 * The drill observes. Agents get read, write and list on the scope's surfaces and nothing else: no
 * shell, no credentials, no network tool. It does not probe, exploit or escalate anything.
 */
import { readFile } from "node:fs/promises";
import { scriptedAgent } from "./agents/scripted.ts";
import { chooseOverwing, eventBuffer, overwing, plantDecoy, scopeNamesAnother, type ApiError, type Overwing } from "./client.ts";
import { KillSwitch, runFleet, type Agent, type FleetResult } from "./fleet.ts";
import { alertTimes, compareAlerts, renderReport, type ReportIncident } from "./report.ts";
import { hostAllowed, productionSigns, validateScope, verifySignedScope, type Scope, type SignedScope } from "./scope.ts";
import { instrument, surfaceOpener, type DrillEvent, type Surface } from "./surfaces.ts";

export type RunOptions = {
  /** The signed scope file, parsed. */
  signed: unknown;
  /** An Overwing key: scope "swarm" is enough to run a drill; "full" also lets the runner plant decoys. */
  key: string;
  /**
   * Overwing's address, from the command line (--overwing-url). Without it: OVERWING_URL in `env`, else
   * https://overwing.ai. Never the scope's: a scope that names another address is refused.
   */
  overwingUrl?: string;
  env?: Record<string, string | undefined>;
  /** A file whose appearance stops the fleet. */
  stopFile?: string;
  /** The customer's own alert log for the period, to compare with the incidents. Read here, never sent. */
  alertLog?: string;
  log?: (line: string) => void;
  fetch?: typeof fetch;
  /** Tests pass their own switch to pull it; the CLI lets the runner make one. */
  kill?: KillSwitch;
  /** How often the drill's status is read from Overwing. */
  pollMs?: number;
  /** Builds the model-driven agents. Loaded only for a model fleet, so a scripted drill needs no model SDK. */
  modelAgent?: (scope: Scope, surfacesFor: (actor: string) => Surface[]) => Promise<Agent>;
  staggerMs?: number;
  /** How long a surface may take to answer. */
  surfaceTimeoutMs?: number;
};

export type RunResult = { ok: true; drillId: string; fleet: FleetResult; report: Record<string, unknown>; markdown: string; reportUrl: string | null } | { ok: false; stage: "scope" | "address" | "production" | "signature" | "overwing" | "surfaces"; error: string };

export async function runDrill(opts: RunOptions): Promise<RunResult> {
  const log = opts.log ?? (() => undefined);
  const env = opts.env ?? {};

  // 1. The scope, before anything else. No scope, no drill.
  const envelope = opts.signed as Partial<SignedScope> | null;
  if (typeof envelope !== "object" || envelope === null || envelope.scope === undefined) return { ok: false, stage: "scope", error: "No scope. A drill needs a signed scope file: the hosts and surfaces it may touch, and its limits." };
  const shape = validateScope(envelope.scope);
  if (!shape.ok) return { ok: false, stage: "scope", error: shape.error };
  const scope = shape.value;

  // 2. Overwing's address: the runner's own, never the scope's. A scope written for another address
  //    stops here, before any request is made and before the key is used for anything.
  const address = chooseOverwing(opts.overwingUrl, env);
  if (!address.ok) return { ok: false, stage: "address", error: address.error };
  const another = scopeNamesAnother(scope.overwing_url, address.value);
  if (another) return { ok: false, stage: "address", error: another };

  // 3. Production, by any sign, stops it here.
  const signs = productionSigns(scope, env);
  if (signs.length) return { ok: false, stage: "production", error: `This looks like production, and a drill never runs there: ${signs.join("; ")}.` };
  for (const s of scope.surfaces) if (s.kind === "http-kv" && !hostAllowed(scope, s.url)) return { ok: false, stage: "scope", error: `Surface ${s.id} is at ${s.url}, which is not one of the scope's hosts.` };

  // 4. The signature, against the key Overwing holds for this drill, not one that came with the file:
  //    read from the runner's own address, which is why that address may not come from the file either.
  const api: Overwing = overwing({ baseUrl: address.value.base, key: opts.key, fetch: opts.fetch });
  let reportUrl: string | null = null;
  try {
    const drill = await api.drill(scope.drill_id);
    reportUrl = drill.report_url ?? null;
    const verified = verifySignedScope(opts.signed, drill.public_key, Date.now());
    if (!verified.ok) return { ok: false, stage: "signature", error: verified.error };
    if (drill.status !== "created") return { ok: false, stage: "overwing", error: `This drill is ${drill.status}. A drill runs once; create another to run again.` };
  } catch (e: unknown) {
    return { ok: false, stage: "overwing", error: `Could not read the drill from Overwing: ${(e as Error).message}` };
  }

  // 5. Every surface must open before the drill is declared running. A directory is opened once here
  //    and that handle serves the whole drill, so the directory it really is cannot change under the fleet.
  const open = surfaceOpener(scope);
  const probe: Surface[] = [];
  try {
    for (const spec of scope.surfaces) probe.push(open(spec, "drill-runner", undefined, opts.surfaceTimeoutMs));
    for (const s of probe) {
      try {
        await s.list("");
      } catch (e: unknown) {
        throw new Error(`${s.id} did not answer (${(e as Error).name === "TimeoutError" ? "timed out" : (e as Error).message})`);
      }
    }
  } catch (e: unknown) {
    return { ok: false, stage: "surfaces", error: `A surface could not be opened: ${(e as Error).message}` };
  }

  // 6. Overwing checks the same scope with the same code, and only then is the drill running.
  try {
    await api.start(scope.drill_id, opts.signed as SignedScope);
  } catch (e: unknown) {
    return { ok: false, stage: "overwing", error: `Overwing refused to start the drill: ${(e as Error).message}` };
  }
  log(`Drill ${scope.drill_id} is running in ${scope.environment}, reporting to ${address.value.origin}: ${scope.fleet.agents} ${scope.fleet.mode} agents on ${scope.surfaces.map((s) => s.id).join(", ")}; limits ${scope.limits.max_seconds} s, ${scope.limits.max_tokens} tokens.`);

  // 7. Every way to stop it, watched before the first agent starts.
  const kill = opts.kill ?? new KillSwitch();
  if (!opts.kill) kill.watchSignals();
  if (opts.stopFile) kill.watchFile(opts.stopFile);
  kill.watchRemote(() => api.drill(scope.drill_id).then((d) => d.should_run), opts.pollMs ?? 2000);

  let n = 0;
  const stamp = scope.drill_id.slice(5, 13);
  const ids = (): string => `${stamp}-${String(++n).padStart(6, "0")}`;
  const buffer = eventBuffer((events: DrillEvent[]) => api.events(events, scope.drill_id), {
    onError: (e) => log(`Overwing did not take a batch of events: ${(e as ApiError).message}`),
  });

  // Decoys, where the key may mint them: an entry on each surface that no agent has a reason to open.
  const planted: string[] = [];
  let decoys = "none planted";
  try {
    for (const spec of scope.surfaces) {
      const d = await plantDecoy(api, open(spec, "decoy-planter"), { kind: "notes", actor: "decoy-planter", label: `drill ${scope.drill_id}`, drillId: scope.drill_id });
      planted.push(d.id);
    }
    decoys = `${planted.length} planted, one on each surface, and retired when the drill ended`;
  } catch (e: unknown) {
    decoys = planted.length ? `${planted.length} planted before Overwing refused another (${(e as Error).message})` : `none planted: this key may not mint them (${(e as Error).message}). Use a key with scope "full" to include decoys`;
  }

  // 8. The fleet. Each agent gets its own handle on each surface, reporting under its own name.
  const surfacesFor = (actor: string): Surface[] => scope.surfaces.map((spec) => instrument(open(spec, actor, kill.signal), { actor, principal: null }, buffer.push, ids));
  let fleet: FleetResult;
  try {
    const agent = scope.fleet.mode === "model" ? await (opts.modelAgent ?? (await import("./agents/model.ts")).modelAgent)(scope, surfacesFor) : scriptedAgent(surfacesFor, { staggerMs: opts.staggerMs });
    fleet = await runFleet(Array.from({ length: scope.fleet.agents }, () => agent), scope.limits, kill);
  } catch (e: unknown) {
    kill.pull("error");
    kill.release();
    fleet = { reason: "error", agents: scope.fleet.agents, finished: 0, failed: scope.fleet.agents, interrupted: 0, abandoned: 0, tokens: 0, seconds: 0, stopMs: null, errors: [(e as Error).message] };
  }
  log(`The fleet has stopped: ${fleet.reason}${fleet.stopMs === null ? "" : `, ${fleet.stopMs} ms after the stop was called for`}.`);

  // 9. What was seen is sent, and Overwing is told how it ended.
  const sent = await buffer.close();
  const outcome = fleet.reason === "completed" ? "completed" : fleet.reason === "error" ? "failed" : "stopped";
  const ended = Date.now();
  let report: Record<string, unknown> = {};
  try {
    await api.finish(scope.drill_id, { outcome, summary: { ended_because: fleet.reason, mode: scope.fleet.mode, agents: fleet.agents, finished: fleet.finished, failed: fleet.failed, interrupted: fleet.interrupted, abandoned: fleet.abandoned, tokens: fleet.tokens, seconds: fleet.seconds, stop_ms: fleet.stopMs, events_sent: sent.sent, events_failed: sent.failed, decoys_planted: planted.length } });
    // The decoys come out only now: Overwing's last look at the drill, made as it finished, still had them to check against.
    for (const id of planted) await api.retireDecoy(id).catch(() => undefined);
    report = await api.report(scope.drill_id);
    // 10. The customer's own alerts, compared here. Only the outcome of the comparison is sent.
    if (opts.alertLog) {
      const incidents = (Array.isArray(report.incidents) ? report.incidents : []) as ReportIncident[];
      const started = Date.parse(String((report.drill as Record<string, unknown> | undefined)?.started_at ?? "")) || ended - fleet.seconds * 1000;
      const comparison = compareAlerts(incidents, alertTimes(await readFile(opts.alertLog, "utf8")), { started, ended });
      await api.comparison(scope.drill_id, comparison);
      report = await api.report(scope.drill_id);
    }
  } catch (e: unknown) {
    log(`The drill ended, but its report could not be completed: ${(e as Error).message}`);
  }
  const markdown = renderReport(report, { reason: fleet.reason, agents: fleet.agents, finished: fleet.finished, failed: fleet.failed, interrupted: fleet.interrupted, abandoned: fleet.abandoned, tokens: fleet.tokens, seconds: fleet.seconds, eventsSent: sent.sent, eventsFailed: sent.failed, decoys });
  return { ok: true, drillId: scope.drill_id, fleet, report, markdown, reportUrl };
}
