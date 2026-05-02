# Interveil — Python Example

## Prerequisites

1. Start the Interveil server:
   ```bash
   interveil serve
   ```

2. Open http://localhost:3000 in your browser

## Run the example

```bash
# From the repo root:
python examples/python/basic_agent.py
```

The example runs a mock 5-step agent run that emits:
- REASONING → TOOL_CALL → TOOL_RESULT → LLM_REQUEST → LLM_RESPONSE
- Then (60% chance) an ERROR step to demo failure highlighting

Watch the UI to see events appear in real time.
