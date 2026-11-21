/**
 * What a customer builds and runs is pinned: the base image by digest, the dependencies by a lockfile
 * the image installs from exactly, and no package's install script is run. This reads the files in
 * the package. It builds nothing and reaches nothing, and needs nothing outside the package.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (name: string): string => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");

/** A Dockerfile's instructions: comments dropped, continued lines joined. */
function instructions(text: string): string[] {
  const out: string[] = [];
  let current = "";
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    current += (current ? " " : "") + line.replace(/\\$/, "").trim();
    if (!line.endsWith("\\")) {
      out.push(current);
      current = "";
    }
  }
  if (current) out.push(current);
  return out;
}

/** Whether .dockerignore keeps a path out of the build: each pattern from the top of the build, the last one that matches deciding. */
function ignored(path: string): boolean {
  let out = false;
  for (const raw of read(".dockerignore").split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const keep = line.startsWith("!");
    const pattern = (keep ? line.slice(1) : line).replace(/^\.?\//, "").replace(/\/+$/, "");
    const source = pattern.split("**").map((part) => part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")).join(".*");
    if (new RegExp(`^${source}(/.*)?$`).test(path)) out = !keep;
  }
  return out;
}

type Lock = { lockfileVersion: number; packages: Record<string, { name?: string; version?: string; resolved?: string; integrity?: string; hasInstallScript?: boolean; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }> };
type Package = { name: string; version: string; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; devDependencies?: Record<string, string> };

describe("what a customer builds and runs", () => {
  it("starts from a base image pinned by digest", () => {
    const lines = read("Dockerfile").split("\n");
    const from = lines.filter((l) => /^\s*FROM\s/i.test(l));
    assert.equal(from.length, 1, "one base image");
    assert.match(from[0]!, /^FROM \S+@sha256:[0-9a-f]{64}( AS \S+)?\s*$/i, "the base image is named by its digest: a tag alone can be moved to other bytes");
    assert.ok(lines.some((l) => /^#.*\bnode:22-alpine\b/.test(l)), "the tag the digest was read from is kept in a comment, for whoever moves it next");
  });

  it("installs exactly what the lockfile records, and runs no install script", () => {
    const steps = instructions(read("Dockerfile"));
    const copy = steps.findIndex((s) => /^COPY\s/i.test(s) && /\bpackage\.json\b/.test(s));
    assert.match(steps[copy] ?? "", /^COPY\s+package\.json\s+package-lock\.json\s+\.\/$/i, "the lockfile goes into the image with the package file");
    const installs = steps.map((s, i) => [s, i] as const).filter(([s]) => /^RUN\s/i.test(s) && /\bnpm\s+(ci|install|i|add|update|exec)\b/.test(s));
    assert.equal(installs.length, 1, "one install step");
    const [install, at] = installs[0]!;
    assert.match(install, /\bnpm ci\b/, "npm ci installs the lockfile as it is, or fails; npm install would resolve again");
    for (const flag of ["--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"]) assert.ok(install.split(/\s+/).includes(flag), `npm ci runs with ${flag}`);
    assert.ok(copy >= 0 && copy < at, "and the lockfile is there before the install runs");
    assert.ok(!steps.some((s) => /\bnpm\s+(install|i|add|update)\b/.test(s) || /\bnpx\b/.test(s)), "nothing else in the build resolves a package");
  });

  it("does not leave the lockfile out of the build", () => {
    for (const path of ["package-lock.json", "package.json", "src/cli.ts", "sample/kv-server.ts"]) assert.equal(ignored(path), false, `${path} must reach the build`);
    // The same reading of .dockerignore does see what it keeps out, so the lines above mean something.
    for (const path of ["node_modules/some-package/index.js", "drill-private.pem", "scope.signed.json"]) assert.equal(ignored(path), true, `${path} stays out of the build`);
  });

  it("has a lockfile that is this package's own, with every package pinned by its hash", () => {
    const pkg = JSON.parse(read("package.json")) as Package;
    const lock = JSON.parse(read("package-lock.json")) as Lock;
    const regenerate = "regenerate it with: npm install --package-lock-only --ignore-scripts";
    assert.ok(lock.lockfileVersion >= 2);
    const root = lock.packages[""];
    assert.ok(root, "the lockfile describes this package");
    assert.deepEqual([root.name, root.version], [pkg.name, pkg.version], `package-lock.json is for another version of this package; ${regenerate}`);
    assert.deepEqual(root.optionalDependencies ?? {}, pkg.optionalDependencies ?? {}, `package-lock.json and package.json disagree, and npm ci would refuse them; ${regenerate}`);
    assert.deepEqual(root.dependencies ?? {}, pkg.dependencies ?? {}, regenerate);

    const packages = Object.entries(lock.packages).filter(([path]) => path !== "");
    assert.ok(packages.some(([path]) => path === "node_modules/@anthropic-ai/sdk"), "the model SDK, the one thing a model-driven fleet installs, is locked");
    for (const [path, meta] of packages) {
      assert.match(meta.version ?? "", /^\d+\.\d+\.\d+/, path);
      assert.match(meta.resolved ?? "", /^https:\/\/registry\.npmjs\.org\//, `${path} comes from the npm registry`);
      assert.match(meta.integrity ?? "", /^sha512-[A-Za-z0-9+/]{86}==$/, `${path} is pinned by a hash of its contents`);
      // The image installs with --ignore-scripts. A package that needed its install script would be broken there without a word.
      assert.notEqual(meta.hasInstallScript, true, `${path} has an install script, which the image does not run: check that the fleet does not need it`);
    }
  });
});
