#!/usr/bin/env node
/**
 * overwing-drill: run a Radar fire drill in your own staging environment.
 *
 *   overwing-drill keygen  [--out <dir>]                       make the key pair a scope is signed with
 *   overwing-drill sign    --scope <file> --key <private.pem>  sign a scope file
 *   overwing-drill check   --scope <signed file> [--overwing-url <address>]
 *                                                              validate a signed scope and look for production
 *   overwing-drill run     --scope <signed file> [--overwing-url <address>] [--alerts <file>] [--out <report.md>] [--stop-file <path>]
 *   overwing-drill stop    [--stop-file <path>]                the kill switch, from another shell
 *
 * `run` reads the Overwing key from OVERWING_API_KEY. It refuses to start without a signed scope, and
 * refuses a target that looks like production.
 *
 * The key is sent to Overwing's address and nowhere else. That address is --overwing-url, else
 * OVERWING_URL, else https://overwing.ai: never the scope file's. A scope that names another address
 * is refused before anything is sent.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chooseOverwing, scopeNamesAnother } from "./client.ts";
import { runDrill } from "./run.ts";
import { newKeyPair, productionSigns, signScope, validateScope, type SignedScope } from "./scope.ts";

const DEFAULT_STOP_FILE = ".overwing-drill.stop";

function flags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    // --name=value as well as --name value: a flag written the other way must not be dropped without a word.
    const eq = a.indexOf("=");
    if (eq > 2) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    out[a.slice(2)] = next === undefined || next.startsWith("--") ? "true" : argv[++i]!;
  }
  return out;
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function readJson(path: string | undefined, what: string): unknown {
  if (!path) fail(`--${what} <file> is required.`);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e: unknown) {
    fail(`Could not read ${path}: ${(e as Error).message}`);
  }
}

const USAGE = `overwing-drill <keygen|sign|check|run|stop> [options]

  keygen  [--out <dir>]                           write drill-private.pem and drill-public.pem
  sign    --scope <scope.json> --key <private.pem> [--out <file>]
  check   --scope <signed.json> [--overwing-url <address>]
                                                  validate a signed scope; exits 1 if it looks like production
                                                  or names another Overwing address than the runner's
  run     --scope <signed.json> [--overwing-url <address>] [--alerts <file>] [--out <report.md>] [--stop-file <path>]
  stop    [--stop-file <path>]                    stop a running drill from another shell

run reads OVERWING_API_KEY. A model-driven fleet also needs the model's own key in its usual variable.

Overwing's address is --overwing-url, else OVERWING_URL, else https://overwing.ai. It is never taken
from the scope file: the key is sent only there, and a scope that names another address is refused
before anything is sent. It must be https (http is accepted for localhost, 127.0.0.1 and [::1] only).`;

/** The address given with --overwing-url, if any. The flag alone, with nothing after it, is a mistake and not "use the default". */
function overwingFlag(f: Record<string, string>): string | undefined {
  if (f["overwing-url"] === "true") fail("--overwing-url needs an address after it, for example --overwing-url https://overwing.ai");
  return f["overwing-url"];
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const f = flags(rest);
  switch (command) {
    case "keygen": {
      const dir = f.out ?? ".";
      mkdirSync(dir, { recursive: true });
      const pair = newKeyPair();
      writeFileSync(join(dir, "drill-private.pem"), pair.privateKeyPem, { mode: 0o600 });
      writeFileSync(join(dir, "drill-public.pem"), pair.publicKeyPem);
      process.stdout.write(`Wrote ${join(dir, "drill-private.pem")} and ${join(dir, "drill-public.pem")}.\nRegister the public key when you create the drill. Keep the private key with whoever approves a drill's scope, not on the machine that runs it.\n`);
      return;
    }
    case "sign": {
      const raw = readJson(f.scope, "scope");
      const scope = validateScope((raw as { scope?: unknown }).scope ?? raw);
      if (!scope.ok) fail(scope.error);
      const signs = productionSigns(scope.value);
      if (signs.length) fail(`This scope looks like production and will not be signed: ${signs.join("; ")}.`);
      if (!f.key) fail("--key <private.pem> is required.");
      const signed = signScope(scope.value, readFileSync(f.key, "utf8"));
      const out = f.out ?? f.scope!.replace(/\.json$/, "") + ".signed.json";
      writeFileSync(out, `${JSON.stringify(signed, null, 2)}\n`);
      process.stdout.write(`Signed. Wrote ${out}.\n`);
      return;
    }
    case "check": {
      const raw = readJson(f.scope, "scope") as Partial<SignedScope>;
      const scope = validateScope(raw.scope);
      if (!scope.ok) fail(scope.error);
      if (raw.algorithm !== "ed25519" || !raw.signature) fail("The scope file is not signed.");
      // The same refusal `run` makes, made here without sending anything.
      const address = chooseOverwing(overwingFlag(f), process.env);
      if (!address.ok) fail(address.error);
      const another = scopeNamesAnother(scope.value.overwing_url, address.value);
      if (another) fail(another);
      const signs = productionSigns(scope.value, process.env);
      if (signs.length) fail(`This looks like production: ${signs.join("; ")}.`);
      process.stdout.write(`The scope is well formed and does not look like production. Its signature is checked against the drill's registered key when the drill runs.\n  drill ${scope.value.drill_id} in ${scope.value.environment}\n  Overwing: ${address.value.origin} (${address.value.from})\n  surfaces: ${scope.value.surfaces.map((s) => s.id).join(", ")}\n  hosts: ${scope.value.hosts.join(", ") || "(none)"}\n  limits: ${scope.value.limits.max_agents} agents, ${scope.value.limits.max_tokens} tokens, ${scope.value.limits.max_seconds} seconds\n`);
      return;
    }
    case "run": {
      const key = process.env.OVERWING_API_KEY;
      if (!key) fail("OVERWING_API_KEY is not set.");
      const signed = readJson(f.scope, "scope");
      const stopFile = f["stop-file"] ?? DEFAULT_STOP_FILE;
      if (existsSync(stopFile)) fail(`${stopFile} exists, which is the stop signal. Remove it to run a drill.`);
      const result = await runDrill({ signed, key, overwingUrl: overwingFlag(f), env: process.env, stopFile, alertLog: f.alerts, log: (line) => process.stderr.write(`${line}\n`) });
      if (!result.ok) fail(`The drill did not start (${result.stage}): ${result.error}`);
      const out = f.out ?? `drill-report-${result.drillId}.md`;
      writeFileSync(out, result.markdown);
      process.stdout.write(`${result.markdown}\nReport written to ${out}.${result.reportUrl ? ` Also at ${result.reportUrl}` : ""}\n`);
      // A drill that was stopped or failed is reported as such to whatever ran it.
      process.exit(result.fleet.reason === "completed" ? 0 : 2);
    }
    case "stop": {
      const stopFile = f["stop-file"] ?? DEFAULT_STOP_FILE;
      writeFileSync(stopFile, `${new Date().toISOString()}\n`);
      process.stdout.write(`Wrote ${stopFile}. A drill watching it stops within a second. Remove the file before the next drill.\n`);
      return;
    }
    default:
      process.stdout.write(`${USAGE}\n`);
      if (command && command !== "help" && command !== "--help") process.exit(1);
  }
}

main().catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)));
