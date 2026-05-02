"""
Interveil — Basic Python Agent Example

Run with: python examples/python/basic_agent.py
(Requires the Interveil server to be running: interveil serve)
"""

import sys
import time
import random
from datetime import datetime, timezone

sys.path.insert(0, "python")
from interveil import InterveillClient


def now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def run():
    client = InterveillClient(port=3000)

    print("[Agent] Starting session...")
    session = client.start_session(
        name="python-basic-agent-demo",
        agent_id="python-agent-v1",
    )
    session_id = session["session_id"]
    print(f"[Agent] Session: {session_id}")

    step = 0

    # Step 0: REASONING
    start = time.time()
    time.sleep(0.08)
    client.emit(
        session_id=session_id,
        step_index=step,
        step_type="REASONING",
        input={"prompt": "How should I approach this research task?"},
        output={"thought": "I'll search for relevant data, analyze it, then summarize findings"},
        timestamp=now(),
        duration_ms=int((time.time() - start) * 1000),
    )
    step += 1

    # Step 1: TOOL_CALL — web search
    start = time.time()
    time.sleep(0.34)
    client.emit(
        session_id=session_id,
        step_index=step,
        step_type="TOOL_CALL",
        input={"tool": "web_search", "query": "AI agent frameworks 2025"},
        output={"results": ["LangChain", "AutoGen", "CrewAI", "Interveil"]},
        timestamp=now(),
        duration_ms=int((time.time() - start) * 1000),
    )
    step += 1

    # Step 2: TOOL_RESULT
    start = time.time()
    time.sleep(0.05)
    client.emit(
        session_id=session_id,
        step_index=step,
        step_type="TOOL_RESULT",
        input={"tool": "web_search"},
        output={"processed": True, "count": 4, "top_result": "LangChain"},
        timestamp=now(),
        duration_ms=int((time.time() - start) * 1000),
    )
    step += 1

    # Step 3: LLM_REQUEST
    start = time.time()
    time.sleep(0.12)
    client.emit(
        session_id=session_id,
        step_index=step,
        step_type="LLM_REQUEST",
        input={
            "model": "gpt-4o",
            "messages": [
                {"role": "system", "content": "You are a research analyst."},
                {"role": "user", "content": "Summarize these AI frameworks: LangChain, AutoGen, CrewAI, Interveil"},
            ],
        },
        output=None,
        timestamp=now(),
        duration_ms=int((time.time() - start) * 1000),
        model="gpt-4o",
    )
    step += 1

    # Step 4: LLM_RESPONSE
    start = time.time()
    time.sleep(0.85)
    client.emit(
        session_id=session_id,
        step_index=step,
        step_type="LLM_RESPONSE",
        input=None,
        output={
            "content": "LangChain is the most mature framework for building LLM chains. AutoGen focuses on multi-agent conversations. CrewAI is designed for role-based agent teams. Interveil is a new observability layer for any agent.",
        },
        timestamp=now(),
        duration_ms=int((time.time() - start) * 1000),
        model="gpt-4o",
        token_usage={"prompt_tokens": 87, "completion_tokens": 54, "total_tokens": 141},
    )
    step += 1

    # Step 5: ERROR (intentional, to demo failure highlighting)
    if random.random() < 0.6:
        start = time.time()
        time.sleep(0.03)
        client.emit(
            session_id=session_id,
            step_index=step,
            step_type="ERROR",
            input={"action": "write_report", "path": "/tmp/report.md"},
            output=None,
            timestamp=now(),
            duration_ms=int((time.time() - start) * 1000),
            error={"message": "Permission denied: cannot write to /tmp/report.md", "code": "EACCES"},
        )
        step += 1
        print("[Agent] Intentional error emitted — check the UI for failure highlighting!")
        client.end_session(session_id, "failed")
    else:
        client.end_session(session_id, "completed")

    print(f"[Agent] Done — {step} steps emitted. Open http://localhost:3000 to see the trace.")


if __name__ == "__main__":
    run()
