# Interveil

**Trace AI agent runs live, and block disallowed tool calls before they execute.**

Interveil is a self-hosted server with a live dashboard, a TypeScript and Python SDK, and an OpenAI-compatible LLM proxy. Wrap an agent with `trace()` and every method call is recorded; with a YAML policy or the command blocklist, a disallowed call throws before the method runs.

> **Status: v0.1, not yet on npm or PyPI.** Install from source as shown below. See [Limitations](#limitations) for what is not done yet.

---

## Quick start

Requires Node.js 20.12+ and pnpm (`corepack enable` installs the pinned version).

```bash
git clone https://github.com/rpuranikx/Interveil.git
cd Interveil
pnpm install
pnpm build
node interveil/dist/cli.js serve
```

Open http://localhost:3000, then run an example agent in a second terminal:

```bash
cd interveil
python examples/python/basic_agent.py
```

The Python example traces a small agent and shows a `run_shell("rm -rf ...")` call being blocked. To trace your own process and keep the dashboard up afterwards: `node interveil/dist/cli.js run <your command>`.

### Docker

```bash
docker compose up
```

The image binds to `0.0.0.0` inside the container, and compose publishes it on `127.0.0.1:3000` only. Traces persist in the `interveil-data` volume. Settings come from `interveil/.env` if present (copy `interveil/.env.example`).

---

## Tracing an agent

### TypeScript

```bash
npm install /path/to/Interveil/interveil   # after `pnpm build`
```

```typescript
import { trace } from 'interveil';

const agent = trace(new MyAgent(), {
  sessionName: 'refund-run',
  agentId: 'billing-agent',           // matched by policy rules
  policyFile: './policy.yaml',        // optional: YAML policy, see below
  commandConfig: { block: ['prod-db'] }, // optional: extra blocklist patterns
});

await agent.run('Refund order 1042');  // every method call is traced
```

`trace()` returns a proxy; each method call is recorded with its arguments, result, duration and errors. Before a call runs, its arguments are deep-scanned by the command blocklist and, if `policyFile` is set, evaluated against the policy. A violation throws `PolicyViolationError` and the method never executes.

| Option | Default | Meaning |
|---|---|---|
| `host`, `port` | `localhost`, `3000` | Interveil server |
| `sessionName` | timestamp | Label in the dashboard |
| `agentId` | `'default'` | Agent id used by policy rules |
| `policyFile` | — | YAML policy; invalid files throw `PolicyLoadError` |
| `commandConfig` | — | `{ block, whitelist, requireApproval }` pattern lists |
| `dryRun` | `false` | Record calls without executing them |
| `autoOpen` | `true` | Open the dashboard on the first call |
| `verbose` | `false` | Log each step to the console |

### Python

The Python SDK has no dependencies; copy `interveil/python/interveil` into your project.

```python
from interveil import trace, BlockedCommandError

agent = trace(MyAgent(), session_name="research-run", blocked_patterns=["prod-db"])
agent.run("What is the capital of France?")
agent.end()
```

The Python SDK applies the same command blocklist as TypeScript. It does **not** evaluate YAML policies yet.

### Any language (HTTP)

```bash
curl -X POST http://localhost:3000/api/v1/events \
  -H "Content-Type: application/json" \
  -d '{"session_id":"6f1c0f3e-8a51-4c47-9f5e-0e4b3f7d2a10","step_index":0,"step_type":"TOOL_CALL",
       "input":{"tool":"search","query":"latest AI news"},"output":{"results":[]},
       "timestamp":"2026-01-01T12:00:00.000Z"}'
```

Sessions are created automatically on first event. See the [API reference](#api).

---

## Policy as code

```yaml
version: "1.0"
defaultAction: allow            # or `block` for deny-by-default

agents:
  - id: billing-agent
    rules:
      - id: large-refunds
        action: block
        message: Refunds over $100 need a human
        condition:
          tool: refund
          args.0.amount: { greaterThan: 100 }   # first argument's `amount` field
      - id: audit-refunds
        action: allow_and_audit
        condition: { tool: refund }

  - id: "*"                     # applies to every agent, after its own rules
    rules:
      - id: no-drops
        action: halt_agent
        severity: critical
        condition: { tool: dropDatabase }
```

- **Actions:** `allow`, `allow_and_audit` (runs and records a `POLICY_AUDIT` event), `block` (throws, records `POLICY_VIOLATION`), `require_approval` (throws; there is no approval workflow yet), `halt_agent` (throws, marks the session failed, and refuses every later call on that agent).
- **Conditions:** `tool` matches the method name; any other key is a dot path into `{ args }` matched by an exact value or `{ equals | greaterThan | lessThan }`. All keys must match.
- **Order:** the agent's own rules, then `*` rules, then `defaultAction`. First match wins.
- **Fails closed:** a missing file, invalid YAML, an unknown action or a misspelled key throws `PolicyLoadError`. `interveil serve --policy-file` exits; `trace()` refuses to wrap the agent.
- **Environments:** `environments.<staging|production>.haltOnCritical: true` escalates `block` rules with `severity: critical` to `halt_agent` (`production` when `NODE_ENV=production`).

## Command blocklist

Every argument (nested objects, arrays and keys included) is scanned before a traced call runs. Strings are lowercased, stripped of quotes and backslashes, whitespace-collapsed and split on `;`, `&&`, `||`, `$(` and backticks; each piece is checked against named regex rules: recursive `rm`, `sudo rm`, `find -delete`, `shutil.rmtree`, `curl|wget … | sh`, `base64 -d … | sh`, `DROP TABLE/DATABASE`, `TRUNCATE`, `mkfs`, `dd of=/dev/…`, `format c:`, `chmod 777 /…`, `/etc/passwd|shadow|sudoers`, `~/.ssh/`, `~/.aws/credentials`.

`commandConfig.whitelist` entries must equal a whole command piece, so whitelisting `rm -rf /tmp/build` does not allow `rm -rf /tmp/build && rm -rf /`. The rules and a shared test corpus live in [`blocklist.ts`](interveil/src/commands/blocklist.ts) and [`blocklist-cases.json`](interveil/test-fixtures/blocklist-cases.json).

This is a speed bump for obviously destructive commands, not a sandbox: an agent determined to obfuscate a command can get past any pattern list.

---

## LLM gateway

Point an OpenAI-compatible client at `http://localhost:3000/v1/proxy`:

```python
from openai import OpenAI
client = OpenAI(base_url="http://localhost:3000/v1/proxy", api_key="sk-...")  # your provider key is forwarded
```

Each request and response is recorded as `LLM_REQUEST` / `LLM_RESPONSE` with tokens and latency. Requests without the `x-interveil-session-id` header are grouped into one session per day.

| Provider (by model prefix) | Non-streaming | Streaming |
|---|---|---|
| OpenAI (`gpt-`, `o1`, `o3`, other) | Passed through unchanged | Passed through unchanged |
| Anthropic (`claude-`) | Text only, translated to/from OpenAI format | Not translated (raw Anthropic events) |
| Gemini (`gemini-`) | Text only, translated; system prompt dropped | Not supported (returns 400) |

Provider keys: a client's own `Authorization: Bearer <provider key>` is forwarded and never stored. If the client sends no key, or sends the Interveil API key, the server uses `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY`.

## MCP proxy

`interveil serve --mcp-server http://localhost:8080` forwards JSON-RPC posted to `/v1/mcp` to one MCP server over plain HTTP and records each request and response as `TOOL_CALL` / `TOOL_RESULT` (with the tool name for `tools/call`). Stdio servers and Streamable HTTP session headers are not supported yet.

---

## Security

- The server binds to `127.0.0.1`. Use `--host 0.0.0.0` (or `INTERVEIL_HOST`) to expose it, and set `INTERVEIL_API_KEY` first.
- Browser requests and WebSocket connections from other origins are refused unless listed with `--allowed-origins` / `ALLOWED_ORIGINS`.
- With `INTERVEIL_API_KEY` set, `/api` (except `/api/v1/health`), `/v1` and `/ws` require it as `x-interveil-key` or `Authorization: Bearer`. The SDKs read the same variable; the dashboard asks for it.
- Rate limits per client IP: 1000/min on `/api`, 120/min on `/v1`.
- Prompts and responses are stored in plain text. There is no redaction.

## CLI

```bash
interveil serve                         # http://localhost:3000, SQLite at ~/.interveil/traces.db
interveil serve --db memory             # in-memory store
interveil serve --db ./traces.db        # custom SQLite path
interveil serve --policy-file policy.yaml
interveil serve --mcp-server http://localhost:8080
interveil serve --host 0.0.0.0 --allowed-origins https://app.example.com
interveil run node my-agent.js          # start the server, run a command, keep serving
```

`interveil` is `node interveil/dist/cli.js` until the package is published. The CLI loads `./.env` if present.

## API

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/v1/sessions` | Register a session (`session_id` must be a UUID) |
| `PATCH` | `/api/v1/sessions/:id` | Mark a session `completed` or `failed` |
| `GET` | `/api/v1/sessions` | List sessions |
| `GET` | `/api/v1/sessions/:id/events` | Events for a session |
| `POST` | `/api/v1/events` | Ingest a trace event |
| `GET` | `/api/v1/health` | Health check (no key required) |
| `POST` | `/v1/proxy/chat/completions` | LLM gateway |
| `GET` | `/v1/proxy/models` | Static model list |
| `POST` | `/v1/mcp` | MCP proxy |
| `WS` | `/ws` | Live event stream (`?token=<key>` when a key is set) |

Step types: `REASONING`, `TOOL_CALL`, `TOOL_RESULT`, `LLM_REQUEST`, `LLM_RESPONSE`, `ERROR`, `CUSTOM`, `COMMAND_BLOCKED`, `COMMAND_DRY_RUN`, `TOOL_PERMISSION_DENIED`, `POLICY_VIOLATION`, `POLICY_AUDIT`, `SIDECAR_ANOMALY`.

---

## Limitations

- **Enforcement runs inside the agent's process.** Policies and the blocklist apply to calls made through `trace()`. An agent that calls an unwrapped object, spawns processes directly, or talks to a provider without the gateway is not stopped. The gateway and MCP proxy record traffic but do not enforce policies yet.
- YAML policies are evaluated by the TypeScript SDK only; the Python SDK applies the blocklist but not policies.
- Step types for wrapped agents are inferred from method names (`think` → `REASONING`, `chat` → `LLM_REQUEST`, `run` → `TOOL_CALL`).
- Anthropic and Gemini translation is text-only: tool calls are not translated, Anthropic streams are not translated, and Gemini streaming is not supported.
- `require_approval` blocks the call; there is no approval workflow.
- One process, one SQLite file. No multi-user accounts, retention policy or redaction.
- Exported but experimental, not wired into the server or dashboard: `SidecarMonitor`, trace comments, the multi-agent graph.

## Development

```bash
pnpm install
pnpm test        # vitest
pnpm typecheck
cd interveil && python -m unittest discover -s python/tests
```

Repository layout: `interveil/` is the server, SDKs and dashboard; `interveil-vscode/` is a VS Code extension that embeds the dashboard; `index.html` is the project site.

## Author

**Rishi Puranik**

## License

[MIT](LICENSE)
