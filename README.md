# Ceptory MCP

Connect any MCP agent (Claude, Cursor, Codex, Gemini CLI, VS Code, Windsurf, the OpenAI Agents SDK, LangChain…) to [Ceptory](https://www.ceptory.com). In plain language, the agent can:

- set up camera workflows (PPE, person down, fire and hazards, intrusion, face access, loitering, unattended bags, crowd limits, illegal parking, rider helmets)
- change rules, schedules, zones and Discord alerts, and pause or resume cameras
- read, acknowledge and resolve alerts, with their photos
- group cameras into sites and follow people and vehicles across cameras
- upload video, search it in plain language, and ask questions about it
- run any single AI detection engine on an image

The agent acts as you. It uses your workspace, role and prepaid balance, with the same checks as the Ceptory dashboard.

## Connect

Give your agent one URL: **`https://mcp.ceptory.com/mcp`**

On first use, the agent opens Ceptory in your browser. Sign in if needed and click **Allow**, the same way you connect Ceptory Desktop. There's no key to copy. Every connected agent is listed at [ceptory.com/dashboard/mcp](https://www.ceptory.com/dashboard/mcp), where you can revoke it.

The server uses Streamable HTTP with MCP 2026-07-28, and 2025-era clients also work. It signs in with OAuth 2.1 and PKCE, which clients discover on their own through RFC 9728/8414 metadata and dynamic client registration.

**Claude Code**: run this, then type `/mcp` and choose Authenticate.

```sh
claude mcp add --transport http ceptory https://mcp.ceptory.com/mcp
```

**Claude Desktop and claude.ai**: Settings → Connectors → Add custom connector → `https://mcp.ceptory.com/mcp`.

**Cursor** (`~/.cursor/mcp.json`):

```json
{ "mcpServers": { "ceptory": { "url": "https://mcp.ceptory.com/mcp" } } }
```

**VS Code** (`.vscode/mcp.json`):

```json
{ "servers": { "ceptory": { "type": "http", "url": "https://mcp.ceptory.com/mcp" } } }
```

**Codex**:

```sh
codex mcp add ceptory --url https://mcp.ceptory.com/mcp && codex mcp login ceptory
```

**Gemini CLI** (`~/.gemini/settings.json`): add the config below, then run `/mcp auth ceptory`.

```json
{ "mcpServers": { "ceptory": { "httpUrl": "https://mcp.ceptory.com/mcp" } } }
```

**No browser sign-in?** Create a token at [ceptory.com/dashboard/mcp](https://www.ceptory.com/dashboard/mcp) and send it as `Authorization: Bearer <token>`. For stdio-only clients, run this package instead: `CEPTORY_TOKEN=<token> npx -y ceptory-mcp`.

Docs for LLMs are at [ceptory.com/mcp/llms.txt](https://www.ceptory.com/mcp/llms.txt).

## 3. Ask

- "Set up a camera called Loading dock that alerts our Discord when anyone isn't wearing a helmet and a hi-vis vest."
- "Watch the back fence for people or vehicles between 10pm and 6am India time."
- "Which cameras are offline? Show me today's open alerts with photos."
- "Group the gate and lobby cameras as North site and show me where people went in the last hour."
- "Make a chat called Night shift, upload ~/Downloads/gate.mp4, and tell me when a white van appears."

The full tool reference is at [ceptory.com/mcp](https://www.ceptory.com/mcp#tools).

## What this package does

The tools run on Ceptory. This package provides two things:

1. **A stdio bridge** (`ceptory-mcp`). It connects stdio-only clients to the hosted server. It also adds what only a local process can do:
   - `upload_video_file`: uploads a video from your computer (up to 2 GB) and starts indexing it.
   - `image_path`: tools that take an image accept a local JPEG or PNG path as well as base64.
2. **An HTTP gateway** (`ceptory-mcp --http`, which is what `npm start` runs). This is what serves `mcp.ceptory.com`. It forwards `/mcp` to Ceptory, publishes the OAuth protected-resource metadata, and redirects `/` and `/llms.txt` to the docs. It holds no credentials. `GET /health` reports health.

| Variable | Default | Used by |
| --- | --- | --- |
| `CEPTORY_TOKEN` | (none) | stdio bridge (required) |
| `CEPTORY_MCP_URL` | `https://www.ceptory.com/api/mcp` | both |
| `PORT` / `HOST` | `3333` / `0.0.0.0` | gateway |

## Develop

```sh
npm install
npm run build
npx @modelcontextprotocol/inspector --cli -e CEPTORY_TOKEN=cpd_… node build/index.js --method tools/list
npx @modelcontextprotocol/inspector --cli -e CEPTORY_TOKEN=cpd_… node build/index.js --protocol-era modern --method tools/list
```

Logs go to stderr. In stdio mode, stdout carries JSON-RPC only.

## License

MIT
