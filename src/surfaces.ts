/**
 * The shared surfaces a drill's fleet works on, and the wrapper that reports what each agent does to
 * them. A surface is a place agents read, write and list: here a directory, or a key-value service over
 * HTTP. The fleet reaches nothing else: an agent is handed these objects and no other tool.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { hostAllowed, type Scope, type SurfaceSpec } from "./scope.ts";

export type Surface = {
  id: string;
  read(key: string): Promise<string | null>;
  write(key: string, content: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
  remove(key: string): Promise<void>;
};

const KEY = /^[A-Za-z0-9._\-/:]{1,300}$/;
function checkKey(key: string): string {
  if (!KEY.test(key) || key.split("/").some((part) => part === ".." || part === ".")) throw new Error(`Not a key this drill will use: ${JSON.stringify(key.slice(0, 80))}`);
  return key;
}

/** A directory as a surface. Keys are paths under the root; nothing above the root is reachable. */
export function directorySurface(id: string, root: string): Surface {
  const base = resolve(root);
  const at = (key: string): string => {
    const p = resolve(base, checkKey(key));
    if (p !== base && !p.startsWith(base + sep)) throw new Error("A key must stay inside the surface's directory.");
    return p;
  };
  return {
    id,
    async read(key) {
      try {
        return await readFile(at(key), "utf8");
      } catch {
        return null;
      }
    },
    async write(key, content) {
      const p = at(key);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, content, "utf8");
    },
    async list(prefix) {
      const out: string[] = [];
      const walk = async (dir: string): Promise<void> => {
        let names: string[];
        try {
          names = await readdir(dir);
        } catch {
          return;
        }
        for (const name of names.sort()) {
          const p = join(dir, name);
          if ((await stat(p)).isDirectory()) await walk(p);
          else out.push(relative(base, p).split(sep).join("/"));
        }
      };
      await walk(base);
      return out.filter((k) => k.startsWith(prefix));
    },
    async remove(key) {
      await rm(at(key), { force: true });
    },
  };
}

/**
 * A key-value service over HTTP as a surface: GET, PUT and DELETE /kv/{key}, and GET /kv?prefix= for a
 * list. `actor` is sent as X-Actor, so a service that keeps agents apart knows who is asking.
 */
/** No call to a surface waits longer than this. */
export const SURFACE_TIMEOUT_MS = 10_000;

export function httpKvSurface(id: string, url: string, actor: string, fleet?: AbortSignal, timeoutMs = SURFACE_TIMEOUT_MS): Surface {
  const base = url.replace(/\/+$/, "");
  const headers = { "X-Actor": actor };
  // Each call ends when the fleet is told to stop, or when the surface has not answered in time.
  const limited = (): AbortSignal => (fleet ? AbortSignal.any([fleet, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs));
  const path = (key: string): string => `${base}/kv/${checkKey(key).split("/").map(encodeURIComponent).join("/")}`;
  return {
    id,
    async read(key) {
      const r = await fetch(path(key), { headers, signal: limited() });
      return r.ok ? await r.text() : null;
    },
    async write(key, content) {
      const r = await fetch(path(key), { method: "PUT", headers, body: content, signal: limited() });
      if (!r.ok) throw new Error(`The surface ${id} refused a write (${r.status}).`);
    },
    async list(prefix) {
      const r = await fetch(`${base}/kv?prefix=${encodeURIComponent(prefix)}`, { headers, signal: limited() });
      if (!r.ok) return [];
      const body = (await r.json()) as { keys?: unknown };
      return Array.isArray(body.keys) ? body.keys.filter((k): k is string => typeof k === "string") : [];
    },
    async remove(key) {
      await fetch(path(key), { method: "DELETE", headers, signal: limited() });
    },
  };
}

/** Opens a surface the scope names, for one actor. An HTTP surface on a host the scope does not list is refused. */
export function openSurface(scope: Scope, spec: SurfaceSpec, actor: string, signal?: AbortSignal, timeoutMs?: number): Surface {
  if (spec.kind === "directory") return directorySurface(spec.id, spec.path);
  if (!hostAllowed(scope, spec.url)) throw new Error(`The surface ${spec.id} is at ${spec.url}, which is not one of the scope's hosts.`);
  return httpKvSurface(spec.id, spec.url, actor, signal, timeoutMs);
}

/** The hash convention events use for content: sha256, hex, with its name in front. */
export const contentHash = (content: string): string => `sha256:${createHash("sha256").update(content).digest("hex")}`;

export type DrillEvent = {
  id: string;
  surface_id: string;
  artifact_id: string;
  actor_id: string;
  principal_id: string | null;
  op: "read" | "write" | "list" | "delete";
  ts: string;
  content_hash?: string | null;
  parent_artifact_hash?: string | null;
  size_bytes?: number | null;
};

/**
 * Wraps a surface so that everything an actor does to it is reported: the artifact's name, a hash of
 * its content and its size. The content itself goes to the actor and nowhere else. A write is marked as
 * derived from the last artifact the actor read, which is how a chain of hand-offs becomes visible.
 */
export function instrument(surface: Surface, who: { actor: string; principal: string | null }, emit: (e: DrillEvent) => void, ids: () => string, clock: () => number = Date.now): Surface {
  let lastRead: string | null = null;
  const event = (op: DrillEvent["op"], artifact: string, more: Partial<DrillEvent> = {}): void => emit({ id: ids(), surface_id: surface.id, artifact_id: artifact, actor_id: who.actor, principal_id: who.principal, op, ts: new Date(clock()).toISOString(), ...more });
  return {
    id: surface.id,
    async read(key) {
      const content = await surface.read(key);
      if (content !== null) {
        lastRead = contentHash(content);
        event("read", key, { content_hash: lastRead, size_bytes: Buffer.byteLength(content) });
      }
      return content;
    },
    async write(key, content) {
      await surface.write(key, content);
      event("write", key, { content_hash: contentHash(content), parent_artifact_hash: lastRead, size_bytes: Buffer.byteLength(content) });
    },
    async list(prefix) {
      const keys = await surface.list(prefix);
      event("list", prefix || "/");
      return keys;
    },
    async remove(key) {
      await surface.remove(key);
      event("delete", key);
    },
  };
}
