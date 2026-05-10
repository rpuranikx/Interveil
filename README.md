# Interveil

**The Infrastructure Layer for AI Agent Observability & Governance**

Interveil is a developer-first platform designed to turn the "black box" of AI agents into a transparent, auditable, and secure infrastructure. It provides real-time execution tracing, LLM gateway proxying, and policy-driven command control.

---

## 🚀 Key Features

### 📡 Real-Time Observability
- **Execution Timeline:** Visualize every reasoning step, tool call, and model interaction in a live dashboard.
- **Trace Inspection:** Deep-dive into prompts, responses, token usage, and latency for every step.
- **Live Streaming:** Watch agent execution in real-time via WebSocket-powered updates.

### 🔀 Universal LLM Gateway
- **Drop-in Proxy:** OpenAI-compatible endpoint that transparently routes and logs traffic for OpenAI, Anthropic, and Gemini.
- **IDE Integration:** Point your IDE agents (Cursor, Cline, etc.) at Interveil to see exactly what prompts they are sending.
- **Automatic Sessioning:** Group fragmented IDE requests into daily logical sessions.

### 🛡️ Governance & Control
- **Command Blocklist:** Intercept and block dangerous shell commands (e.g., `rm -rf`, `DROP TABLE`) before they execute.
- **Tool Registry:** Centralized management of agent-accessible tools with fine-grained access policies.
- **Policy as Code:** Define security and governance rules in version-controlled YAML files.

---

## 🛠️ Quick Start

### 1. Installation
```bash
pnpm install
pnpm run build
```

### 2. Run an Agent with Tracing
Start the Interveil server and run your agent script in one command:
```bash
node interveil/dist/cli.js run pnpm dlx tsx interveil/examples/typescript/basic-agent.ts
```
*The server will stay alive after the script finishes so you can browse the traces.*

### 3. View the Dashboard
Open your browser to:
**[http://localhost:3000](http://localhost:3000)**

---

## 🧩 Architecture

Interveil is built as a language-agnostic observability server that sits between your agent and the LLM/Infrastructure.

- **Server:** Express.js + WebSocket
- **Store:** In-Memory (Dev) / SQLite (Persistent)
- **UI:** React-based Trace Viewer
- **SDKs:** TypeScript & Python

---

## 📈 Roadmap

- [x] **Phase 1: Core Observability** (Tracing, WebSocket, UI)
- [x] **Phase 1.5: LLM Gateway** (Multi-provider proxy, streaming)
- [x] **Phase 2: Command Control** (Blocklist, Interception)
- [x] **Phase 3: Tool Registry** (Policy enforcement)
- [ ] **Phase 4: Replay Debugger** (Step through traces like a traditional debugger)
- [ ] **Phase 5: Enterprise Persistence** (PostgreSQL support)

---

## 👤 Author

**Rishi Puranik**  
*Solutions Engineer & AI Infrastructure Builder*

---

## 📄 License
MIT
