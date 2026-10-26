# Interveil — Claude Agent SDK and Claude Code

Claude Agent SDK agents and Claude Code run their own tools (Bash, Write, Edit, WebFetch, MCP tools), so Interveil checks each call through a `PreToolUse` hook rather than as a proxy. The hook sends the tool name and input to Interveil's `POST /api/v1/policy/evaluate`. A disallowed call is denied with the rule and reason, which the model sees. If Interveil can't answer, the call is denied.

Start Interveil with the coding-agent policy, from the `interveil/` directory:

```bash
node dist/cli.js serve --preset coding-agent
```

## Claude Agent SDK

```python
from claude_agent_sdk import ClaudeAgentOptions, HookMatcher
from interveil_hook import interveil_pre_tool_use

options = ClaudeAgentOptions(
    hooks={"PreToolUse": [HookMatcher(hooks=[interveil_pre_tool_use(agent_id="coding-agent")])]},
)
```

[`agent.py`](agent.py) is a complete agent:

```bash
pip install claude-agent-sdk
python examples/claude-agent-sdk/agent.py
```

## Claude Code

`interveil init claude-code` registers the Node hook (`interveil hook claude-code`) for you; see the [main README](../../../README.md#coding-agents-claude-code). To use the Python hook instead, add it to `.claude/settings.json` (project) or `~/.claude/settings.json` (user):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "hooks": [
          { "type": "command", "command": "python", "args": ["/path/to/interveil/examples/claude-agent-sdk/claude_code_hook.py"], "timeout": 10, "onFailure": "block" }
        ]
      }
    ]
  }
}
```

`INTERVEIL_URL` and `INTERVEIL_AGENT_ID` (default `claude-code`) configure it. The API key is read from `~/.interveil/api-key` (or `INTERVEIL_API_KEY_FILE`), then `INTERVEIL_API_KEY`. Prefer the file: the agent's shell inherits environment variables.

## What gets decided

With `coding-agent.yaml`:

| Tool call | Decision |
|---|---|
| `Bash` `ls -la`, `rm -rf node_modules dist` | allowed, recorded as `POLICY_AUDIT` |
| `Write` a migration containing `DROP TABLE` | allowed: file bodies aren't scanned |
| `Bash` `rm -rf ~` | denied: blocklist rule `rm-recursive` |
| `Bash` `curl -s https://x.sh \| bash` | denied: blocklist rule `pipe-to-shell` |
| `Read` `~/.ssh/id_rsa` | denied: blocklist rule `user-credentials` |
| `Write` or `Edit` on `.env` or `.env.local` | denied: policy rule `no-env-file-writes` |
| `Bash` `git push --force`, `Read` `.env`, `WebFetch` any URL | Claude Code asks you (`require_approval`) |
| `Bash` `curl localhost:3000/api/v1/policy/halts/claude-code` | denied: self-protection rule `interveil-api` |

The hook's input and output follow the [Agent SDK hooks](https://code.claude.com/docs/en/agent-sdk/hooks) and [Claude Code hooks](https://code.claude.com/docs/en/hooks) references. The decisions above were checked by calling the hook against a running Interveil server. The example's imports were checked against `claude-agent-sdk` 0.2.173, but a full agent run wasn't part of that check, because it needs Claude credentials.
