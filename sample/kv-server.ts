/**
 * The sample stack's key-value service: a stand-in for a shared cache or scratch store in a staging
 * environment. Two ways to run it, which is the point of the sample:
 *
 *   open      every agent sees every entry (what most shared caches do)
 *   isolated  an agent sees only the entries it wrote itself (X-Actor names the agent)
 *
 * A drill against both shows coordination emerging on the open one and not on the isolated one.
 * In memory, nothing persisted, no authentication: it is a fixture for a drill, never a real service.
 *
 *   node sample/kv-server.ts [--port 8787] [--mode open|isolated]
 */
import { createServer, type Server } from "node:http";

export type Kv = { server: Server; port: number; url: string; entries: Map<string, { value: string; owner: string }>; close: () => Promise<void> };

export function startKv(opts: { port?: number; mode?: "open" | "isolated"; host?: string } = {}): Promise<Kv> {
  const mode = opts.mode ?? "open";
  const entries = new Map<string, { value: string; owner: string }>();
  const visible = (key: string, actor: string): boolean => mode === "open" || entries.get(key)?.owner === actor;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://kv");
    const actor = String(req.headers["x-actor"] ?? "anonymous");
    const send = (status: number, body: string, type = "text/plain; charset=utf-8"): void => {
      res.writeHead(status, { "Content-Type": type });
      res.end(body);
    };
    if (url.pathname === "/healthz") return send(200, "ok");
    if (url.pathname === "/kv" && req.method === "GET") {
      const prefix = url.searchParams.get("prefix") ?? "";
      return send(200, JSON.stringify({ keys: [...entries.keys()].filter((k) => k.startsWith(prefix) && visible(k, actor)).sort() }), "application/json");
    }
    if (!url.pathname.startsWith("/kv/")) return send(404, "not found");
    const key = decodeURIComponent(url.pathname.slice(4));
    if (req.method === "GET") {
      const e = entries.get(key);
      return e && visible(key, actor) ? send(200, e.value) : send(404, "not found");
    }
    if (req.method === "PUT") {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size <= 100_000) chunks.push(c);
      });
      req.on("end", () => {
        if (size > 100_000) return send(413, "too large");
        const existing = entries.get(key);
        if (mode === "isolated" && existing && existing.owner !== actor) return send(403, "not yours");
        entries.set(key, { value: Buffer.concat(chunks).toString("utf8"), owner: existing?.owner ?? actor });
        send(204, "");
      });
      return;
    }
    if (req.method === "DELETE") {
      if (visible(key, actor)) entries.delete(key);
      return send(204, "");
    }
    send(405, "method not allowed");
  });
  return new Promise((resolve) => {
    server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, port, url: `http://localhost:${port}`, entries, close: () => new Promise<void>((done) => server.close(() => done())) });
    });
  });
}

// Run directly: node sample/kv-server.ts --port 8787 --mode isolated
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "\u0000")) {
  const arg = (name: string): string | undefined => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const mode = arg("mode") === "isolated" ? "isolated" : "open";
  startKv({ port: Number(arg("port") ?? 8787), mode, host: "0.0.0.0" }).then((kv) => process.stdout.write(`sample kv (${mode}) listening on ${kv.port}\n`));
}
