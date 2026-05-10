# Running & Testing Interveil

Interveil is a developer-first observability server for AI agents. This guide explains how to install, run, and test the project locally on Windows.

---

## 1. Prerequisites

- **Node.js** v20+ (v24 recommended)
- **pnpm** package manager

```bash
# Install pnpm if you don't have it
npm install -g pnpm
```

---

## 2. Installation

```bash
# Install all workspace dependencies
pnpm install

# Build the project
pnpm run build
```

> **Note:** If the build fails on `better-sqlite3`, that's OK — the server will automatically fall back to in-memory storage. Traces won't persist across restarts, but everything else works perfectly.

---

## 3. Running Agent Scripts (Unified `run` Command)

The `run` command starts the Interveil server in the background, executes your script, and shuts everything down when it finishes.

```bash
node interveil/dist/cli.js run pnpm dlx tsx interveil/examples/typescript/basic-agent.ts
```

**What happens:**
1. The Interveil server starts on `http://localhost:3000`
2. Your agent script executes with output piped to your terminal
3. Open **http://localhost:3000** in Chrome to see the real-time trace UI
4. When the script finishes, the server shuts down automatically

---

## 4. Running the Server Standalone

If you want to keep the server running (e.g. for IDE proxy mode), use `serve`:

```bash
node interveil/dist/cli.js serve
```

The server will stay running at **http://localhost:3000** until you press `Ctrl+C`.

---

## 5. IDE Agent Proxy Mode (Cursor, Cline, RooCode)

Interveil can act as a transparent proxy for your IDE's AI assistant, letting you see exactly what prompts and tools it uses behind the scenes.

**Step 1:** Start the Interveil server:
```bash
node interveil/dist/cli.js serve
```

**Step 2:** In your IDE agent's API settings, configure:
- **API Provider:** OpenAI (Compatible)
- **Base URL:** `http://localhost:3000/v1/proxy`
- **API Key:** Your actual API key (OpenAI/Anthropic/Gemini) — Interveil forwards it securely
- **Model:** Whatever model you normally use (e.g. `gpt-4o`, `claude-sonnet-4-20250514`)

**Step 3:** Open **http://localhost:3000** in Chrome.

All IDE agent requests will appear as a single daily session (e.g. `IDE Session — 2026-05-09`) with a complete timeline of every prompt, response, and tool call.

---

## CLI Reference

| Command | Description |
|---------|-------------|
| `node interveil/dist/cli.js serve` | Start the server standalone |
| `node interveil/dist/cli.js serve --db memory` | Start with in-memory storage (no SQLite) |
| `node interveil/dist/cli.js serve -p 4000` | Start on a custom port |
| `node interveil/dist/cli.js run <cmd>` | Start server + run a command, then shut down |
| `node interveil/dist/cli.js run --db memory <cmd>` | Same as above, explicitly in-memory |
