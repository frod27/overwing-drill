/**
 * The runner's side of Overwing's API: a drill's status, its start and finish, events in batches, and
 * decoys. Also the helper that plants a decoy on a surface. No dependencies: fetch.
 */
import { contentHash, type DrillEvent, type Surface } from "./surfaces.ts";
import type { Result, SignedScope } from "./scope.ts";

export type DrillStatus = { id: string; status: string; should_run: boolean; public_key: string; report_url?: string };
export type ApiError = Error & { status?: number };

export type Overwing = ReturnType<typeof overwing>;

/** No request to Overwing waits longer than this. */
export const API_TIMEOUT_MS = 20_000;

/** Where the runner sends when it is told nothing else. */
export const DEFAULT_OVERWING_URL = "https://overwing.ai";
/** The only hosts plain http is accepted for: this machine, where a stand-in for Overwing runs in the tests. */
const THIS_MACHINE = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Overwing's address as the runner uses it: `base` is what requests are built on, `origin` is what a scope's address is compared with. */
export type OverwingAddress = { base: string; origin: string; from: string };

/**
 * Reads an address for Overwing. The runner's key is sent to it, and the key a scope is verified with
 * comes from it, so only https is accepted, or http to this machine itself.
 */
export function readOverwingAddress(address: string, from: string): Result<OverwingAddress> {
  // What was given is never repeated whole: it may hold a user name or a token that does not belong in a log.
  const usual = `The usual one is ${DEFAULT_OVERWING_URL}.`;
  let u: URL;
  try {
    u = new URL(address);
  } catch {
    return { ok: false, error: `Overwing's address (${from}) is not an address: it starts with https:// and names a host. ${usual}` };
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && THIS_MACHINE.has(u.hostname))) return { ok: false, error: `Overwing's address must start with https://, because the runner's key is sent to it. Plain http is accepted only for localhost, 127.0.0.1 and [::1]. This one (${from}) starts with ${u.protocol}//${u.host}. ${usual}` };
  if (u.username || u.password || u.search || u.hash) return { ok: false, error: `Overwing's address (${from}) must be an address alone, with no user name, password, query or fragment. ${usual}` };
  return { ok: true, value: { base: `${u.origin}${u.pathname.replace(/\/+$/, "")}`, origin: u.origin, from } };
}

/**
 * Overwing's address for this run: the command line's (--overwing-url), else the environment's
 * (OVERWING_URL), else https://overwing.ai. Never the scope file's. The scope is the one thing here
 * that someone else wrote, and whoever can change it would otherwise choose where the key goes.
 */
export function chooseOverwing(flag: string | undefined, env: Record<string, string | undefined>): Result<OverwingAddress> {
  if (flag !== undefined) return readOverwingAddress(flag, "from --overwing-url");
  if (env.OVERWING_URL) return readOverwingAddress(env.OVERWING_URL, "from OVERWING_URL");
  return readOverwingAddress(DEFAULT_OVERWING_URL, "the default");
}

/** Why a scope may not be run against this address: it was written for another. Null when it names the same origin. */
export function scopeNamesAnother(scopeUrl: string, chosen: OverwingAddress): string | null {
  let named: string;
  try {
    named = new URL(scopeUrl).origin;
  } catch {
    named = "an address that cannot be read";
  }
  if (named === chosen.origin) return null;
  return `The scope names Overwing at ${named}, and this runner sends to ${chosen.origin} (${chosen.from}). Nothing was sent. The runner's key goes only to the address the runner itself is given, never to one a scope file names. If the scope's address really is your Overwing, give it to the runner yourself: --overwing-url <address>, or OVERWING_URL. If you do not recognise it, do not run this scope.`;
}

export function overwing(opts: { baseUrl: string; key: string; fetch?: typeof fetch; timeoutMs?: number }) {
  // The key goes nowhere but over https, or to this machine: whatever built the address, it is read again here.
  const address = readOverwingAddress(opts.baseUrl, "given to the client");
  if (!address.ok) throw new Error(address.error);
  const base = address.value.base;
  const doFetch = opts.fetch ?? fetch;
  const limit = opts.timeoutMs ?? API_TIMEOUT_MS;
  async function call<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const r = await doFetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${opts.key}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(limit)]) : AbortSignal.timeout(limit) });
    const text = await r.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!r.ok) {
      const message = parsed && typeof parsed === "object" && typeof (parsed as { error?: unknown }).error === "string" ? (parsed as { error: string }).error : `Overwing answered ${r.status}`;
      const err: ApiError = new Error(message);
      err.status = r.status;
      throw err;
    }
    return parsed as T;
  }
  return {
    drill: (id: string, signal?: AbortSignal) => call<DrillStatus>("GET", `/api/v1/swarm/drills/${id}`, undefined, signal),
    start: (id: string, signed: SignedScope) => call<DrillStatus>("POST", `/api/v1/swarm/drills/${id}/start`, signed),
    finish: (id: string, body: { outcome: "completed" | "stopped" | "failed"; summary: Record<string, string | number | boolean | null> }) => call<DrillStatus>("POST", `/api/v1/swarm/drills/${id}/finish`, body),
    comparison: (id: string, body: { alerts: number; incidents: { id: string; matched: boolean; alert_at: string | null }[] }) => call<DrillStatus>("POST", `/api/v1/swarm/drills/${id}/comparison`, body),
    retireDecoy: (decoyId: string) => call<{ id: string; retired: boolean }>("DELETE", `/api/v1/swarm/decoys/${decoyId}`),
    report: (id: string) => call<Record<string, unknown>>("GET", `/api/v1/swarm/drills/${id}/report`),
    events: (events: DrillEvent[], drillId: string | null) => call<{ accepted: number; duplicates: number }>("POST", "/api/v1/swarm/events", { events, ...(drillId ? { drill_id: drillId } : {}) }),
    mintDecoy: (surfaceId: string, kind?: "credentials" | "export" | "notes" | "config", label?: string) => call<{ id: string; surface_id: string; artifact_id: string; content_hash: string; content: string }>("POST", "/api/v1/swarm/decoys", { surface_id: surfaceId, ...(kind ? { kind } : {}), ...(label ? { label } : {}) }),
  };
}

/**
 * Plants a decoy: asks Overwing for one, writes its content to the surface, and reports that write, so
 * planting is on the record and is not itself counted as a touch. After this, any read of the artifact
 * opens an incident. Needs a key that may mint decoys (scope "full").
 */
export async function plantDecoy(api: Pick<Overwing, "mintDecoy" | "events">, surface: Surface, opts: { kind?: "credentials" | "export" | "notes" | "config"; actor?: string; label?: string; drillId?: string | null } = {}): Promise<{ id: string; artifactId: string; contentHash: string }> {
  const decoy = await api.mintDecoy(surface.id, opts.kind, opts.label);
  await surface.write(decoy.artifact_id, decoy.content);
  const hash = contentHash(decoy.content);
  await api.events([{ id: `plant-${decoy.id}`, surface_id: surface.id, artifact_id: decoy.artifact_id, actor_id: opts.actor ?? "decoy-planter", principal_id: null, op: "write", ts: new Date().toISOString(), content_hash: hash, size_bytes: Buffer.byteLength(decoy.content) }], opts.drillId ?? null);
  return { id: decoy.id, artifactId: decoy.artifact_id, contentHash: hash };
}

/**
 * Collects events and sends them in batches. A batch that fails is sent again with the same event ids,
 * which the ingest counts once. `close` sends what is left.
 */
export function eventBuffer(send: (events: DrillEvent[]) => Promise<unknown>, opts: { maxBatch?: number; everyMs?: number; onError?: (e: unknown) => void } = {}) {
  const maxBatch = opts.maxBatch ?? 400;
  let queue: DrillEvent[] = [];
  let sent = 0;
  let failed = 0;
  let flushing: Promise<void> = Promise.resolve();
  async function flushOnce(): Promise<void> {
    while (queue.length > 0) {
      const batch = queue.slice(0, maxBatch);
      let ok = false;
      for (let attempt = 0; attempt < 3 && !ok; attempt++) {
        try {
          await send(batch);
          ok = true;
        } catch (e: unknown) {
          const status = (e as ApiError).status;
          // A refusal will be a refusal again: only a failure to reach Overwing, or its own error, is worth another try.
          if (status !== undefined && status < 500 && status !== 429) {
            opts.onError?.(e);
            break;
          }
          if (attempt === 2) opts.onError?.(e);
          else await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
        }
      }
      queue = queue.slice(batch.length);
      if (ok) sent += batch.length;
      else failed += batch.length;
    }
  }
  const flush = (): Promise<void> => (flushing = flushing.then(flushOnce));
  const timer = setInterval(() => void flush(), opts.everyMs ?? 1000);
  timer.unref?.();
  return {
    push(e: DrillEvent): void {
      queue.push(e);
      if (queue.length >= maxBatch) void flush();
    },
    flush,
    async close(): Promise<{ sent: number; failed: number }> {
      clearInterval(timer);
      await flush();
      return { sent, failed };
    },
    counts: () => ({ sent, failed, waiting: queue.length }),
  };
}
