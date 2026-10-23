# Interveil — OpenAI Agents SDK example

An [OpenAI Agents SDK](https://openai.github.io/openai-agents-python/) agent whose model calls go through the Interveil gateway. The agent and its tools are unchanged; the integration is the client setup:

```python
set_default_openai_client(AsyncOpenAI(
    base_url="http://localhost:3000/v1/proxy",
    api_key=os.environ["OPENAI_API_KEY"],
    default_headers={"x-interveil-agent-id": "support-agent"},
))
set_default_openai_api("chat_completions")  # the gateway implements Chat Completions
```

## Run it

From the `interveil/` directory, after `pnpm install && pnpm build` at the repo root:

```bash
node dist/cli.js serve --policy-file examples/policies/support-agent.yaml
```

```bash
pip install -r examples/openai-agents/requirements.txt
OPENAI_API_KEY=sk-... python examples/openai-agents/support_agent.py
```

The order notes returned by `lookup_order` contain a prompt injection asking for a $4,900 refund to another account. Whether a real model follows it varies. When it does, the gateway withholds that tool call before the SDK can execute it (policy rule `large-refunds`), and the run ends with Interveil's explanation:

```
tools executed: ['lookup_order(1042)', 'issue_refund(1042, 49.0, original_payment)']
final output:   ...
[Interveil] Tool call blocked by policy: issue_refund (policy rule "large-refunds": Refunds over $100 need a human).
```

Both `Runner.run` and `Runner.run_streamed` work; with streaming, text arrives live and tool-call chunks are held until the gateway has checked them. Verified with `openai-agents` 0.24.0 against a scripted OpenAI-compatible model.
