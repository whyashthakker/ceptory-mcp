#!/usr/bin/env node
// ceptory-mcp: a stdio bridge to Ceptory's hosted MCP server (https://www.ceptory.com/api/mcp).
//
// The tools live on Ceptory. This bridge lets stdio-only clients (Claude Desktop, older IDEs) use
// them, and adds what only a local process can do: read files from this computer (upload a video,
// send a photo by path instead of base64).
//
// stdout carries JSON-RPC: log only to stderr.
import { parseArgs } from "node:util";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { Readable } from "node:stream";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Server, type CallToolResult, type Tool } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

const VERSION = "1.0.0";
const DEFAULT_URL = "https://www.ceptory.com/api/mcp";

const HELP = `ceptory-mcp ${VERSION}: use Ceptory from Claude Desktop and other MCP clients

Usage: ceptory-mcp            serve MCP over stdio (Claude Desktop, Codex, any stdio client)
       ceptory-mcp --http     run an HTTP gateway at /mcp (each client sends its own token)
                              [--port <n> (default $PORT or 3333)] [--host <h> (default 0.0.0.0)]

Environment:
  CEPTORY_TOKEN     MCP token from https://www.ceptory.com/dashboard/mcp (required)
  CEPTORY_MCP_URL   Ceptory MCP endpoint (default: ${DEFAULT_URL})

Claude Desktop (claude_desktop_config.json):
  { "mcpServers": { "ceptory": { "command": "npx", "args": ["-y", "ceptory-mcp"],
                                 "env": { "CEPTORY_TOKEN": "cpd_…" } } } }
`;

const VIDEO_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".mpeg": "video/mpeg",
  ".mpg": "video/mpeg",
  ".ts": "video/mp2t",
};
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_VIDEO_BYTES = 2 * 1024 ** 3;

const UPLOAD_TOOL: Tool = {
  name: "upload_video_file",
  title: "Upload video file",
  description:
    "Upload a video file from this computer to a Ceptory chat and start indexing it (billed per minute). Up to 2 GB. Poll get_chat_videos until it is READY.",
  inputSchema: {
    type: "object",
    properties: {
      chat_id: { type: "string", description: "Chat ID (from list_chats or create_chat)." },
      path: { type: "string", description: "Absolute path to the video file on this computer." },
      duration_sec: { type: "number", description: "Video length in seconds, if known." },
    },
    required: ["chat_id", "path"],
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
};

function fail(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function firstText(result: CallToolResult): string {
  const block = result.content?.find((c) => c.type === "text");
  return block && "text" in block ? block.text : "";
}

/** Tools that take image_base64 also accept image_path here; the bridge reads the file. */
function withImagePath(tool: Tool): Tool {
  const props = tool.inputSchema?.properties as Record<string, unknown> | undefined;
  if (!props || !("image_base64" in props)) return tool;
  const required = (tool.inputSchema.required ?? []).filter((r) => r !== "image_base64");
  return {
    ...tool,
    description: `${tool.description ?? ""} Pass image_path (a JPEG or PNG on this computer) or image_base64.`.trim(),
    inputSchema: {
      ...tool.inputSchema,
      properties: { ...props, image_path: { type: "string", description: "Absolute path to a JPEG or PNG on this computer." } },
      required,
    },
  };
}

async function readImage(path: string): Promise<string> {
  const full = resolve(path);
  const info = await stat(full);
  if (!info.isFile()) throw new Error(`${full} is not a file.`);
  if (info.size > MAX_IMAGE_BYTES) throw new Error("Images must be 8 MB or smaller.");
  const bytes = await readFile(full);
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  const png = bytes[0] === 0x89 && bytes[1] === 0x50;
  if (!jpeg && !png) throw new Error("Only JPEG and PNG images are supported.");
  return bytes.toString("base64");
}

async function main() {
  const { values } = parseArgs({
    options: {
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
      http: { type: "boolean", default: false },
      port: { type: "string" },
      host: { type: "string" },
    },
    strict: true,
  });
  if (values.help) return void console.error(HELP);
  if (values.version) return void console.error(VERSION);

  // On a host (PORT set) with no token, there is nothing for stdio to do: serve the gateway.
  // The gateway never needs a token; every client sends its own.
  const hosted = !process.env.CEPTORY_TOKEN?.trim() && Boolean(process.env.PORT) && !process.stdin.isTTY;
  if (values.http || hosted) {
    const { serveGateway } = await import("./gateway.js");
    const port = Number(values.port ?? process.env.PORT ?? 3333);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`Invalid port: ${values.port ?? process.env.PORT}`);
    serveGateway({
      port,
      host: values.host ?? process.env.HOST ?? "0.0.0.0",
      upstream: new URL(process.env.CEPTORY_MCP_URL?.trim() || DEFAULT_URL),
      version: VERSION,
    });
    return;
  }

  const token = process.env.CEPTORY_TOKEN?.trim();
  if (!token) {
    console.error("CEPTORY_TOKEN is not set. Create an MCP token at https://www.ceptory.com/dashboard/mcp and add it to this server's env.");
    process.exit(1);
  }
  const endpoint = new URL(process.env.CEPTORY_MCP_URL?.trim() || DEFAULT_URL);

  let remote: Client | null = null;
  let connecting: Promise<Client> | null = null;
  async function ceptory(): Promise<Client> {
    if (remote) return remote;
    connecting ??= (async () => {
      const client = new Client({ name: "ceptory-mcp", version: VERSION });
      const transport = new StreamableHTTPClientTransport(endpoint, {
        requestInit: { headers: { Authorization: `Bearer ${token}`, "User-Agent": `ceptory-mcp/${VERSION}` } },
      });
      await client.connect(transport);
      remote = client;
      return client;
    })().catch((error) => {
      connecting = null;
      throw error;
    });
    return connecting;
  }

  async function remoteCall(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    return (await (await ceptory()).callTool({ name, arguments: args })) as CallToolResult;
  }

  async function uploadVideoFile(args: Record<string, unknown>): Promise<CallToolResult> {
    const chatId = String(args.chat_id ?? "");
    const full = resolve(String(args.path ?? ""));
    const info = await stat(full).catch(() => null);
    if (!info?.isFile()) return fail(`File not found: ${full}`);
    if (info.size > MAX_VIDEO_BYTES) return fail("Videos must be 2 GB or smaller.");
    const mimeType = VIDEO_TYPES[extname(full).toLowerCase()];
    if (!mimeType) return fail(`Unsupported video type: ${extname(full) || "(none)"}. Use ${Object.keys(VIDEO_TYPES).join(", ")}.`);
    const fileName = basename(full);

    const presign = await remoteCall("create_upload_url", { chat_id: chatId, file_name: fileName, mime_type: mimeType, file_size_bytes: info.size });
    if (presign.isError) return presign;
    let target: { presignedUrl?: string; storageKey?: string };
    try {
      target = JSON.parse(firstText(presign));
    } catch {
      return fail("Ceptory returned an unexpected upload response.");
    }
    if (!target.presignedUrl || !target.storageKey) return fail("Ceptory did not return an upload URL.");

    console.error(`[ceptory-mcp] uploading ${fileName} (${(info.size / 1e6).toFixed(1)} MB)…`);
    const put = await fetch(target.presignedUrl, {
      method: "PUT",
      headers: { "Content-Type": mimeType, "Content-Length": String(info.size) },
      body: Readable.toWeb(createReadStream(full)) as ReadableStream,
      // Required by Node's fetch for a streamed body.
      duplex: "half",
    } as RequestInit).catch((error: unknown) => ({ ok: false, status: 0, statusText: String(error) }) as Response);
    if (!put.ok) return fail(`Upload failed (${put.status} ${put.statusText}).`);

    const durationSec = typeof args.duration_sec === "number" ? args.duration_sec : undefined;
    return remoteCall("complete_upload", {
      chat_id: chatId,
      storage_key: target.storageKey,
      file_name: fileName,
      mime_type: mimeType,
      file_size_bytes: info.size,
      ...(durationSec ? { duration_sec: durationSec } : {}),
    });
  }

  serveStdio(
    async () => {
      const client = await ceptory().catch((error) => {
        console.error("[ceptory-mcp] could not connect to Ceptory:", error instanceof Error ? error.message : error);
        return null;
      });
      const server = new Server(
        { name: "ceptory", version: VERSION },
        { capabilities: { tools: {} }, instructions: client?.getInstructions() },
      );

      server.setRequestHandler("tools/list", async () => {
        try {
          const { tools } = await (await ceptory()).listTools();
          return { tools: [...tools.map(withImagePath), UPLOAD_TOOL] };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(
            `Could not reach Ceptory at ${endpoint.origin} (${message}). Check CEPTORY_TOKEN: create a new token at https://www.ceptory.com/dashboard/mcp if it was revoked or expired.`,
          );
        }
      });

      server.setRequestHandler("tools/call", async (request) => {
        const { name } = request.params;
        const args = { ...(request.params.arguments ?? {}) } as Record<string, unknown>;
        try {
          if (name === UPLOAD_TOOL.name) return await uploadVideoFile(args);
          if (typeof args.image_path === "string" && args.image_path) {
            args.image_base64 = await readImage(args.image_path);
          }
          delete args.image_path;
          return await remoteCall(name, args);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/401|unauthori[sz]ed|POSTing to endpoint/i.test(message)) {
            return fail("Ceptory rejected the token. Create a new one at https://www.ceptory.com/dashboard/mcp and update CEPTORY_TOKEN.");
          }
          return fail(message);
        }
      });

      return server;
    },
    { onerror: (error) => console.error("[ceptory-mcp]", error) },
  );
  console.error(`ceptory-mcp ${VERSION} running on stdio → ${endpoint.origin}${endpoint.pathname}`);
}

main().catch((error) => {
  console.error("[ceptory-mcp] fatal:", error);
  process.exit(1);
});
