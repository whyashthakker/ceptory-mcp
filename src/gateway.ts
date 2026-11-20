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

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept, MCP-Protocol-Version, Mcp-Session-Id, Last-Event-ID",
  "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id",
  "Access-Control-Max-Age": "86400",
};

/** This gateway's public origin (https://mcp.ceptory.com behind Railway's proxy). */
function publicOrigin(req: IncomingMessage): string {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, "");
  const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "localhost").split(",")[0]!.trim();
  const proto = String(req.headers["x-forwarded-proto"] ?? "http").split(",")[0]!.trim();
  return `${proto}://${host}`;
}

export function serveGateway(options: { port: number; host: string; upstream: URL; version: string }) {
  const issuer = options.upstream.origin;
  const docs = `${issuer}/mcp`;
  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://gateway").pathname;
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS).end();
      return;
    }
    // OAuth discovery (MCP authorization): this resource is protected by Ceptory's sign-in.
    if (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp") {
      const origin = publicOrigin(req);
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "public, max-age=3600", ...CORS }).end(
        JSON.stringify({
          resource: `${origin}/mcp`,
          authorization_servers: [issuer],
          scopes_supported: ["ceptory"],
          bearer_methods_supported: ["header"],
          resource_name: "Ceptory",
          resource_documentation: docs,
        }),
      );
      return;
    }
    // Older clients look for the authorization server's metadata on the MCP server's own origin.
    if (path === "/.well-known/oauth-authorization-server" || path === "/.well-known/openid-configuration") {
      try {
        const upstream = await fetch(`${issuer}/.well-known/oauth-authorization-server`, { signal: AbortSignal.timeout(10_000) });
        res.writeHead(upstream.status, { "Content-Type": "application/json", "Cache-Control": "public, max-age=3600", ...CORS }).end(await upstream.text());
      } catch {
        res.writeHead(502, { "Content-Type": "application/json", ...CORS }).end(JSON.stringify({ error: "Ceptory is unreachable right now." }));
      }
      return;
    }
    if (path === "/llms.txt" && req.method === "GET") {
      res.writeHead(302, { Location: `${docs}/llms.txt` }).end();
      return;
    }
    if (path === "/health" || path === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, version: options.version }));
      return;
    }
    if (path === "/" && req.method === "GET") {
      res.writeHead(302, { Location: docs }).end();
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
      for (const [k, v] of Object.entries(CORS)) headers[k.toLowerCase()] = v;
      if (upstream.status === 401) {
        // Point clients at this gateway's resource metadata, so sign-in is discovered for this URL.
        const invalid = /error="invalid_token"/.test(upstream.headers.get("www-authenticate") ?? "");
        headers["www-authenticate"] = `Bearer resource_metadata="${publicOrigin(req)}/.well-known/oauth-protected-resource/mcp", scope="ceptory"${invalid ? ', error="invalid_token"' : ""}`;
      }
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
