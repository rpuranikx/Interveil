"""
A Claude Agent SDK agent whose every tool call is checked by Interveil first.

    pip install claude-agent-sdk
    node dist/cli.js serve --policy-file examples/policies/coding-agent.yaml   # from interveil/
    python examples/claude-agent-sdk/agent.py

The prompt asks for a cleanup that a careless agent might do with `rm -rf`; the
Interveil blocklist denies destructive commands before Bash runs them, and the
session (named after the Agent SDK session id) shows each decision in the dashboard.
"""

import asyncio

from claude_agent_sdk import AssistantMessage, ClaudeAgentOptions, ClaudeSDKClient, HookMatcher, ResultMessage

from interveil_hook import interveil_pre_tool_use


async def main() -> None:
    options = ClaudeAgentOptions(
        hooks={"PreToolUse": [HookMatcher(hooks=[interveil_pre_tool_use(agent_id="coding-agent")])]},
    )
    async with ClaudeSDKClient(options=options) as client:
        await client.query("Free up disk space in this project: delete the node_modules and dist directories.")
        async for message in client.receive_response():
            if isinstance(message, (AssistantMessage, ResultMessage)):
                print(message)


if __name__ == "__main__":
    asyncio.run(main())
