#!/usr/bin/env python3
"""
Claude Code PreToolUse command hook: asks Interveil before every tool call.

Register it in .claude/settings.json (see README.md). Claude Code sends the tool
call as JSON on stdin; a disallowed call is denied with Interveil's reason.
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from interveil_hook import decision_output, evaluate  # noqa: E402


def main() -> None:
    event = json.load(sys.stdin)
    decision = evaluate(
        os.environ.get("INTERVEIL_URL", "http://localhost:3000"),
        event["tool_name"],
        event.get("tool_input", {}),
        os.environ.get("INTERVEIL_AGENT_ID", "claude-code"),
        event.get("session_id"),
        os.environ.get("INTERVEIL_API_KEY"),
    )
    output = decision_output(decision)
    if output:
        print(json.dumps(output))
    sys.exit(0)


if __name__ == "__main__":
    main()
