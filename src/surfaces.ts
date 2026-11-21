/**
 * The shared surfaces a drill's fleet works on, and the wrapper that reports what each agent does to
 * them. A surface is a place agents read, write and list: here a directory, or a key-value service over
 * HTTP. The fleet reaches nothing else: an agent is handed these objects and no other tool.
 */
import { createHash } from "node:crypto";
import { constants, type Dirent, type Stats } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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

const OUTSIDE = "A key must stay inside the surface's directory.";
/** With this, opening a path whose last step is a symbolic link fails instead of opening what the link points at. */
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const errorCode = (e: unknown): string | undefined => (e as NodeJS.ErrnoException | null)?.code;
const missing = (e: unknown): boolean => errorCode(e) === "ENOENT" || errorCode(e) === "ENOTDIR";

/** Whether a path is a directory itself or somewhere under it. Both are real paths: no link is left in either. */
function within(directory: string, path: string): boolean {
  const rel = relative(directory, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** What is at a path, itself and not what a link there points at. Null when nothing is. */
async function lookAt(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (e: unknown) {
    if (missing(e)) return null;
    throw e;
  }
}

/**
 * A directory as a surface. Keys are paths under the root, and nothing outside the root is reachable,
 * by a key or by a symbolic link. The root's real path is found once. Every read, write, list and
 * delete then goes by the real path of what it touches, which must be inside that root: a link that
 * leads out is refused. A listing never follows a link and never offers one as an entry, and nothing
 * is written or deleted through a link, wherever it points.
 */
export function directorySurface(id: string, root: string): Surface {
  const base = resolve(root);
  let found: string | null = null;
  /** The root's real path, resolved once. Null while the directory is not there and `make` is not set. */
  const realRoot = async (make: boolean): Promise<string | null> => {
    if (found !== null) return found;
    if (make) await mkdir(base, { recursive: true });
    let real: string;
    try {
      real = await realpath(base);
    } catch (e: unknown) {
      if (!make && missing(e)) return null;
      throw e;
    }
    return (found ??= real);
  };
  /** A key is a path relative to the root: one that starts at the top of the file system is refused, wherever it leads. */
  const relativeKey = (key: string): string => {
    if (checkKey(key).startsWith("/") || isAbsolute(key)) throw new Error(OUTSIDE);
    return key;
  };
  /** Where a key points by its text alone: strictly under the root, or it is refused. Links are each operation's to deal with. */
  const under = (rootPath: string, key: string): string => {
    const p = resolve(rootPath, relativeKey(key));
    if (p === rootPath || !within(rootPath, p)) throw new Error(OUTSIDE);
    return p;
  };
  return {
    id,
    async read(key) {
      try {
        const rootPath = await realRoot(false);
        if (rootPath === null) return null;
        // Every link on the way to the entry is resolved first; what is left must be inside the root.
        const target = await realpath(under(rootPath, key));
        if (!within(rootPath, target)) return null;
        const handle = await open(target, constants.O_RDONLY | NOFOLLOW);
        try {
          return await handle.readFile("utf8");
        } finally {
          await handle.close();
        }
      } catch {
        return null;
      }
    },
    async write(key, content) {
      // A key that is refused for its text makes nothing, not even the root.
      relativeKey(key);
      const rootPath = (await realRoot(true)) as string;
      const lexical = under(rootPath, key);
      // The directory the entry goes in, one level at a time from the root: a missing level is made
      // there and nowhere else, and a level that is a link is resolved and must still be inside the root.
      let dir = rootPath;
      for (const part of relative(rootPath, dirname(lexical)).split(sep).filter(Boolean)) {
        const next = join(dir, part);
        // Making a level that is already there fails, link or not, and that is fine: what matters is where it really is.
        const notMade: unknown = await mkdir(next).then(() => null, (e: unknown) => e);
        try {
          dir = await realpath(next);
        } catch (e: unknown) {
          // There, yet leading nowhere: a link with nothing behind it cannot be shown to stay inside.
          throw errorCode(notMade) === "EEXIST" ? new Error(OUTSIDE) : (notMade ?? e);
        }
        if (!within(rootPath, dir)) throw new Error(OUTSIDE);
      }
      const target = join(dir, basename(lexical));
      // Never through a link, wherever it points: the entry is a file of its own, or is not there yet.
      if ((await lookAt(target))?.isSymbolicLink()) throw new Error(`The entry ${key} is a symbolic link, and a drill does not write through one.`);
      const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | NOFOLLOW, 0o666);
      try {
        await handle.writeFile(content, "utf8");
      } finally {
        await handle.close();
      }
    },
    async list(prefix) {
      const rootPath = await realRoot(false).catch(() => null);
      if (rootPath === null) return [];
      const out: string[] = [];
      const walk = async (dir: string): Promise<void> => {
        let entries: Dirent[];
        try {
          // Only a directory that is really inside the root is read, even if a link has taken its place since it was seen.
          if (!within(rootPath, await realpath(dir))) return;
          entries = await readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
          // A link is never followed, and never offered to an agent as an entry.
          if (entry.isSymbolicLink()) continue;
          const p = join(dir, entry.name);
          if (entry.isDirectory()) await walk(p);
          else out.push(relative(rootPath, p).split(sep).join("/"));
        }
      };
      await walk(rootPath);
      return out.filter((k) => k.startsWith(prefix));
    },
    async remove(key) {
      relativeKey(key);
      const rootPath = await realRoot(false);
      if (rootPath === null) return;
      const lexical = under(rootPath, key);
      // The directory the entry is in must really be inside the root. If it is not there, nothing is.
      let dir: string;
      try {
        dir = await realpath(dirname(lexical));
      } catch (e: unknown) {
        if (missing(e)) return;
        throw e;
      }
      if (!within(rootPath, dir)) throw new Error(OUTSIDE);
      const target = join(dir, basename(lexical));
      const there = await lookAt(target);
      if (there === null) return;
      if (there.isSymbolicLink()) throw new Error(`The entry ${key} is a symbolic link, and a drill does not delete through one.`);
      await rm(target, { force: true });
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

/**
 * Opens a scope's surfaces for one drill. A directory is opened once and the same handle is given to
 * every actor, so its real path is found once for the whole drill: a link put where the directory was
 * while the fleet is still coming up does not move the agents that start after it.
 */
export function surfaceOpener(scope: Scope): (spec: SurfaceSpec, actor: string, signal?: AbortSignal, timeoutMs?: number) => Surface {
  const directories = new Map<string, Surface>();
  return (spec, actor, signal, timeoutMs) => {
    if (spec.kind !== "directory") return openSurface(scope, spec, actor, signal, timeoutMs);
    let surface = directories.get(spec.id);
    if (!surface) directories.set(spec.id, (surface = directorySurface(spec.id, spec.path)));
    return surface;
  };
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
