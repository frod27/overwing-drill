/**
 * The scope of a fire drill: what the fleet may touch, how large it may get, and until when. The runner
 * refuses to start without one, signed with the key registered for the drill, and refuses a target
 * that looks like production. Overwing's server checks the same file with the same code when the drill
 * starts. No dependencies: Node's own crypto.
 */
import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";

export type SurfaceSpec = { id: string; kind: "directory"; path: string } | { id: string; kind: "http-kv"; url: string };

export type Scope = {
  version: 1;
  drill_id: string;
  /** What the customer calls the environment the drill runs in. Never production. */
  environment: string;
  /** Where events are sent. */
  overwing_url: string;
  /** Every host the fleet's surfaces live on, as host or host:port. Nothing else is reachable through the fleet's tools. */
  hosts: string[];
  surfaces: SurfaceSpec[];
  limits: { max_agents: number; max_tokens: number; max_seconds: number };
  fleet: { agents: number; mode: "scripted" | "model"; model?: string; seed?: number };
  /** With a model-driven fleet: the model API's host, the one host outside `hosts` the runner itself calls. */
  model_host?: string;
  /** A public host listed in `hosts` on purpose. Anything public not named here stops the drill. */
  public_hosts_acknowledged?: string[];
  /** The scope is no good after this time. */
  not_after: string;
};

export type SignedScope = { scope: Scope; algorithm: "ed25519"; signature: string };
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

/** Ceilings no scope may exceed, whatever it says. */
export const CEILINGS = { max_agents: 100, max_tokens: 5_000_000, max_seconds: 3600, surfaces: 20, hosts: 50 } as const;
export const DRILL_ID = /^swdr_[A-Za-z0-9_-]{20}$/;

/** JSON with every object's keys in order and no spacing: the same bytes for the same scope, whoever writes it. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export const scopeHash = (scope: Scope): string => createHash("sha256").update(canonical(scope)).digest("hex");

export function newKeyPair(): { publicKeyPem: string; privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(), privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
}

/** A public key is accepted only if it is an Ed25519 key in PEM. */
export function readPublicKey(pem: string): Result<string> {
  if (/PRIVATE KEY/.test(pem)) return { ok: false, error: "That is a private key. Register the public key; the private one stays with whoever approves a scope." };
  try {
    const key = createPublicKey(pem);
    if (key.asymmetricKeyType !== "ed25519") return { ok: false, error: "The key must be an Ed25519 public key." };
    return { ok: true, value: key.export({ type: "spki", format: "pem" }).toString() };
  } catch {
    return { ok: false, error: "The key is not a public key in PEM." };
  }
}

export function signScope(scope: Scope, privateKeyPem: string): SignedScope {
  return { scope, algorithm: "ed25519", signature: sign(null, Buffer.from(canonical(scope)), privateKeyPem).toString("base64") };
}

const str = (v: unknown, max = 500): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const int = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
const HOST = /^(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]{1,253})(:\d{1,5})?$/;

/** Checks the shape of a scope and its limits against the ceilings. It does not check the signature. */
export function validateScope(raw: unknown): Result<Scope> {
  const bad = (error: string): Result<Scope> => ({ ok: false, error: `Scope: ${error}` });
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return bad("it must be an object.");
  const s = raw as Record<string, unknown>;
  const known = ["version", "drill_id", "environment", "overwing_url", "hosts", "surfaces", "limits", "fleet", "model_host", "public_hosts_acknowledged", "not_after"];
  const extra = Object.keys(s).find((k) => !known.includes(k));
  if (extra) return bad(`unknown field ${extra}.`);
  if (s.version !== 1) return bad("version must be 1.");
  if (!str(s.drill_id) || !DRILL_ID.test(s.drill_id)) return bad("drill_id is not a drill id.");
  if (!str(s.environment, 60)) return bad("environment is required: the name of the non-production environment the drill runs in.");
  if (!str(s.overwing_url) || !/^https?:\/\//.test(s.overwing_url)) return bad("overwing_url must be an http(s) address.");
  if (!Array.isArray(s.hosts) || s.hosts.length > CEILINGS.hosts || !s.hosts.every((h) => str(h, 260) && HOST.test(h))) return bad(`hosts must be a list of at most ${CEILINGS.hosts} hosts, each host or host:port.`);
  if (!Array.isArray(s.surfaces) || s.surfaces.length === 0 || s.surfaces.length > CEILINGS.surfaces) return bad(`surfaces must list 1 to ${CEILINGS.surfaces} surfaces.`);
  const ids = new Set<string>();
  for (const [i, item] of s.surfaces.entries()) {
    const f = item as Record<string, unknown> | null;
    if (typeof f !== "object" || f === null) return bad(`surfaces[${i}] must be an object.`);
    if (!str(f.id, 200) || ids.has(f.id)) return bad(`surfaces[${i}].id must be a name used once.`);
    ids.add(f.id);
    if (f.kind === "directory") {
      if (!str(f.path, 1000)) return bad(`surfaces[${i}].path is required for a directory.`);
    } else if (f.kind === "http-kv") {
      if (!str(f.url, 1000) || !/^https?:\/\//.test(f.url)) return bad(`surfaces[${i}].url must be an http(s) address.`);
    } else return bad(`surfaces[${i}].kind must be "directory" or "http-kv".`);
  }
  const l = s.limits as Record<string, unknown> | null;
  if (typeof l !== "object" || l === null) return bad("limits is required: max_agents, max_tokens, max_seconds.");
  if (!int(l.max_agents, 1, CEILINGS.max_agents)) return bad(`limits.max_agents must be 1 to ${CEILINGS.max_agents}.`);
  if (!int(l.max_tokens, 0, CEILINGS.max_tokens)) return bad(`limits.max_tokens must be 0 to ${CEILINGS.max_tokens}.`);
  if (!int(l.max_seconds, 1, CEILINGS.max_seconds)) return bad(`limits.max_seconds must be 1 to ${CEILINGS.max_seconds}.`);
  const f = s.fleet as Record<string, unknown> | null;
  if (typeof f !== "object" || f === null) return bad("fleet is required: agents and mode.");
  if (!int(f.agents, 1, CEILINGS.max_agents)) return bad(`fleet.agents must be 1 to ${CEILINGS.max_agents}.`);
  if (f.agents > l.max_agents) return bad(`fleet.agents (${f.agents}) is more than limits.max_agents (${l.max_agents}).`);
  if (f.mode !== "scripted" && f.mode !== "model") return bad('fleet.mode must be "scripted" or "model".');
  if (f.model !== undefined && !str(f.model, 100)) return bad("fleet.model must be a model name.");
  if (f.seed !== undefined && !int(f.seed, 0, 2 ** 31 - 1)) return bad("fleet.seed must be a whole number.");
  if (f.mode === "model" && l.max_tokens === 0) return bad("a model-driven fleet needs limits.max_tokens above 0.");
  if (f.mode === "model" && !(str(s.model_host, 260) && HOST.test(s.model_host))) return bad("model_host is required for a model-driven fleet: the model API's host.");
  if (s.model_host !== undefined && !(str(s.model_host, 260) && HOST.test(s.model_host))) return bad("model_host must be a host.");
  if (s.public_hosts_acknowledged !== undefined && !(Array.isArray(s.public_hosts_acknowledged) && s.public_hosts_acknowledged.every((h) => str(h, 260) && HOST.test(h)))) return bad("public_hosts_acknowledged must be a list of hosts.");
  if (!str(s.not_after, 40) || !Number.isFinite(Date.parse(s.not_after))) return bad("not_after must be a time: when this scope stops being valid.");
  return { ok: true, value: s as unknown as Scope };
}

/** A signed scope is good when its shape is, its signature verifies against the registered key, and it has not expired. */
export function verifySignedScope(raw: unknown, publicKeyPem: string, now: number): Result<Scope> {
  if (typeof raw !== "object" || raw === null) return { ok: false, error: "The scope file must be an object: { scope, algorithm, signature }." };
  const signed = raw as Partial<SignedScope>;
  if (signed.algorithm !== "ed25519" || typeof signed.signature !== "string" || signed.signature.length === 0) return { ok: false, error: "The scope file is not signed. Sign it with the drill's key: overwing-drill sign." };
  const scope = validateScope(signed.scope);
  if (!scope.ok) return scope;
  let good = false;
  try {
    good = verify(null, Buffer.from(canonical(scope.value)), publicKeyPem, Buffer.from(signed.signature, "base64"));
  } catch {
    good = false;
  }
  if (!good) return { ok: false, error: "The scope's signature does not match the key registered for this drill. The file was changed after it was signed, or signed with another key." };
  if (Date.parse(scope.value.not_after) < now) return { ok: false, error: `The scope expired at ${scope.value.not_after}.` };
  return scope;
}

const hostOf = (h: string): string => h.replace(/:\d{1,5}$/, "").replace(/^\[|\]$/g, "").toLowerCase();

/** Hosts a surface or address lives on, as host:port when a port is given. */
export function hostPort(url: string): string {
  const u = new URL(url);
  return u.port ? `${u.hostname}:${u.port}` : u.hostname;
}

const STAGING_LABEL = /^(staging|stage|stg|dev|develop|development|test|testing|qa|uat|sandbox|preview|demo|local)\d*$/;
const PROD_LABEL = /^(prod|production|live|prd|www)\d*$/;

function isPrivateHost(host: string): boolean {
  if (host === "localhost" || host === "::1" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".test")) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (host.includes(":")) return /^f[cd]/.test(host) || host.startsWith("fe80");
  // A single label with no dot is a name on the local network (a compose service, a pod).
  return !host.includes(".");
}

/**
 * Every reason this scope, in this process's environment, looks like production. Any one stops the
 * drill. A host counts as safe when it is private or carries a staging label; a public host needs the
 * scope to acknowledge it by name.
 */
export function productionSigns(scope: Scope, env: Record<string, string | undefined> = {}): string[] {
  const signs: string[] = [];
  const environment = scope.environment.trim().toLowerCase();
  if (environment.split(/[^a-z0-9]+/).some((part) => PROD_LABEL.test(part))) signs.push(`environment is "${scope.environment}"`);
  const acknowledged = new Set((scope.public_hosts_acknowledged ?? []).map(hostOf));
  const surfaceHosts = scope.surfaces.flatMap((s) => (s.kind === "http-kv" ? [hostOf(hostPort(s.url))] : []));
  for (const host of new Set([...scope.hosts.map(hostOf), ...surfaceHosts])) {
    const labels = host.split(/[.-]/);
    if (labels.some((l) => PROD_LABEL.test(l))) signs.push(`host ${host} is named like production`);
    else if (!isPrivateHost(host) && !labels.some((l) => STAGING_LABEL.test(l)) && !acknowledged.has(host)) signs.push(`host ${host} is a public address with no staging name; list it under public_hosts_acknowledged if it is meant`);
  }
  for (const name of ["NODE_ENV", "ENV", "ENVIRONMENT", "APP_ENV", "RAILS_ENV", "DEPLOY_ENV", "STAGE", "VERCEL_ENV"]) {
    const v = env[name];
    if (v && PROD_LABEL.test(v.trim().toLowerCase())) signs.push(`${name} is "${v}" in this process`);
  }
  return signs;
}

/** Whether an address is one the scope lets the fleet reach: a listed host, exactly. */
export function hostAllowed(scope: Scope, url: string): boolean {
  let target: string;
  try {
    target = hostPort(url).toLowerCase();
  } catch {
    return false;
  }
  return scope.hosts.some((h) => h.toLowerCase() === target || (!/:\d+$/.test(h) && h.toLowerCase() === target.replace(/:\d+$/, "")));
}

/** What Overwing keeps of a scope: names and limits, nothing about how to reach anything. */
export function scopeSummary(scope: Scope): { environment: string; hosts: string[]; surfaces: string[]; maxAgents: number; maxTokens: number; maxSeconds: number } {
  return { environment: scope.environment, hosts: scope.hosts, surfaces: scope.surfaces.map((s) => s.id), maxAgents: scope.limits.max_agents, maxTokens: scope.limits.max_tokens, maxSeconds: scope.limits.max_seconds };
}
