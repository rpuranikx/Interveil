# Interveil — Python SDK

Thin Python client for the [Interveil](https://github.com/interveil/interveil) trace server.

## Installation

```bash
pip install interveil
# Optional: add requests for better HTTP support
pip install "interveil[requests]"
# Optional: async support
pip install "interveil[async]"
```

## Usage

```python
from interveil import InterveillClient
from datetime import datetime, timezone

client = InterveillClient(port=3000)

# Start a session
session = client.start_session(name="my-python-agent-run")

# Emit trace events
client.emit(
    session_id=session["session_id"],
    step_index=0,
    step_type="REASONING",
    input={"prompt": "What should I do?"},
    output={"thought": "Check the database first"},
    timestamp=datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    duration_ms=45,
)

# End the session
client.end_session(session["session_id"], "completed")
```

## Direct HTTP (no SDK required)

```bash
# Start a session
curl -X POST http://localhost:3000/api/v1/sessions \
  -H "Content-Type: application/json" \
  -d '{"session_id": "abc-123", "name": "my-run"}'

# Send an event
curl -X POST http://localhost:3000/api/v1/events \
  -H "Content-Type: application/json" \
  -d '{"session_id":"abc-123","step_index":0,"step_type":"TOOL_CALL","input":{"tool":"search"},"output":{"results":[]},"timestamp":"2025-04-27T14:32:01.123Z"}'
```
