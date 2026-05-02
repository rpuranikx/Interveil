# Interveil

Language-agnostic AI agent observability — trace, inspect, and control any agent in real time.

## Quick Start

```bash
npm install -g interveil
interveil serve
# → Interveil running at http://localhost:3000
```

Then open http://localhost:3000 to see the live trace viewer.

## TypeScript SDK

```bash
npm install interveil
```

### One-liner wrapper

```typescript
import { trace } from 'interveil'

const tracedAgent = trace(yourExistingAgent, {
  sessionName: 'my-run',
  autoOpen: true,    // opens browser automatically on first event
  verbose: false,
})

// Use tracedAgent exactly like yourExistingAgent
// Every method call is automatically traced
const result = await tracedAgent.chat('What is the weather?')
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
  output: { thought: 'I should check the database first' },
  timestamp: new Date().toISOString(),
  duration_ms: 45,
})

await client.endSession(session.session_id, 'completed')
```

### Options

```typescript
interface TraceOptions {
  port?: number        // default: 3000
  host?: string        // default: 'localhost'
  autoOpen?: boolean   // default: true — opens browser tab on first event
  sessionName?: string // default: ISO timestamp
  agentId?: string
  verbose?: boolean    // default: false — logs each event to console
}
```

## Python SDK

Copy the `python/interveil/` directory into your project (no PyPI package yet):

```bash
cp -r /path/to/interveil/python/interveil ./interveil
# Optional: pip install requests  # faster than urllib fallback
# Optional: pip install aiohttp   # for async emit support
```

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

## CLI

```bash
interveil serve                     # Start on port 3000
interveil serve --port 4000         # Custom port
interveil serve --verbose           # Log every event to console
interveil serve --mcp-server http://localhost:8080  # Enable MCP proxy
```

## Step Types

| Type | Color | Meaning |
|------|-------|---------|
| `REASONING` | Blue | Internal agent thought / chain-of-thought |
| `TOOL_CALL` | Orange | Agent invoking a tool |
| `TOOL_RESULT` | Green | Result returned from a tool |
| `LLM_REQUEST` | Purple | Full prompt sent to a language model |
| `LLM_RESPONSE` | Teal | Full response from a language model |
| `ERROR` | Red | Exception or failure |
| `CUSTOM` | Gray | Any custom event |

## Gateway (LLM Proxy)

Point your IDE at Interveil instead of directly at OpenAI:

- **Cursor**: Settings → Models → Base URL → `http://localhost:3000/v1/proxy`
- **Continue.dev**: `config.json` → `"apiBase": "http://localhost:3000/v1/proxy"`
- **Any OpenAI-compatible tool**: Set base URL to `http://localhost:3000/v1/proxy`

Interveil intercepts every request, logs it as a trace event, forwards it to the real provider, and returns the response unchanged. Your API key is never stored.

## Docker

```bash
docker-compose up
# → Interveil running at http://localhost:3000
```

## API Reference

### `POST /api/v1/events`
Ingest a single trace event.

### `POST /api/v1/sessions`
Register a new session.

### `PATCH /api/v1/sessions/:id`
Update session status (completed/failed).

### `GET /api/v1/health`
Health check — returns `{ "ok": true, "version": "..." }`.

### `GET /api/v1/sessions`
List all sessions.

### `GET /api/v1/sessions/:id/events`
Get all events for a session.

### WebSocket `ws://localhost:3000/ws`
Live stream of all trace events as they arrive.

## License

MIT
