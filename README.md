# Ceptory MCP

Connect any MCP agent (Claude, Cursor, Codex, Gemini CLI, VS Code, Windsurf, the OpenAI Agents SDK, LangChain…) to [Ceptory](https://www.ceptory.com). In plain language, the agent can:

- set up camera workflows (PPE, person down, fire and hazards, intrusion, face access, loitering, unattended bags, crowd limits, illegal parking, rider helmets)
- change rules, schedules, zones and Discord alerts, and pause or resume cameras
- read, acknowledge and resolve alerts, with their photos
- group cameras into sites and follow people and vehicles across cameras
- upload video, search it in plain language, and ask questions about it
- run any single AI detection engine on an image

The agent acts as you. It uses your workspace, role and prepaid balance, with the same checks as the Ceptory dashboard.

## 1. Get a token

Go to **[ceptory.com/dashboard/mcp](https://www.ceptory.com/dashboard/mcp)** → *Create token*. The token starts with `cpd_` and is shown once. You can revoke it there at any time.

## 2. Connect your agent

The hosted endpoint is `https://mcp.ceptory.com/mcp`. It uses Streamable HTTP with MCP 2026-07-28, and 2025-era clients also work. Authenticate with `Authorization: Bearer <token>`.

**Claude Code**

```sh
claude mcp add --transport http ceptory https://www.ceptory.com/api/mcp \
  --header "Authorization: Bearer <token>"
```

**Claude Desktop**: add this to `claude_desktop_config.json`. It uses this package as a stdio bridge and needs Node.js 20 or later.

```json
{ "mcpServers": { "ceptory": { "command": "npx", "args": ["-y", "ceptory-mcp"], "env": { "CEPTORY_TOKEN": "<token>" } } } }
```

**Cursor**: add this to `~/.cursor/mcp.json`.

```json
{ "mcpServers": { "ceptory": { "url": "https://mcp.ceptory.com/mcp", "headers": { "Authorization": "Bearer <token>" } } } }
```

**VS Code**: add this to `.vscode/mcp.json`.

```json
{ "servers": { "ceptory": { "type": "http", "url": "https://mcp.ceptory.com/mcp", "headers": { "Authorization": "Bearer <token>" } } } }
```

**Codex**: add this to `~/.codex/config.toml`.

```toml
[mcp_servers.ceptory]
command = "npx"
args = ["-y", "ceptory-mcp"]
env = { CEPTORY_TOKEN = "<token>" }
```

**Gemini CLI**: add this to `~/.gemini/settings.json`.

```json
{ "mcpServers": { "ceptory": { "httpUrl": "https://mcp.ceptory.com/mcp", "headers": { "Authorization": "Bearer <token>" } } } }
```

**Anything else**: point any MCP client at the URL with the header, or run `CEPTORY_TOKEN=<token> npx -y ceptory-mcp` for stdio.

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
2. **An HTTP gateway** (`ceptory-mcp --http`). It runs a standalone `/mcp` endpoint, for example on Railway, and forwards to Ceptory. It holds no credentials: each client sends its own token. `GET /health` reports health.

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
