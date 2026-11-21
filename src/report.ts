/**
 * The customer's side of the report: reading their own alert log, setting it against the drill's
 * incidents, and writing the result out as Markdown. The alert log is read here and never sent
 * anywhere; only a count and, for each incident, whether an alert matched leave this process.
 */

/** A slack either side of an incident inside which an alert counts as being about it. */
export const ALERT_SLACK_MS = 5 * 60_000;

/**
 * The times of the alerts in a log. Accepts JSON lines (a `ts`, `time`, `timestamp`, `at` or
 * `@timestamp` field), a JSON array of such objects, or plain lines that begin with an ISO time.
 */
export function alertTimes(text: string): number[] {
  const out: number[] = [];
  const take = (v: unknown): void => {
    const ms = typeof v === "number" ? (v < 1e12 ? v * 1000 : v) : typeof v === "string" ? Date.parse(v) : NaN;
    if (Number.isFinite(ms)) out.push(ms);
  };
  const fromObject = (o: unknown): void => {
    if (typeof o !== "object" || o === null) return;
    const r = o as Record<string, unknown>;
    take(r.ts ?? r.time ?? r.timestamp ?? r.at ?? r["@timestamp"]);
  };
  const trimmed = text.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) parsed.forEach(fromObject);
      return out.sort((a, b) => a - b);
    } catch {
      // Not one JSON document: read it line by line.
    }
  }
  for (const line of text.split("\n")) {
    const l = line.trim();
    if (!l) continue;
    if (l.startsWith("{")) {
      try {
        fromObject(JSON.parse(l));
        continue;
      } catch {
        // Fall through to a leading time.
      }
    }
    const m = /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)/.exec(l);
    if (m) take(m[1]!.replace(" ", "T"));
  }
  return out.sort((a, b) => a - b);
}

export type ReportIncident = { id: string; first_event_at: string; title?: string; severity?: string; detectors?: string[]; surfaces?: string[]; seconds_into_drill?: number | null };

/** For each incident: did the customer's monitoring raise an alert between its first evidence and a few minutes after? */
export function compareAlerts(incidents: readonly ReportIncident[], alerts: readonly number[], drill: { started: number; ended: number }): { alerts: number; incidents: { id: string; matched: boolean; alert_at: string | null }[] } {
  const during = alerts.filter((a) => a >= drill.started - ALERT_SLACK_MS && a <= drill.ended + ALERT_SLACK_MS);
  return {
    alerts: during.length,
    incidents: incidents.map((i) => {
      const first = Date.parse(i.first_event_at);
      const hit = during.find((a) => a >= first - ALERT_SLACK_MS && a <= Math.max(first, drill.ended) + ALERT_SLACK_MS);
      return { id: i.id, matched: hit !== undefined, alert_at: hit === undefined ? null : new Date(hit).toISOString() };
    }),
  };
}

type Dict = Record<string, unknown>;
const list = (v: unknown): Dict[] => (Array.isArray(v) ? (v as Dict[]) : []);
const words = (v: unknown): string => (Array.isArray(v) ? (v as string[]) : []).map((d) => d.replace(/_/g, " ")).join(", ");
const text = (v: unknown, fallback = "-"): string => (v === null || v === undefined || v === "" ? fallback : String(v));

/** The report Overwing built, as a page a person can read and keep. */
export function renderReport(report: Dict, local: { reason: string; agents: number; finished: number; failed: number; interrupted: number; abandoned: number; tokens: number; seconds: number; eventsSent: number; eventsFailed: number; decoys: string }): string {
  const drill = (report.drill ?? {}) as Dict;
  const totals = (report.totals ?? {}) as Dict;
  const monitoring = (report.monitoring ?? {}) as Dict;
  const lines: string[] = [];
  lines.push(`# Fire drill report: ${text(drill.name)}`, "");
  lines.push(`Drill ${text(drill.id)} in ${text(drill.environment)}. Started ${text(drill.started_at)}, ended ${text(drill.ended_at)} (${text(drill.duration_seconds)} seconds). It ended because: ${local.reason}.`, "");
  lines.push("## What the drill found", "");
  for (const f of Array.isArray(report.findings) ? (report.findings as unknown[]) : []) lines.push(`- ${String(f)}`);
  lines.push("", "## Surfaces", "", "| Surface | Events | Agents | Writes | Coordination | First signal | Detectors |", "|---|---|---|---|---|---|---|");
  for (const s of list(report.surfaces)) lines.push(`| ${text(s.id)} | ${text(s.events)} | ${text(s.actors)} | ${text(s.writes)} | ${s.coordination ? "yes" : "no"} | ${s.first_signal_seconds === null || s.first_signal_seconds === undefined ? "-" : `${String(s.first_signal_seconds)} s`} | ${words(s.detectors) || "-"} |`);
  lines.push("", "## Detectors", "", "| Detector | Fired | Incidents |", "|---|---|---|");
  for (const d of list(report.detectors)) lines.push(`| ${text(d.name).replace(/_/g, " ")} | ${d.evaluated === false ? "not run in a drill" : d.fired ? "yes" : "no"} | ${text(d.incidents)} |`);
  lines.push("", "## Incidents", "");
  if (list(report.incidents).length === 0) lines.push("None.");
  else {
    lines.push("| Incident | Severity | Seconds in | Surfaces | Agents | Your monitoring |", "|---|---|---|---|---|---|");
    for (const i of list(report.incidents)) lines.push(`| ${text(i.title)} (${text(i.id)}) | ${text(i.severity)} | ${text(i.seconds_into_drill)} | ${(Array.isArray(i.surfaces) ? (i.surfaces as string[]) : []).join(", ")} | ${text(i.actors)} | ${text(i.your_monitoring)} |`);
  }
  lines.push("", "## Your own monitoring", "");
  lines.push(monitoring.compared ? `Your alert log had ${text(monitoring.alerts)} alert(s) during the drill. Of ${text(totals.incidents)} incident(s), it caught ${text(monitoring.caught)} and missed ${text(monitoring.missed)}.` : "No alert log was supplied, so the incidents were not compared with your own monitoring. Run the drill again with --alerts <file> to compare.");
  lines.push("", "## The fleet", "");
  lines.push(`- Agents: ${local.agents} (${local.finished} finished, ${local.failed} failed, ${local.interrupted} stopped when the fleet was told to stop${local.abandoned ? `, ${local.abandoned} left behind after not stopping in time` : ""}).`);
  lines.push(`- Wall clock: ${local.seconds} seconds. Tokens used: ${local.tokens}.`);
  lines.push(`- Events sent: ${local.eventsSent}${local.eventsFailed ? ` (${local.eventsFailed} could not be delivered)` : ""}. Events hold names, hashes and sizes; no contents left this environment.`);
  lines.push(`- Decoys: ${local.decoys}.`);
  lines.push(`- Totals seen by Overwing: ${text(totals.events)} events from ${text(totals.actors)} agents on ${text(totals.surfaces)} surfaces.`, "");
  return lines.join("\n");
}
