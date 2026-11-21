/**
 * A directory surface stays inside its directory. A key cannot climb out of it, and neither can a
 * symbolic link somebody left in it: a link is never followed in a listing, nothing is written or
 * deleted through one, and one is read through only when it ends inside the directory.
 *
 * This file needs nothing outside the package.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Scope, SurfaceSpec } from "../src/scope.ts";
import { directorySurface, surfaceOpener, type Surface } from "../src/surfaces.ts";

type Place = { top: string; root: string; outside: string; surface: Surface; cleanup: () => Promise<void> };

/** A surface's directory with links planted in it, next to a directory the drill has no business in. */
async function place(): Promise<Place> {
  const top = await mkdtemp(join(tmpdir(), "drill-links-"));
  const root = join(top, "surface");
  const outside = join(top, "outside");
  await mkdir(join(root, "sub"), { recursive: true });
  await mkdir(outside);
  await writeFile(join(root, "inside.txt"), "inside\n");
  await writeFile(join(root, "sub", "note.txt"), "a note\n");
  await writeFile(join(outside, "private.txt"), "not the drill's\n");
  await symlink(join(outside, "private.txt"), join(root, "leak.txt")); // to a file outside
  await symlink(outside, join(root, "out")); // to a directory outside
  await symlink(join(outside, "not-there.txt"), join(root, "dangling.txt")); // to nothing, outside
  await symlink("inside.txt", join(root, "alias.txt")); // to a file inside
  await symlink("..", join(root, "sub", "up")); // back up to the root: a loop for anything that follows it
  return { top, root, outside, surface: directorySurface("scratch", root), cleanup: () => rm(top, { recursive: true, force: true }) };
}

const untouched = async (p: Place): Promise<void> => {
  assert.deepEqual(await readdir(p.outside), ["private.txt"], "nothing was made or removed outside the surface");
  assert.equal(await readFile(join(p.outside, "private.txt"), "utf8"), "not the drill's\n", "and what is there was not changed");
};

describe("a directory surface and the links in it", { skip: process.platform === "win32" ? "making a symbolic link needs a privilege on Windows" : false }, () => {
  it("lists what is really in the directory: never a link, and never what is behind one", async () => {
    const p = await place();
    try {
      assert.deepEqual(await p.surface.list(""), ["inside.txt", "sub/note.txt"]);
      assert.deepEqual(await p.surface.list("sub/"), ["sub/note.txt"]);
      assert.deepEqual(await p.surface.list("out"), []);
    } finally {
      await p.cleanup();
    }
  });

  it("reads nothing through a link that leads out of the directory", async () => {
    const p = await place();
    try {
      assert.equal(await p.surface.read("leak.txt"), null);
      assert.equal(await p.surface.read("out/private.txt"), null);
      assert.equal(await p.surface.read("dangling.txt"), null);
      // What is really inside is read, by its own name or through a link that ends inside.
      assert.equal(await p.surface.read("inside.txt"), "inside\n");
      assert.equal(await p.surface.read("sub/note.txt"), "a note\n");
      assert.equal(await p.surface.read("alias.txt"), "inside\n");
      assert.equal(await p.surface.read("sub/up/inside.txt"), "inside\n");
      assert.equal(await p.surface.read("nothing-here.txt"), null);
    } finally {
      await p.cleanup();
    }
  });

  it("writes nothing through a link, wherever it points, and makes nothing outside the directory", async () => {
    const p = await place();
    try {
      await assert.rejects(p.surface.write("leak.txt", "changed"), /symbolic link/);
      await assert.rejects(p.surface.write("dangling.txt", "made through a link"), /symbolic link/);
      await assert.rejects(p.surface.write("out/new.txt", "made"), /stay inside/);
      await assert.rejects(p.surface.write("out/deeper/new.txt", "made"), /stay inside/);
      await untouched(p);
      // A link that stays inside is still a link: its file is written by its own name or not at all.
      await assert.rejects(p.surface.write("alias.txt", "changed"), /symbolic link/);
      assert.equal(await readFile(join(p.root, "inside.txt"), "utf8"), "inside\n");
      assert.ok((await lstat(join(p.root, "alias.txt"))).isSymbolicLink(), "the link is left as it was");

      await p.surface.write("results/a/b.txt", "new, two levels down");
      assert.equal(await readFile(join(p.root, "results", "a", "b.txt"), "utf8"), "new, two levels down");
      await p.surface.write("inside.txt", "written again");
      assert.equal(await readFile(join(p.root, "inside.txt"), "utf8"), "written again");
      assert.deepEqual(await p.surface.list(""), ["inside.txt", "results/a/b.txt", "sub/note.txt"]);
    } finally {
      await p.cleanup();
    }
  });

  it("deletes nothing through a link", async () => {
    const p = await place();
    try {
      await assert.rejects(p.surface.remove("out/private.txt"), /stay inside/);
      await assert.rejects(p.surface.remove("leak.txt"), /symbolic link/);
      await assert.rejects(p.surface.remove("alias.txt"), /symbolic link/);
      await untouched(p);
      assert.ok((await lstat(join(p.root, "leak.txt"))).isSymbolicLink(), "a link is not the drill's to remove");
      assert.equal(await readFile(join(p.root, "inside.txt"), "utf8"), "inside\n");

      await p.surface.remove("inside.txt");
      assert.equal(existsSync(join(p.root, "inside.txt")), false);
      // Nothing there is nothing to delete, not an error.
      await p.surface.remove("inside.txt");
      await p.surface.remove("no/such/entry.txt");
      await p.surface.remove("dangling.txt/under-a-link-to-nothing");
      await untouched(p);
    } finally {
      await p.cleanup();
    }
  });

  it("refuses a key that climbs out of the directory or starts at the top of the file system", async () => {
    const p = await place();
    try {
      const real = await realpath(p.root);
      const keys = [
        "../outside/private.txt",
        "sub/../../outside/private.txt",
        "..",
        "sub/..",
        "./inside.txt",
        "sub/./note.txt",
        "/etc/hosts",
        join(p.outside, "private.txt"),
        // A key that starts at the top is refused even when it leads back inside: a key is a name under the root.
        join(p.root, "inside.txt"),
        join(real, "inside.txt"),
      ];
      for (const key of keys) {
        assert.equal(await p.surface.read(key), null, `read ${key}`);
        await assert.rejects(p.surface.write(key, "changed"), /stay inside|Not a key/, `write ${key}`);
        await assert.rejects(p.surface.remove(key), /stay inside|Not a key/, `delete ${key}`);
      }
      await untouched(p);
      assert.equal(await readFile(join(p.root, "inside.txt"), "utf8"), "inside\n");
      assert.deepEqual((await readdir(p.top)).sort(), ["outside", "surface"], "and nothing was made beside the surface");
    } finally {
      await p.cleanup();
    }
  });

  it("finds its directory's real path once, and keeps to it", async () => {
    const p = await place();
    try {
      // The scope may name the directory through a link. Its real path is the root from then on.
      const named = join(p.top, "named");
      await symlink(p.root, named);
      const surface = directorySurface("scratch", named);
      assert.deepEqual(await surface.list(""), ["inside.txt", "sub/note.txt"]);
      await surface.write("through-the-name.txt", "written");
      assert.equal(await readFile(join(p.root, "through-the-name.txt"), "utf8"), "written");

      // The name is pointed somewhere else while the drill runs. The surface is still the directory it found.
      await rm(named);
      await symlink(p.outside, named);
      assert.equal(await surface.read("private.txt"), null);
      assert.equal(await surface.read("inside.txt"), "inside\n");
      assert.deepEqual(await surface.list(""), ["inside.txt", "sub/note.txt", "through-the-name.txt"]);
      await surface.write("after-the-change.txt", "written");
      assert.equal(await readFile(join(p.root, "after-the-change.txt"), "utf8"), "written");
      await untouched(p);
    } finally {
      await p.cleanup();
    }
  });

  it("is opened once for a whole drill, so an agent that starts later is in the directory the first one found", async () => {
    const p = await place();
    try {
      const named = join(p.top, "named");
      await symlink(p.root, named);
      const spec: SurfaceSpec = { id: "scratch", kind: "directory", path: named };
      const scope: Scope = { version: 1, drill_id: "swdr_" + "s".repeat(20), environment: "staging", overwing_url: "https://overwing.ai", hosts: [], surfaces: [spec], limits: { max_agents: 2, max_tokens: 0, max_seconds: 5 }, fleet: { agents: 2, mode: "scripted" }, not_after: new Date(Date.now() + 3600_000).toISOString() };
      const open = surfaceOpener(scope);
      // The runner looks at every surface before the drill is declared running: that is when the directory is found.
      assert.deepEqual(await open(spec, "drill-runner").list(""), ["inside.txt", "sub/note.txt"]);
      // While the fleet is still coming up, the name is pointed somewhere else.
      await rm(named);
      await symlink(p.outside, named);
      const later = open(spec, "drill-agent-02");
      assert.equal(await later.read("private.txt"), null);
      assert.deepEqual(await later.list(""), ["inside.txt", "sub/note.txt"]);
      await later.write("from-a-later-agent.txt", "written");
      assert.equal(await readFile(join(p.root, "from-a-later-agent.txt"), "utf8"), "written");
      await untouched(p);
      // Another drill is another opening.
      assert.equal(await surfaceOpener(scope)(spec, "drill-runner").read("private.txt"), "not the drill's\n");
    } finally {
      await p.cleanup();
    }
  });

  it("makes its directory only when it has something to write there", async () => {
    const top = await mkdtemp(join(tmpdir(), "drill-links-"));
    try {
      const root = join(top, "not", "made", "yet");
      const surface = directorySurface("scratch", root);
      assert.deepEqual(await surface.list(""), []);
      assert.equal(await surface.read("a.txt"), null);
      await surface.remove("a.txt");
      await assert.rejects(surface.write("../a.txt", "refused"), /Not a key/);
      await assert.rejects(surface.write("/a.txt", "refused"), /stay inside/);
      assert.deepEqual(await readdir(top), [], "looking, and a refused key, make nothing");
      await surface.write("a.txt", "made");
      assert.equal(await readFile(join(root, "a.txt"), "utf8"), "made");
      assert.deepEqual(await surface.list(""), ["a.txt"]);
    } finally {
      await rm(top, { recursive: true, force: true });
    }
  });
});
