# Interveil

**The Infrastructure Layer for AI Agent Observability & Governance**

Interveil is a developer-first platform that turns the "black box" of AI agents into transparent, auditable, and secure infrastructure. It provides real-time execution tracing, multi-provider LLM gateway proxying, policy-driven command control, tool access governance, and multi-agent orchestration.

---

## 🚀 Key Features

### 📡 Real-Time Observability
- **Execution Timeline:** Visualize every reasoning step, tool call, and model interaction in a live dashboard.
- **Trace Inspection:** Deep-dive into prompts, responses, token usage, and latency for every step.
- **Live Streaming:** Watch agent execution in real-time via WebSocket-powered updates.

### 🔀 Universal LLM Gateway
- **Multi-Provider Proxy:** OpenAI-compatible endpoint that transparently routes and logs traffic for OpenAI, Anthropic, and Gemini, with real request/response translation (not just pass-through) for each.
- **Streaming:** Full SSE streaming support for OpenAI and Anthropic; Gemini currently falls back to non-streaming.
- **MCP Proxy:** Forwards JSON-RPC to configured MCP servers and logs tool calls/results as trace events.
- **IDE Integration:** Point your IDE agents (Cursor, Cline, etc.) at Interveil to see exactly what prompts they're sending.
- **Automatic Sessioning:** Groups fragmented IDE requests into daily logical sessions.

### 🛡️ Governance & Control
- **Command Blocklist:** Intercepts and blocks dangerous shell commands (e.g. `rm -rf`, `DROP TABLE`) *before* they execute — not just logging after the fact.
- **Tool Registry & Access Control:** Centralized management of agent-accessible tools with fine-grained, per-agent policies (deny/allow rules, input conditions: `mustEqual`, `mustContain`, `mustMatch`, `mustBeOneOf`, and more).
- **Policy as Code:** Security and governance rules defined in version-controlled YAML, enforced at runtime.
- **Dry-Run Mode:** Simulate agent execution without side effects.
- **Webhook Notifications:** Real-time alerts on policy violations.

### 🧭 Multi-Agent Orchestration & Teams
- **Sidecar Monitor:** Out-of-process supervision of running agents.
- **Multi-Agent Orchestration:** Coordinate and govern multiple agents under shared policy.
- **Teams:** Auth and commenting for collaborative review of agent traces.

### 🔌 Framework Integrations
- Native integrations for **LangChain**, the **Anthropic SDK**, and **OpenAI Agents** — Interveil can wrap agents built on any of these frameworks with zero changes to their internals.

---

## 🛠️ Quick Start

### 1. Installation
```
pnpm install
pnpm run build
```

### 2. Run an Agent with Tracing
Start the Interveil server and run your agent script in one command:
```
node interveil/dist/cli.js run pnpm dlx tsx interveil/examples/typescript/basic-agent.ts
```
*The server will stay alive after the script finishes so you can browse the traces.*

### 3. View the Dashboard
Open your browser to: **http://localhost:3000**

---

## 🧩 Architecture

Interveil is built as a language-agnostic observability server that sits between your agent and the LLM/infrastructure it calls.

- **Server:** Express.js + WebSocket
- **Store:** In-Memory (dev) / SQLite via `better-sqlite3` (persistent, WAL mode, auto-migration) — swappable at runtime, with graceful fallback if native bindings are unavailable.
- **UI:** React-based Trace Viewer (7 components, live WebSocket updates, gateway stats)
- **SDKs:** TypeScript (full feature set) & Python (core tracing + blocklist; policy/tool-registry/sidecar features are TypeScript-only for now)

**Scope:** ~3,100 LOC across 35 core server files, plus dedicated modules for sidecar monitoring, orchestration, team auth/comments, and the three framework integrations above.

---

## 📈 Roadmap

- [x] **Phase 1: Core Observability** (tracing, WebSocket, UI)
- [x] **Phase 1.5: LLM Gateway** (multi-provider proxy, streaming, MCP proxy)
- [x] **Phase 2: Command Control** (blocklist, interception, dry-run, webhooks)
- [x] **Phase 3: Tool Registry** (policy-driven access control)
- [x] **Phase 5: Enterprise Persistence** (SQLite, WAL mode, runtime backend swap)
- [x] **Phase 6: Policy as Code** (YAML-defined governance rules)
- [x] **Phase 7: Sidecar Monitor**
- [x] **Phase 8: Multi-Agent Orchestration & Teams**
- [x] **Phase 9: Framework Integrations** (LangChain, Anthropic SDK, OpenAI Agents)
- [ ] **Phase 4: Replay Debugger** (step through traces like a traditional debugger)
- [ ] **Test coverage** (unit tests for blocklist, policy engine, and LLM translation layer)

**Known gaps, stated plainly:** Gemini streaming currently falls back to non-streaming. Python SDK doesn't yet have parity on policy/tool-registry/sidecar features. No automated test suite yet — in progress.

---

## 👤 Author

**Rishi Puranik**
*Solutions Engineer & AI Infrastructure Builder*

---

## 📄 License

MIT
