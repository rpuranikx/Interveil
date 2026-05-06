# Interveil

Language-agnostic AI agent observability — trace, inspect, and control any agent in real time.

## Quick Start

```bash
npm install -g interveil
interveil serve
# → Interveil running at http://localhost:3000
```

Then open http://localhost:3000 to see the live trace viewer.

---

## TypeScript SDK

```bash
npm install interveil
```

### One-liner wrapper

```typescript
import { trace } from 'interveil'

const agent = trace(yourExistingAgent, {
  sessionName: 'my-run',
  verbose: true,
  blockedPatterns: ['DROP TABLE'],  // extra patterns on top of the default blocklist
})

// Use exactly like the original — every method call is traced automatically
const result = await agent.chat('What is the weather in Paris?')
agent.end()   // marks the session as completed
```

### Manual event API

```typescript
import { InterveillClient } from 'interveil'

const client = new InterveillClient({ port: 3000 })
const session = await client.startSession({ name: 'my-run' })

await client.emit({
  session_id: session.session_id,
  step_index: 0,
  step_type: 'REASONING',
  input: { prompt: 'What should I do next?' },
  output: { thought: 'Check the database first' },
  timestamp: new Date().toISOString(),
  duration_ms: 45,
})

await client.endSession(session.session_id, 'completed')
```

### `trace()` options

```typescript
interface TraceOptions {
  port?: number             // default: 3000
  host?: string             // default: 'localhost'
  sessionName?: string      // label shown in the UI
  agentId?: string          // identifier used in policy rules
  verbose?: boolean         // log each step to console
  dryRun?: boolean          // record but never execute any method
  blockedPatterns?: string[] // extra patterns added to the default blocklist
  commandConfig?: { block?, whitelist?, requireApproval? }
  policyFile?: string       // path to a YAML policy file
}
```

### SQLite persistence (programmatic)

By default the server uses an in-memory store (data is lost on restart).
Pass `dbPath` to `startServer()` to persist everything to a SQLite file:

```typescript
import { startServer } from 'interveil'

await startServer({ port: 3000, dbPath: './interveil.db' })
```

### Swapping the store backend

```typescript
import { setStore, SqliteStore, MemoryStore } from 'interveil'

// Use SQLite
setStore(new SqliteStore('./runs.db'))

// Revert to in-memory (e.g. in tests)
setStore(new MemoryStore())
```

---

## Python SDK

Copy the `python/interveil/` directory into your project (no PyPI package yet):

```bash
cp -r /path/to/interveil/python/interveil ./interveil
# Optional: pip install requests  # faster than urllib fallback
# Optional: pip install aiohttp   # for async emit support
```

### One-liner wrapper — `trace()`

```python
from interveil import trace

agent = trace(
    MyAgent(),
    session_name="research-run-1",
    verbose=True,
    blocked_patterns=["DROP TABLE", "rm -rf"],  # added on top of the built-in blocklist
)

result = agent.run("What is the capital of France?")
agent.end()   # marks session as completed
```

Every method call on the wrapped agent is automatically:
1. **Deep-scanned** — all arguments (including nested objects and lists) are checked against the blocklist before execution.
2. **Traced** — a `TOOL_CALL` / `LLM_REQUEST` / `REASONING` event is emitted with the input, output, and duration.
3. **Streamable** — events appear live in the Interveil UI via WebSocket.

`trace()` raises `BlockedCommandError` if a dangerous pattern is found. Set `dry_run=True` to record calls without executing them.

### `trace()` options

| Parameter | Default | Description |
|-----------|---------|-------------|
| `host` | `'localhost'` | Interveil server host |
| `port` | `3000` | Interveil server port |
| `session_name` | current timestamp | Human-readable label |
| `agent_id` | `None` | Agent identifier for policy rules |
| `verbose` | `False` | Print step names to stderr |
| `dry_run` | `False` | Record but never execute |
| `blocked_patterns` | `[]` | Extra patterns (default blocklist always active) |

### Manual API

```python
from interveil import InterveillClient
from datetime import datetime, timezone

client = InterveillClient(port=3000)
session = client.start_session(name="my-python-agent-run")

client.emit(
    session_id=session["session_id"],
    step_index=0,
    step_type="REASONING",
    input={"prompt": "What should I do?"},
    output={"thought": "Check the database first"},
    timestamp=datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    duration_ms=45,
)

client.end_session(session["session_id"], "completed")
```

---

## Direct HTTP Integration (any language)

No SDK needed — make plain HTTP requests.

```bash
# Start a session
curl -X POST http://localhost:3000/api/v1/sessions \
  -H "Content-Type: application/json" \
  -d '{"session_id": "abc-123", "name": "my-run"}'

# Send an event
curl -X POST http://localhost:3000/api/v1/events \
  -H "Content-Type: application/json" \
  -d '{
    "session_id": "abc-123",
    "step_index": 0,
    "step_type": "TOOL_CALL",
    "input": {"tool": "search", "query": "latest AI news"},
    "output": {"results": ["..."]},
    "timestamp": "2025-04-27T14:32:01.123Z",
    "duration_ms": 340
  }'

# Health check
curl http://localhost:3000/api/v1/health
```

---

## CLI

```bash
interveil serve                          # In-memory store on port 3000
interveil serve --port 4000              # Custom port
interveil serve --verbose                # Log every event to console
interveil serve --db ./interveil.db      # Persist to SQLite (survives restarts)
interveil serve --policy-file policy.yaml  # Load YAML policy rules at startup
interveil serve --mcp-server http://localhost:8080   # Enable MCP proxy
interveil serve --allowed-origins https://app.com    # Restrict CORS
```

### SQLite storage

```bash
# Start with persistent storage
interveil serve --db ./runs.db

# All sessions and events survive server restarts.
# WAL mode is enabled for concurrent read performance.
```

---

## Blocklist — deep object scanning

The command blocklist checks **all arguments**, including deeply nested objects and arrays.
A call like `agent.query({ sql: "DROP TABLE users" })` is caught just like a plain string.

Built-in blocked patterns include:
- `rm -rf`, `sudo rm`, `rm --recursive`
- `DROP TABLE`, `DROP DATABASE`, `TRUNCATE`
- `curl | bash`, `wget | bash`
- `/etc/passwd`, `/etc/shadow`, `/.ssh/`

Add extra patterns via `blockedPatterns` (TS) or `blocked_patterns` (Python).

---

## Step Types

| Type | Color | Meaning |
|------|-------|---------|
| `REASONING` | Blue | Internal agent thought / chain-of-thought |
| `TOOL_CALL` | Orange | Agent invoking a tool |
| `TOOL_RESULT` | Green | Result returned from a tool |
| `LLM_REQUEST` | Purple | Full prompt sent to a language model |
| `LLM_RESPONSE` | Teal | Full response from a language model |
| `COMMAND_BLOCKED` | Red | Call blocked by the command blocklist |
| `COMMAND_DRY_RUN` | Gray | Dry-run recording (call not executed) |
| `ERROR` | Red | Exception or failure |
| `CUSTOM` | Gray | Any custom event |

---

## Gateway (LLM Proxy)

Point your IDE at Interveil instead of directly at OpenAI:

- **Cursor**: Settings → Models → Base URL → `http://localhost:3000/v1/proxy`
- **Continue.dev**: `config.json` → `"apiBase": "http://localhost:3000/v1/proxy"`
- **Any OpenAI-compatible tool**: Set base URL to `http://localhost:3000/v1/proxy`

Interveil intercepts every request, logs it as a trace event, forwards it to the real provider, and returns the response unchanged. Your API key is never stored.

---

## Docker

```bash
docker-compose up
# → Interveil running at http://localhost:3000
```

To persist data add a volume:

```yaml
# docker-compose.yml
services:
  interveil:
    volumes:
      - ./data:/data
    command: ["node", "dist/cli.js", "serve", "--db", "/data/interveil.db"]
```

---

## API Reference

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/sessions` | Register a new session |
| `PATCH` | `/api/v1/sessions/:id` | Update session status |
| `GET` | `/api/v1/sessions` | List all sessions |
| `GET` | `/api/v1/sessions/:id/events` | Get events for a session |
| `POST` | `/api/v1/events` | Ingest a trace event |
| `GET` | `/api/v1/health` | Health check |
| `GET` | `/api/v1/graph` | Multi-agent orchestration graph |
| `POST` | `/v1/proxy/chat/completions` | LLM Gateway proxy |
| `GET` | `/v1/proxy/models` | Available models |
| `POST` | `/v1/mcp` | MCP tool proxy |
| `WS` | `/ws` | Live stream of all events |

---

## License

MIT
