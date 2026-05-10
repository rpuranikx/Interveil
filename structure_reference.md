# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.

---

## Interveil Package (`/interveil`)

Standalone npm package — **language-agnostic AI agent observability server**.

### Package Structure

```
interveil/
├── src/
│   ├── index.ts              # Main exports (all phases)
│   ├── server.ts             # Express + WebSocket server
│   ├── cli.ts                # CLI binary (interveil serve)
│   ├── api/                  # HTTP route handlers
│   │   ├── events.ts         # POST /api/v1/events
│   │   ├── sessions.ts       # POST/PATCH/GET /api/v1/sessions
│   │   ├── health.ts         # GET /api/v1/health
│   │   └── orchestration-routes.ts  # Graph, comments, auth
│   ├── sdk/
│   │   ├── trace.ts          # trace() Proxy wrapper
│   │   └── client.ts         # InterveillClient class
│   ├── store/
│   │   └── memory.ts         # In-memory TraceStore (Phase 1, swappable for SQLite Phase 4)
│   ├── ws/
│   │   └── broadcaster.ts    # WebSocket broadcast
│   ├── gateway/              # Phase 1.5 — LLM + MCP proxy
│   │   ├── llm-proxy.ts      # POST /v1/proxy/chat/completions
│   │   ├── mcp-proxy.ts      # POST /v1/mcp
│   │   ├── streaming.ts      # SSE streaming proxy
│   │   ├── auth.ts           # API key passthrough/stored
│   │   ├── models.ts         # GET /v1/proxy/models
│   │   └── providers/        # OpenAI, Anthropic, Gemini translators
│   ├── commands/             # Phase 2 — Command Control
│   │   ├── blocklist.ts      # Default + user blocklist matching
│   │   └── interceptor.ts    # safeSpawn(), dry-run, webhooks
│   ├── tools/                # Phase 3 — Tool Registry + Access Control
│   │   └── registry.ts       # registerTool(), definePolicy(), callTool()
│   ├── policy/               # Phase 6 — Policy as Code
│   │   └── engine.ts         # YAML policy loader + evaluator
│   ├── sidecar/              # Phase 5 — Sidecar Monitor
│   │   └── monitor.ts        # Anomaly detection, failure explanation
│   ├── multiagent/           # Phase 7 — Multi-Agent Orchestration
│   │   └── orchestration.ts  # Agent graph, context propagation
│   ├── teams/                # Phase 8 — Teams + Collaboration
│   │   ├── auth.ts           # User auth (local, JWT)
│   │   └── comments.ts       # Trace step comments + @mentions
│   ├── integrations/         # Phase 9 — Framework SDKs
│   │   ├── langchain.ts      # InterveillCallbackHandler
│   │   ├── anthropic-sdk.ts  # createTracedAnthropic()
│   │   └── openai-agents.ts  # tracedRunner
│   └── ui/                   # React/Vite trace viewer UI
├── python/interveil/         # Python SDK
│   ├── __init__.py
│   └── client.py             # InterveillClient (sync + async)
├── examples/
│   ├── typescript/basic-agent.ts
│   └── python/basic_agent.py
├── config/
│   └── blocklist.json        # Default dangerous command patterns
├── Dockerfile
├── docker-compose.yml
└── README.md
```

### Build Commands (from `interveil/`)

```bash
npm install
npm run build          # Compile TypeScript + build React UI
npm run build:server   # TypeScript only
npm run build:ui       # React/Vite UI only
```

### CLI

```bash
node dist/cli.js serve                    # Start on port 3000
node dist/cli.js serve --port 4000        # Custom port
node dist/cli.js serve --verbose          # Log every event
node dist/cli.js serve --mcp-server URL   # Enable MCP proxy
```

### API Endpoints

- `POST /api/v1/events` — ingest trace event
- `POST /api/v1/sessions` — register session
- `PATCH /api/v1/sessions/:id` — update session status
- `GET /api/v1/health` — health check
- `GET /api/v1/sessions` — list sessions
- `GET /api/v1/sessions/:id/events` — get events for session
- `GET /api/v1/graph` — multi-agent orchestration graph
- `POST /v1/proxy/chat/completions` — LLM Gateway proxy
- `GET /v1/proxy/models` — static model list
- `POST /v1/mcp` — MCP tool proxy
- `WS /ws` — WebSocket live stream

### Phase Map

| Phase | Status | Feature |
|-------|--------|---------|
| 1 | ✅ | Core observability (HTTP server, WebSocket, in-memory store, React UI) |
| 1.1 | ✅ | Docker + npm publish prep |
| 1.5 | ✅ | LLM Gateway (OpenAI-compat proxy) + MCP proxy |
| 1.75 | ✅ | VSCode extension (`/interveil-vscode`) |
| 2 | ✅ | Command control (blocklist, dry-run, webhooks) |
| 3 | ✅ | Tool registry + access control policies |
| 4 | ✅ | Memory/storage interface (in-memory, ready for SQLite swap) |
| 5 | ✅ | Sidecar monitor (anomaly detection, failure explanation) |
| 6 | ✅ | Policy as Code (YAML policy files) |
| 7 | ✅ | Multi-agent orchestration graph |
| 8 | ✅ | Teams (user auth, trace comments, @mentions) |
| 9 | ✅ | Framework integrations (LangChain, Anthropic SDK, OpenAI Agents) |

### VSCode Extension (`/interveil-vscode`)

Code-only, ready to package with `npx @vscode/vsce package`.
- Embeds Interveil UI in VSCode Activity Bar panel
- Auto-detects running server on ports 3000–3010
- Polls for server startup, shows offline state gracefully
