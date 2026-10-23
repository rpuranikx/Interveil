# Interveil — Python Example

From the `interveil/` directory, with the server running (`node dist/cli.js serve`):

```bash
python examples/python/basic_agent.py
```

The example shows both SDK styles:

1. **`trace()` wrapper** — a research agent whose `plan`, `search`, `summarise` and `run_shell` calls are traced. The final `run_shell("rm -rf ...")` call is blocked before it runs and appears as a red `BLOCKED` step.
2. **Manual `InterveillClient`** — emits `REASONING`, `TOOL_CALL` and `LLM_RESPONSE` events by hand.

Watch http://localhost:3000 to see events appear in real time.
