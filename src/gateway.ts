// `ceptory-mcp --http`: a standalone Streamable HTTP endpoint (e.g. mcp.ceptory.com/mcp) that
// forwards MCP traffic to Ceptory's MCP route. Each client sends its own MCP token; the gateway
// holds no credentials and keeps no state, so it can run as any number of replicas.
import { createServer, type IncomingMessage } from "node:http";
import { Readable } from "node:stream";

const FORWARD_REQUEST_HEADERS = ["authorization", "content-type", "accept", "last-event-id", "user-agent"];
const DROP_RESPONSE_HEADERS = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive"]);
const MAX_BODY_BYTES = 12 * 1024 * 1024;

function forwardHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value !== "string") continue;
    if (FORWARD_REQUEST_HEADERS.includes(key) || key.startsWith("mcp-")) headers.set(key, value);
  }
  const ip = req.socket.remoteAddress;
  if (ip) headers.set("x-forwarded-for", req.headers["x-forwarded-for"] ? `${req.headers["x-forwarded-for"]}, ${ip}` : ip);
  return headers;
}

export function serveGateway(options: { port: number; host: string; upstream: URL; version: string }) {
  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://gateway").pathname;
    if (path === "/health" || path === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, version: options.version }));
      return;
    }
    if (path === "/" && req.method === "GET") {
      res
        .writeHead(200, { "Content-Type": "text/plain; charset=utf-8" })
        .end(`Ceptory MCP server. Endpoint: /mcp (Streamable HTTP, Authorization: Bearer <token>).\nSetup: https://www.ceptory.com/mcp\n`);
      return;
    }
    if (path !== "/mcp") {
      res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Not found. The MCP endpoint is /mcp." }));
      return;
    }
    if (Number(req.headers["content-length"] || 0) > MAX_BODY_BYTES) {
      res.writeHead(413, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Request too large" }));
      return;
    }

    const abort = new AbortController();
    res.on("close", () => abort.abort());
    try {
      const hasBody = req.method === "POST";
      const upstream = await fetch(options.upstream, {
        method: req.method,
        headers: forwardHeaders(req),
        body: hasBody ? (Readable.toWeb(req) as ReadableStream<Uint8Array>) : undefined,
        signal: abort.signal,
        ...(hasBody ? { duplex: "half" } : {}),
      } as RequestInit);
      const headers: Record<string, string> = {};
      upstream.headers.forEach((value, key) => {
        if (!DROP_RESPONSE_HEADERS.has(key)) headers[key] = value;
      });
      res.writeHead(upstream.status, headers);
      if (!upstream.body) return void res.end();
      const body = Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream);
      body.on("error", () => res.end());
      body.pipe(res);
    } catch (error) {
      if (abort.signal.aborted) return;
      console.error("[ceptory-mcp gateway] upstream error:", error instanceof Error ? error.message : error);
      if (!res.headersSent) res.writeHead(502, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Ceptory is unreachable right now. Try again shortly." }));
      else res.end();
    }
  });

  server.keepAliveTimeout = 65_000;
  server.listen(options.port, options.host, () => {
    console.log(`ceptory-mcp ${options.version} gateway on http://${options.host}:${options.port}/mcp → ${options.upstream.href}`);
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
