"""
Interveil — Basic Python Agent Example

Run with: python examples/python/basic_agent.py
(Requires the Interveil server to be running: interveil serve)

Demonstrates two styles:
  1. trace() one-liner wrapper — automatic tracing for any object
  2. InterveillClient manual API — fine-grained control over each event
"""

import sys
import time
import random
from datetime import datetime, timezone

sys.path.insert(0, "python")
from interveil import InterveillClient, trace, BlockedCommandError


def now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


# ── Style 1: trace() one-liner wrapper ───────────────────────────────────────

class ResearchAgent:
    """A simple agent that the trace() wrapper will instrument automatically."""

    def plan(self, goal: str) -> str:
        time.sleep(0.05)
        return f"Plan: search for '{goal}' then summarise."

    def search(self, query: str) -> dict:
        time.sleep(0.35)
        return {"results": [f"Result A for {query}", f"Result B for {query}"]}

    def summarise(self, results: dict) -> str:
        time.sleep(0.08)
        items = results.get("results", [])
        return "Summary: " + " | ".join(items)

    def run_shell(self, cmd) -> str:
        """Simulate a shell command (won't be reached for blocked patterns)."""
        return f"$ {cmd}\n(simulated output)"


def demo_trace_wrapper():
    print("\n=== Style 1: trace() one-liner wrapper ===")

    agent = trace(
        ResearchAgent(),
        session_name="trace-demo",
        verbose=True,
        # Any string patterns to block, on top of the built-in list
        blocked_patterns=["curl http://evil.com"],
    )

    goal = "latest advances in AI safety"

    plan    = agent.plan(goal)
    results = agent.search(goal)
    summary = agent.summarise(results)
    print(f"\nPlan:    {plan}")
    print(f"Results: {results}")
    print(f"Summary: {summary}")

    # Safe shell call — will trace normally
    output = agent.run_shell("ls -la /tmp")
    print(f"Shell:   {output}")

    # Dangerous call — object arg with buried 'rm -rf' caught before execution
    try:
        agent.run_shell({"command": "rm -rf /important/data"})
    except BlockedCommandError as e:
        print(f"\n[Blocked] {e}")

    agent.end()
    print("[trace] Session marked completed.")


# ── Style 2: InterveillClient manual API ─────────────────────────────────────

def demo_manual_api():
    print("\n=== Style 2: InterveillClient manual API ===")

    client = InterveillClient(port=3000)
    session = client.start_session(
        name="manual-api-demo",
        agent_id="python-agent-v1",
    )
    session_id = session["session_id"]
    print(f"[Agent] Session: {session_id}")

    step = 0

    start = time.time()
    time.sleep(0.08)
    client.emit(
        session_id=session_id, step_index=step, step_type="REASONING",
        input={"prompt": "How should I approach this research task?"},
        output={"thought": "Search → analyse → summarise"},
        timestamp=now(), duration_ms=int((time.time() - start) * 1000),
    )
    step += 1

    start = time.time()
    time.sleep(0.34)
    client.emit(
        session_id=session_id, step_index=step, step_type="TOOL_CALL",
        input={"tool": "web_search", "query": "AI agent frameworks 2025"},
        output={"results": ["LangChain", "AutoGen", "CrewAI", "Interveil"]},
        timestamp=now(), duration_ms=int((time.time() - start) * 1000),
    )
    step += 1

    start = time.time()
    time.sleep(0.85)
    client.emit(
        session_id=session_id, step_index=step, step_type="LLM_RESPONSE",
        input=None,
        output={"content": "LangChain is the most mature framework. AutoGen focuses on multi-agent conversations. Interveil provides observability across all of them."},
        timestamp=now(), duration_ms=int((time.time() - start) * 1000),
        model="gpt-4o",
        token_usage={"prompt_tokens": 87, "completion_tokens": 54, "total_tokens": 141},
    )
    step += 1

    if random.random() < 0.5:
        client.emit(
            session_id=session_id, step_index=step, step_type="ERROR",
            input={"action": "write_report", "path": "/tmp/report.md"},
            output=None, timestamp=now(), duration_ms=12,
            error={"message": "Permission denied", "code": "EACCES"},
        )
        step += 1
        client.end_session(session_id, "failed")
        print(f"[Agent] Done ({step} steps, failed). Open http://localhost:3000")
    else:
        client.end_session(session_id, "completed")
        print(f"[Agent] Done ({step} steps, completed). Open http://localhost:3000")


if __name__ == "__main__":
    demo_trace_wrapper()
    demo_manual_api()
