# Interveil — May 2026 Product Status Document

**Author:** Rishi Puranik  
**Date:** May 9, 2026  
**Version:** 0.1.0  
**Reference:** [Original PRD](./Interveil_PRD.md)

---

## Executive Summary

Interveil is a language-agnostic AI agent observability platform that gives engineering teams complete visibility into what AI agents think, do, and access. It captures execution traces, intercepts dangerous commands, proxies LLM traffic, and enforces governance policies — all through a single local server.

This document reflects the current state of the platform as of May 2026, mapping progress against the original PRD vision.

---

## Current Architecture

```
interveil/
├── src/
│   ├── cli.ts                 # CLI: serve, run
│   ├── server.ts              # Express + WebSocket server
│   ├── api/                   # REST endpoints (events, sessions, health)
│   ├── sdk/                   # trace() proxy wrapper + client
│   ├── store/                 # In-memory + SQLite stores
│   ├── gateway/               # LLM proxy (OpenAI/Anthropic/Gemini)
│   ├── commands/              # Command blocklist + interceptor
│   ├── tools/                 # Tool registry + access control
│   ├── policy/                # YAML policy engine
│   ├── sidecar/               # Anomaly detection
│   ├── multiagent/            # Orchestration graph
│   ├── teams/                 # Auth + collaboration
│   ├── integrations/          # LangChain, Anthropic SDK, OpenAI adapters
│   └── ui/                    # React trace viewer + dashboard
├── python/                    # Python SDK
├── examples/                  # TypeScript + Python examples
└── config/                    # Blocklist definitions
```

---

## Phase Status

### ✅ Phase 0 — DevTools MVP (COMPLETE)
Core observability foundation. Ship and run locally.

| Feature | Status | Notes |
|---------|--------|-------|
| HTTP trace ingestion API | ✅ Done | `POST /api/v1/events`, `POST /api/v1/sessions` |
| WebSocket live streaming | ✅ Done | Real-time broadcast to all connected clients |
| React trace viewer UI | ✅ Done | Timeline view with step-level inspection |
| CLI (`interveil serve`) | ✅ Done | Port config, verbose mode, policy file loading |
| CLI (`interveil run`) | ✅ Done | Unified command: starts server + runs user script + keeps server alive |
| `trace()` SDK wrapper | ✅ Done | Transparent proxy — zero refactoring required |
| Python SDK | ✅ Done | Sync + async `InterveillClient` |
| TypeScript SDK | ✅ Done | `InterveillClient` class + `trace()` helper |
| In-memory store | ✅ Done | Default for development |
| SQLite persistent store | ✅ Done | Auto-creates `~/.interveil/traces.db`, graceful fallback if native bindings unavailable |
| Docker support | ✅ Done | Dockerfile + docker-compose with volume mount |
| npm publish prep | ✅ Done | `bin`, `files`, `main`, `types` configured in package.json |

---

### ✅ Phase 1.5 — LLM Gateway (COMPLETE)
Universal proxy that intercepts and logs all LLM traffic.

| Feature | Status | Notes |
|---------|--------|-------|
| OpenAI-compatible proxy | ✅ Done | `POST /v1/proxy/chat/completions` |
| Anthropic translation layer | ✅ Done | Automatic request/response format translation |
| Gemini translation layer | ✅ Done | Maps to Google's generateContent API |
| SSE streaming proxy | ✅ Done | Transparent streaming passthrough with trace capture |
| API key forwarding | ✅ Done | Keys passed via `Authorization` header or env vars |
| Token & latency tracking | ✅ Done | Captured per-request in trace events |
| IDE rolling sessions | ✅ Done | Requests without session headers grouped by day (`ide-proxy-YYYY-MM-DD`) |
| Model listing | ✅ Done | `GET /v1/proxy/models` returns static catalog |
| MCP proxy | ✅ Done | `POST /v1/mcp` for Model Context Protocol |

---

### ✅ Phase 2 — Command Control (COMPLETE)
Prevent agents from executing dangerous operations.

| Feature | Status | Notes |
|---------|--------|-------|
| Default blocklist | ✅ Done | `rm -rf`, `FORMAT`, `DROP TABLE`, etc. |
| Custom blocklist support | ✅ Done | User-defined patterns in `config/blocklist.json` |
| `safeSpawn()` interceptor | ✅ Done | Wraps child_process with pre-execution validation |
| Dry-run mode | ✅ Done | Log blocked commands without executing |
| Webhook alerts | ✅ Done | Notify external systems on blocked commands |

---

### ✅ Phase 3 — Tool Registry (COMPLETE)
Controlled tool execution with fine-grained access policies.

| Feature | Status | Notes |
|---------|--------|-------|
| `registerTool()` | ✅ Done | Central registry for all agent-accessible tools |
| `definePolicy()` | ✅ Done | Per-tool access control rules |
| `callTool()` | ✅ Done | Policy-enforced tool execution |
| Argument validation | ✅ Done | Zod-based schema validation |
| Rate limiting | ✅ Done | Per-IP limits on API and gateway endpoints |

---

### ✅ Phase 5 — Sidecar Monitor (COMPLETE)

| Feature | Status | Notes |
|---------|--------|-------|
| Anomaly detection | ✅ Done | Detects unusual patterns in agent behavior |
| Failure explanation | ✅ Done | Generates human-readable failure summaries |

---

### ✅ Phase 6 — Policy as Code (COMPLETE)

| Feature | Status | Notes |
|---------|--------|-------|
| YAML policy loader | ✅ Done | `--policy-file` CLI flag |
| Policy evaluator | ✅ Done | Rules evaluated against every agent action |

---

### ✅ Phase 7 — Multi-Agent Orchestration (COMPLETE)

| Feature | Status | Notes |
|---------|--------|-------|
| Agent dependency graph | ✅ Done | `GET /api/v1/graph` |
| Context propagation | ✅ Done | Parent-child session linking |

---

### ✅ Phase 8 — Teams & Collaboration (COMPLETE)

| Feature | Status | Notes |
|---------|--------|-------|
| Local user auth (JWT) | ✅ Done | Basic auth for local deployments |
| Trace step comments | ✅ Done | Annotate specific trace steps |
| @mentions | ✅ Done | Tag team members on trace events |

---

### ✅ Phase 9 — Framework Integrations (COMPLETE)

| Feature | Status | Notes |
|---------|--------|-------|
| LangChain adapter | ✅ Done | `InterveillCallbackHandler` |
| Anthropic SDK adapter | ✅ Done | `createTracedAnthropic()` |
| OpenAI Agents adapter | ✅ Done | `tracedRunner` |

---

### ✅ Phase 1.75 — VSCode Extension (COMPLETE)

| Feature | Status | Notes |
|---------|--------|-------|
| Activity Bar panel | ✅ Done | Embeds Interveil UI in VSCode |
| Auto-detect server | ✅ Done | Polls ports 3000–3010 |
| Offline state | ✅ Done | Graceful display when server not running |
| Marketplace metadata | ✅ Done | Publisher, icon, repository fields configured |

---

## What Was Done This Session (May 9, 2026)

### Production Hardening
1. **Dereplited the project** — Removed all Replit-specific files (`.replit`, `.replitignore`, Replit vite plugins, platform-specific binary exclusions, Unix-only preinstall scripts)
2. **Windows compatibility** — Fixed `pnpm-workspace.yaml` to allow Windows native binaries, added `onlyBuiltDependencies` for pnpm v11
3. **Graceful SQLite fallback** — Server auto-detects missing native bindings and falls back to in-memory store with a clear warning instead of crashing
4. **Workspace fix** — Added `interveil` and `interveil-vscode` to the pnpm workspace packages list (they were disconnected by Replit)
5. **TypeScript fixes** — Resolved 8+ type errors caused by conflicting `@types/express` versions after workspace linking

### New Features
6. **`interveil run` command** — Unified CLI that starts the server, runs the user's script, and keeps the server alive for trace inspection
7. **IDE Rolling Sessions** — LLM Gateway now groups headerless proxy requests into daily sessions (`ide-proxy-YYYY-MM-DD`) for clean IDE agent tracing
8. **Dashboard page** — Created `dashboard.html` as a proof-of-concept landing page for GitHub Pages

### Documentation
9. **RUN.md** — Step-by-step local testing instructions with verified commands
10. **structure_reference.md** — Preserved Replit's architecture documentation for reference
11. **MAY_PRD.md** — This document

---

## What's Next

### 🔄 In Progress
| Item | Priority | Description |
|------|----------|-------------|
| Replay Debugger | High | Step through agent traces like a traditional debugger — rewind, inspect, replay |
| SDK Graceful Degradation | High | `trace()` should fail silently if server is down instead of crashing the user's app |

### 📋 Planned
| Item | Priority | Description |
|------|----------|-------------|
| PostgreSQL adapter | Medium | Drizzle ORM migration for enterprise/remote persistence |
| npm publish | Medium | Publish `interveil` package to npm registry |
| VSCode Marketplace | Medium | Package and publish the extension |
| Semantic Truth Layer | Medium | Deterministic business logic definitions to prevent hallucinated metrics |
| Cost governance dashboard | Low | Token spend attribution across agents and teams |
| Agent QA & Simulation | Low | Automated regression tests, prompt injection simulation |
| Enterprise RBAC | Low | Multi-tenant identity, SSO, SOC 2 audit export |
| GitHub Pages deployment | Low | Host `dashboard.html` as the public project site |

---

## How to Run

See [RUN.md](./RUN.md) for full instructions. Quick start:

```bash
pnpm install
pnpm run build
node interveil/dist/cli.js run pnpm dlx tsx interveil/examples/typescript/basic-agent.ts
# Open http://localhost:3000 in your browser
```
