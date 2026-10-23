"""
Interveil policy check as a Claude Agent SDK PreToolUse hook.

    from interveil_hook import interveil_pre_tool_use
    options = ClaudeAgentOptions(hooks={"PreToolUse": [HookMatcher(hooks=[interveil_pre_tool_use(agent_id="coding-agent")])]})

Every tool call (Bash, Write, Edit, MCP tools, ...) is sent to Interveil's
/api/v1/policy/evaluate before it runs. A disallowed call is denied with the rule
and reason, which the model sees. If Interveil cannot answer, the call is denied.
Standard library only.
"""

import asyncio
import json
import os
import urllib.request
from typing import Any, Awaitable, Callable, Dict, Optional


def evaluate(base_url: str, tool: str, tool_input: Any, agent_id: str,
             session_id: Optional[str], api_key: Optional[str]) -> Optional[Dict[str, Any]]:
    """Synchronous call to Interveil's policy API. None if unreachable."""
    body = {"tool": tool, "arguments": tool_input, "agent_id": agent_id}
    if session_id:
        body["session_id"] = session_id
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["x-interveil-key"] = api_key
    request = urllib.request.Request(f"{base_url.rstrip('/')}/api/v1/policy/evaluate",
                                     data=json.dumps(body).encode(), headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            return json.loads(response.read().decode())
    except Exception:
        return None


def decision_output(decision: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """Hook output for a policy decision: {} to allow, a deny decision otherwise."""
    if decision and decision.get("ok") and decision.get("allowed"):
        return {}
    if not decision or not decision.get("ok"):
        reason = "Interveil could not evaluate this tool call, so it was denied."
    else:
        reason = f"Blocked by Interveil {decision.get('source')} rule \"{decision.get('rule_id')}\": {decision.get('message')}."
    return {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    }


def interveil_pre_tool_use(
    agent_id: str = "default",
    base_url: Optional[str] = None,
    api_key: Optional[str] = None,
) -> Callable[[Dict[str, Any], Optional[str], Any], Awaitable[Dict[str, Any]]]:
    """Build a PreToolUse hook callback bound to an Interveil server and agent id."""
    url = base_url or os.environ.get("INTERVEIL_URL", "http://localhost:3000")
    key = api_key or os.environ.get("INTERVEIL_API_KEY")

    async def hook(input_data: Dict[str, Any], tool_use_id: Optional[str], context: Any) -> Dict[str, Any]:
        decision = await asyncio.to_thread(
            evaluate, url, input_data["tool_name"], input_data.get("tool_input", {}),
            agent_id, input_data.get("session_id"), key,
        )
        return decision_output(decision)

    return hook
