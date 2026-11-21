import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CEILINGS, canonical, hostAllowed, newKeyPair, productionSigns, readPublicKey, scopeHash, scopeSummary, signScope, validateScope, verifySignedScope, type Scope } from "../src/scope.ts";

const scope = (over: Partial<Scope> = {}): Scope => ({
  version: 1,
  drill_id: "swdr_" + "a".repeat(20),
  environment: "staging",
  overwing_url: "https://overwing.ai",
  hosts: ["kv.staging.internal:8080", "localhost:8787"],
  surfaces: [{ id: "scratch", kind: "directory", path: "./data/scratch" }, { id: "kv", kind: "http-kv", url: "http://localhost:8787" }],
  limits: { max_agents: 8, max_tokens: 0, max_seconds: 120 },
  fleet: { agents: 8, mode: "scripted", seed: 1 },
  not_after: new Date(Date.now() + 3600_000).toISOString(),
  ...over,
});
const invalid = (raw: unknown): string => {
  const r = validateScope(raw);
  assert.equal(r.ok, false);
  return r.ok ? "" : r.error;
};
const keys = newKeyPair();
const now = Date.now();

describe("a drill's scope", () => {
  it("accepts a complete scope and summarises it without its addresses", () => {
    assert.equal(validateScope(scope()).ok, true);
    assert.deepEqual(scopeSummary(scope()), { environment: "staging", hosts: ["kv.staging.internal:8080", "localhost:8787"], surfaces: ["scratch", "kv"], maxAgents: 8, maxTokens: 0, maxSeconds: 120 });
  });

  it("requires every part: hosts, surfaces, each limit, the fleet and an expiry", () => {
    for (const field of ["version", "drill_id", "environment", "overwing_url", "hosts", "surfaces", "limits", "fleet", "not_after"] as const) {
      const s = scope() as unknown as Record<string, unknown>;
      delete s[field];
      assert.match(invalid(s), /^Scope: /, field);
    }
    assert.match(invalid({ ...scope(), limits: { max_agents: 8, max_seconds: 60 } }), /max_tokens/);
    assert.match(invalid({ ...scope(), limits: { max_agents: 8, max_tokens: 0 } }), /max_seconds/);
    assert.match(invalid({ ...scope(), limits: { max_tokens: 0, max_seconds: 60 } }), /max_agents/);
    assert.match(invalid({ ...scope(), surfaces: [] }), /surfaces must list/);
    assert.match(invalid({ ...scope(), extra: true }), /unknown field extra/);
    assert.match(invalid(null), /must be an object/);
  });

  it("holds every limit under a ceiling no scope can raise", () => {
    assert.match(invalid(scope({ limits: { max_agents: CEILINGS.max_agents + 1, max_tokens: 0, max_seconds: 60 } })), /max_agents must be 1 to 100/);
    assert.match(invalid(scope({ limits: { max_agents: 8, max_tokens: CEILINGS.max_tokens + 1, max_seconds: 60 } })), /max_tokens/);
    assert.match(invalid(scope({ limits: { max_agents: 8, max_tokens: 0, max_seconds: CEILINGS.max_seconds + 1 } })), /max_seconds must be 1 to 3600/);
    assert.match(invalid(scope({ fleet: { agents: 9, mode: "scripted" } })), /fleet.agents \(9\) is more than limits.max_agents \(8\)/);
    assert.match(invalid(scope({ fleet: { agents: 4, mode: "model" } })), /needs limits.max_tokens above 0/);
    assert.match(invalid(scope({ fleet: { agents: 4, mode: "model" }, limits: { max_agents: 8, max_tokens: 50_000, max_seconds: 60 } })), /model_host is required/);
  });

  it("verifies a signature against the registered key, and nothing else", () => {
    const signed = signScope(scope(), keys.privateKeyPem);
    const ok = verifySignedScope(signed, keys.publicKeyPem, now);
    assert.ok(ok.ok && ok.value.drill_id === scope().drill_id);
    // Through JSON and back, with the keys in another order: still the same scope.
    const reordered = JSON.parse(JSON.stringify({ signature: signed.signature, algorithm: signed.algorithm, scope: Object.fromEntries(Object.entries(signed.scope).reverse()) })) as unknown;
    assert.equal(verifySignedScope(reordered, keys.publicKeyPem, now).ok, true);

    const error = (raw: unknown, key = keys.publicKeyPem, at = now): string => {
      const r = verifySignedScope(raw, key, at);
      assert.equal(r.ok, false);
      return r.ok ? "" : r.error;
    };
    assert.match(error({ scope: scope() }), /not signed/);
    assert.match(error({ ...signed, signature: "" }), /not signed/);
    assert.match(error({ ...signed, scope: { ...signed.scope, hosts: [...signed.scope.hosts, "prod-db.internal"] } }), /signature does not match/);
    assert.match(error({ ...signed, scope: { ...signed.scope, limits: { ...signed.scope.limits, max_seconds: 3600 } } }), /signature does not match/);
    assert.match(error(signed, newKeyPair().publicKeyPem), /signature does not match/);
    assert.match(error({ ...signed, signature: "bm90IGEgc2lnbmF0dXJl" }), /signature does not match/);
    assert.match(error(signed, keys.publicKeyPem, Date.parse(signed.scope.not_after) + 1000), /expired/);
    assert.match(error("nonsense"), /must be an object/);
  });

  it("gives the same bytes and the same hash for the same scope, however it was written", () => {
    const a = scope();
    const b = Object.fromEntries(Object.entries(a).reverse()) as unknown as Scope;
    assert.equal(canonical(a), canonical(b));
    assert.equal(scopeHash(a), scopeHash(b));
    assert.notEqual(scopeHash(a), scopeHash({ ...a, environment: "qa" }));
    assert.equal(canonical({ b: 1, a: [2, { d: 1, c: undefined }] }), '{"a":[2,{"d":1}],"b":1}');
  });

  it("takes only an Ed25519 public key", () => {
    assert.equal(readPublicKey(keys.publicKeyPem).ok, true);
    assert.equal(readPublicKey("not a key").ok, false);
    const priv = readPublicKey(keys.privateKeyPem);
    assert.ok(!priv.ok && /private key/.test(priv.error), "a private key sent by mistake is refused, not quietly accepted");
  });

  it("refuses anything that looks like production", () => {
    assert.deepEqual(productionSigns(scope()), []);
    assert.deepEqual(productionSigns(scope({ environment: "qa-2" })), []);
    for (const environment of ["production", "prod", "Prod-EU", "live", "eu-production-1"]) assert.equal(productionSigns(scope({ environment })).length, 1, environment);
    assert.match(productionSigns(scope({ hosts: ["cache.prod.example.com"] }))[0]!, /named like production/);
    assert.match(productionSigns(scope({ hosts: ["www.example.com"] }))[0]!, /named like production/);
    assert.match(productionSigns(scope({ hosts: ["api.example.com"] }))[0]!, /public address with no staging name/);
    assert.match(productionSigns(scope({ surfaces: [{ id: "kv", kind: "http-kv", url: "https://kv.example.com" }], hosts: [] }))[0]!, /kv.example.com/);
    // A public host is allowed only when the scope names it on purpose, and never when it is named like production.
    assert.deepEqual(productionSigns(scope({ hosts: ["api.example.com"], public_hosts_acknowledged: ["api.example.com"] })), []);
    assert.equal(productionSigns(scope({ hosts: ["prod.example.com"], public_hosts_acknowledged: ["prod.example.com"] })).length, 1);
    for (const host of ["localhost:8787", "127.0.0.1:9000", "10.2.3.4", "192.168.1.20:6379", "172.20.0.5", "kv", "cache.internal", "kv.staging.example.com", "dev-cache.example.com", "sandbox.example.com:8080"]) {
      assert.deepEqual(productionSigns(scope({ hosts: [host], surfaces: [{ id: "scratch", kind: "directory", path: "./d" }] })), [], host);
    }
  });

  it("refuses a host written as a number: it is not a host name, and it is never taken for a private one", () => {
    const directory: Scope["surfaces"] = [{ id: "scratch", kind: "directory", path: "./d" }];
    const hosts = (list: string[], more: Partial<Scope> = {}): Scope => scope({ hosts: list, surfaces: directory, ...more });

    // 2130706433, 0x7f000001, 0177.0.0.1 and 127.1 all reach 127.0.0.1, and 134744072 reaches a public
    // address. None of them shows where it leads, and a name with no dot used to count as private.
    const numbers = ["2130706433", "134744072", "0", "0x7f000001", "0X7F000001", "0x", "0177", "017700000001", "127.1", "127.0.1", "0177.0.0.1", "010.0.0.1", "127.0.0.01", "0x7f.0.0.1", "127.0.0.0x1", "256.0.0.1", "1.2.3.4.5", "127.0.0.1.", "kv.123", "2130706433:8080", "127.1:8080"];
    for (const host of numbers) {
      assert.match(invalid(hosts([host])), /^Scope: hosts: \S+ is not a host name\./, host);
      // The check that production is judged by says the same on its own, for a caller that skipped the shape check.
      const signs = productionSigns(hosts([host]));
      assert.ok(signs.length === 1 && /is not a host name/.test(signs[0]!), `${host}: ${signs.join("; ")}`);
    }
    // Brackets are for an IPv6 address and nothing else.
    for (const host of ["[fd]", "[fe80]", "[1]", "[:]", "[fd]:8080"]) {
      assert.match(invalid(hosts([host])), /is not a host name/, host);
      assert.match(productionSigns(hosts([host]))[0] ?? "", /is not a host name/, host);
    }

    // A name with no dot is a name: it starts with a letter, ends with a letter or digit, and is 63 characters at most.
    for (const host of ["kv", "KV", "k", "redis-1", "localhost", "a".repeat(63), "kv:8787"]) {
      assert.equal(validateScope(hosts([host])).ok, true, host);
      assert.deepEqual(productionSigns(hosts([host])), [], host);
    }
    for (const host of ["1kv", "0kv", "-kv", "kv-", "a".repeat(64)]) {
      assert.match(invalid(hosts([host])), /is not a host name/, host);
      assert.match(productionSigns(hosts([host]))[0] ?? "", /is not a host name/, host);
    }

    // An address written out in full is still read for what it is, and a dotted name is still a name.
    for (const host of ["127.0.0.1", "10.0.0.5:6379", "172.16.0.1", "192.168.1.1", "169.254.1.1", "[::1]:8080", "[fd00::1]", "[FD12:3456::1]", "[fe80::1]", "[0:0:0:0:0:0:0:1]", "kv.staging.internal", "cache-0x1f.internal", "10.staging.example.com"]) {
      assert.equal(validateScope(hosts([host])).ok, true, host);
      assert.deepEqual(productionSigns(hosts([host])), [], host);
    }
    for (const host of ["8.8.8.8", "172.32.0.1", "0.0.0.0", "255.255.255.255", "[2001:db8::1]", "[::ffff:7f00:1]", "[fd::1]", "[fe8::1]:80"]) {
      assert.equal(validateScope(hosts([host])).ok, true, host);
      assert.match(productionSigns(hosts([host]))[0] ?? "", /is a public address/, host);
    }

    // The same in a surface's address, where an address parser has already turned the number into what it stands for.
    const at = (url: string, list: string[] = ["127.0.0.1:8787", "127.0.0.1", "8.0.0.1", "8.8.8.8"]): Scope => scope({ hosts: list, surfaces: [{ id: "kv", kind: "http-kv", url }] });
    for (const [url, standsFor] of [["http://2130706433:8787", "127.0.0.1"], ["http://0x7f000001", "127.0.0.1"], ["http://0177.0.0.1:8787/kv", "127.0.0.1"], ["http://127.1", "127.0.0.1"], ["http://127.0.0.1.:8787", "127.0.0.1"], ["http://010.0.0.1", "8.0.0.1"], ["http://134744072", "8.8.8.8"], ["http://10.0.0.5@134744072", "8.8.8.8"]] as const) {
      assert.ok(invalid(at(url)).startsWith(`Scope: surfaces[0].url: its host is a number that stands for ${standsFor}, not a host name.`), `${url}: ${invalid(at(url))}`);
    }
    for (const url of ["http://kv:99999", "http://[fd]/", "http://kv .internal", "http://256.0.0.1"]) assert.match(invalid(at(url)), /surfaces\[0\]\.url: it is not an address that can be read/, url);
    assert.match(invalid(at("http://my_kv:8787")), /surfaces\[0\]\.url: its host is not a host name/);
    for (const url of ["http://127.0.0.1:8787", "http://127.0.0.1:8787/kv", "http://[::1]:8787", "http://kv:8787", "http://KV.Staging.Internal:8080"]) {
      assert.equal(validateScope(at(url, ["127.0.0.1:8787", "[::1]:8787", "kv:8787", "kv.staging.internal:8080"])).ok, true, url);
    }

    // And wherever else a scope names a host.
    assert.match(invalid(scope({ model_host: "2130706433" })), /model_host: 2130706433 is not a host name/);
    assert.match(invalid(hosts(["8.8.8.8"], { public_hosts_acknowledged: ["134744072"] })), /public_hosts_acknowledged: 134744072 is not a host name/);
    // A public address is still allowed only when it is acknowledged as what it is.
    assert.deepEqual(productionSigns(hosts(["8.8.8.8"], { public_hosts_acknowledged: ["8.8.8.8"] })), []);
  });

  it("refuses when the process itself says it is in production", () => {
    for (const name of ["NODE_ENV", "ENV", "ENVIRONMENT", "APP_ENV", "RAILS_ENV", "DEPLOY_ENV", "STAGE", "VERCEL_ENV"]) assert.equal(productionSigns(scope(), { [name]: "production" }).length, 1, name);
    assert.equal(productionSigns(scope(), { NODE_ENV: "Prod" }).length, 1);
    assert.deepEqual(productionSigns(scope(), { NODE_ENV: "development", STAGE: "staging", PRODUCT: "production" }), []);
  });

  it("lets the fleet reach a listed host, exactly, and no other", () => {
    const s = scope();
    assert.equal(hostAllowed(s, "http://localhost:8787/kv/a"), true);
    assert.equal(hostAllowed(s, "http://kv.staging.internal:8080"), true);
    assert.equal(hostAllowed(s, "http://localhost:9999"), false);
    assert.equal(hostAllowed(s, "http://kv.staging.internal:9090"), false);
    assert.equal(hostAllowed(s, "http://evil.example.com/localhost:8787"), false);
    assert.equal(hostAllowed(s, "not a url"), false);
    assert.equal(hostAllowed(scope({ hosts: ["cache.internal"] }), "http://cache.internal:6379/x"), true, "a host listed without a port covers its ports");
  });
});
