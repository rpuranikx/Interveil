"""
Interveil Python SDK — thin client for the Interveil trace server.
No dependencies beyond the standard library (uses urllib) and requests (optional).
"""

import functools
import inspect
import json
import os
import re
import sys
import uuid
from datetime import datetime, timezone
from typing import Optional, Dict, Any, List, Tuple

try:
    import requests as _requests
    _HAS_REQUESTS = True
except ImportError:
    _HAS_REQUESTS = False

try:
    import aiohttp as _aiohttp
    _HAS_AIOHTTP = True
except ImportError:
    _HAS_AIOHTTP = False


def _warn(msg: str) -> None:
    print(f"[Interveil] {msg}", file=sys.stderr)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _infer_step_type(method_name: str) -> str:
    name = method_name.lower()
    if any(k in name for k in ("think", "reason", "plan", "reflect")):
        return "REASONING"
    if any(k in name for k in ("complete", "chat", "message", "generate", "predict")):
        return "LLM_REQUEST"
    if any(k in name for k in ("call", "invoke", "run", "execute", "use")):
        return "TOOL_CALL"
    return "CUSTOM"


# ── Default command blocklist ─────────────────────────────────────────────────
# Mirrors src/commands/blocklist.ts; test-fixtures/blocklist-cases.json keeps the
# two in sync. Rules run against a normalized form of each string (lowercased,
# quotes and backslashes removed, whitespace collapsed). This is a speed bump for
# obviously destructive commands, not a sandbox.
_DEFAULT_RULES: List[Tuple[str, "re.Pattern[str]"]] = [(rule_id, re.compile(pattern)) for rule_id, pattern in [
    ("rm-recursive", r"\brm(?=[^;&|]*\s(?:-[a-z]*r[a-z]*|--recursive)(?:\s|$))[^;&|]*\s(?:[/~$]|[a-z]:|\*(?=\s|$)|\.{1,2}/?\*?(?=\s|$)|\.\./|\S*/\.\.(?=/|\s|$))"),
    ("sudo-rm", r"\bsudo\s+rm\b"),
    ("find-delete", r"\bfind\b[^;&|]*\s-delete\b"),
    ("bulk-rm", r"\bfind\b[^;&|]*\s-exec(?:dir)?\s+(?:sudo\s+)?(?:\S*/)?rm\b|\bxargs\b[^;&]*\brm\b"),
    ("rmtree", r"\bshutil\.rmtree\b|\bfs\.rmsync\b|\brimraf\b"),
    ("pipe-to-shell", r"\b(?:curl|wget)\b[^;&]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b"),
    ("decode-to-shell", r"\bbase64\s+(?:-d|--decode)\b[^;&]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b"),
    ("sql-drop", r"\bdrop\s+(?:table|database|schema)\b"),
    ("sql-truncate", r"\btruncate\s+table\b|^truncate\s+[a-z_][\w.]*$"),
    ("mkfs", r"\bmkfs(?:\.\w+)?\b"),
    ("dd-to-device", r"\bdd\b[^;&|]*\bof=/dev/"),
    ("windows-format", r"\bformat\s+[a-z]:|\bdiskpart\b"),
    ("chmod-777-absolute", r"\bchmod\s+(?:-[a-z]+\s+)*0?777\s+/"),
    ("system-credentials", r"/etc/(?:passwd|shadow|sudoers)\b"),
    ("user-credentials", r"\.aws/credentials\b|\bid_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?\b(?!\.pub)|\.ssh/identity\b"),
]]

# Strings scanned per call before giving up and blocking (fail closed).
MAX_SCANNED_STRINGS = 10_000


def _normalize(command: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"['\"\\]", "", command.lower())).strip()


def _segments(normalized: str) -> List[str]:
    return [s for s in re.split(r"\s*(?:&&|\|\||;|\n|\$\(|`)\s*", normalized) if s]


def _extract_strings(value: Any, limit: int = MAX_SCANNED_STRINGS) -> Optional[List[str]]:
    """Collect every string (dict keys included) with no depth limit; None if over `limit`."""
    out: List[str] = []
    seen = set()
    stack = [value]
    while stack:
        v = stack.pop()
        if isinstance(v, str):
            out.append(v)
        elif isinstance(v, (int, float, bool)):
            out.append(str(v))
        elif isinstance(v, (list, tuple, set, dict)):
            if id(v) in seen:
                continue
            seen.add(id(v))
            if isinstance(v, dict):
                for k, child in v.items():
                    stack.extend((k, child))
            else:
                stack.extend(v)
        if len(out) > limit:
            return None
    return out


def _check_blocked(value: Any, extra_patterns: Optional[List[str]] = None) -> Optional[str]:
    """
    Deep-scan value and return the id of the first rule it matches (user patterns
    first, then the default rules), or None if it is safe.
    """
    candidates = _extract_strings(value)
    if candidates is None:
        return f"more than {MAX_SCANNED_STRINGS} strings"
    extra = [p for p in (_normalize(p) for p in (extra_patterns or [])) if p]
    for raw in candidates:
        for segment in _segments(_normalize(raw)):
            for pattern in extra:
                if pattern in segment:
                    return pattern
            for rule_id, rule in _DEFAULT_RULES:
                if rule.search(segment):
                    return rule_id
    return None


class PolicyViolationError(Exception):
    """Raised when the Interveil server's policy refuses a traced method call."""
    def __init__(self, rule_id: str, method_name: str, message: str):
        super().__init__(f"[Interveil] '{method_name}' blocked by policy rule \"{rule_id}\": {message}")
        self.rule_id = rule_id
        self.method_name = method_name


class BlockedCommandError(Exception):
    """Raised when a traced method call is blocked by the command blocklist."""
    def __init__(self, pattern: str, method_name: str):
        super().__init__(
            f"[Interveil] '{method_name}' blocked — argument matched pattern: \"{pattern}\""
        )
        self.pattern = pattern
        self.method_name = method_name


class InterveillClient:
    """
    Synchronous Interveil client.

    All methods fail silently with a console warning if the server is unreachable.
    They never raise an exception that would crash the developer's agent.
    """

    def __init__(self, host: str = "localhost", port: int = 3000, api_key: Optional[str] = None) -> None:
        self.base_url = f"http://{host}:{port}"
        self.headers = {"Content-Type": "application/json"}
        key = api_key or os.environ.get("INTERVEIL_API_KEY")
        if key:
            self.headers["x-interveil-key"] = key

    def _post(self, path: str, data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        url = f"{self.base_url}{path}"
        body = json.dumps(data).encode("utf-8")
        try:
            if _HAS_REQUESTS:
                resp = _requests.post(url, data=body, headers=self.headers, timeout=5)
                return resp.json()
            else:
                import urllib.request
                req = urllib.request.Request(
                    url, data=body,
                    headers=self.headers,
                    method="POST",
                )
                with urllib.request.urlopen(req, timeout=5) as resp:
                    return json.loads(resp.read().decode("utf-8"))
        except Exception as exc:
            _warn(f"Server unreachable at {url} — {exc}")
            return None

    def _patch(self, path: str, data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        url = f"{self.base_url}{path}"
        body = json.dumps(data).encode("utf-8")
        try:
            if _HAS_REQUESTS:
                resp = _requests.patch(url, data=body, headers=self.headers, timeout=5)
                return resp.json()
            else:
                import urllib.request
                req = urllib.request.Request(
                    url, data=body,
                    headers=self.headers,
                    method="PATCH",
                )
                with urllib.request.urlopen(req, timeout=5) as resp:
                    return json.loads(resp.read().decode("utf-8"))
        except Exception as exc:
            _warn(f"Server unreachable at {url} — {exc}")
            return None

    def start_session(
        self,
        name: Optional[str] = None,
        agent_id: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        session_id = str(uuid.uuid4())
        payload: Dict[str, Any] = {"session_id": session_id}
        if name:     payload["name"] = name
        if agent_id: payload["agent_id"] = agent_id
        if metadata: payload["metadata"] = metadata
        self._post("/api/v1/sessions", payload)
        return {"session_id": session_id}

    def emit(
        self,
        session_id: str,
        step_index: int,
        step_type: str,
        input: Any,
        output: Any,
        timestamp: Optional[str] = None,
        duration_ms: Optional[int] = None,
        token_usage: Optional[Dict[str, int]] = None,
        model: Optional[str] = None,
        error: Optional[Any] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Optional[str]:
        if timestamp is None:
            timestamp = _now()
        payload: Dict[str, Any] = {
            "session_id": session_id,
            "step_index": step_index,
            "step_type": step_type,
            "input": input,
            "output": output,
            "timestamp": timestamp,
        }
        if duration_ms  is not None: payload["duration_ms"]  = duration_ms
        if token_usage  is not None: payload["token_usage"]  = token_usage
        if model        is not None: payload["model"]        = model
        if error        is not None: payload["error"]        = error
        if metadata     is not None: payload["metadata"]     = metadata
        result = self._post("/api/v1/events", payload)
        return result.get("event_id") if result else None

    def evaluate_policy(
        self, tool: str, args: List[Any], agent_id: str, session_id: Optional[str] = None,
    ) -> Optional[Dict[str, Any]]:
        """Ask the server's YAML policy and blocklist whether a call may run. None if unreachable."""
        payload: Dict[str, Any] = {"tool": tool, "args": args, "agent_id": agent_id}
        if session_id:
            payload["session_id"] = session_id
        return self._post("/api/v1/policy/evaluate", payload)

    def end_session(self, session_id: str, status: str = "completed") -> bool:
        result = self._patch(f"/api/v1/sessions/{session_id}", {
            "status": status,
            "ended_at": _now(),
        })
        return bool(result and result.get("ok"))

    async def emit_async(
        self,
        session_id: str,
        step_index: int,
        step_type: str,
        input: Any,
        output: Any,
        timestamp: Optional[str] = None,
        duration_ms: Optional[int] = None,
        token_usage: Optional[Dict[str, int]] = None,
        model: Optional[str] = None,
        error: Optional[Any] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Optional[str]:
        if not _HAS_AIOHTTP:
            _warn("aiohttp not installed — falling back to synchronous emit()")
            return self.emit(
                session_id=session_id, step_index=step_index, step_type=step_type,
                input=input, output=output, timestamp=timestamp, duration_ms=duration_ms,
                token_usage=token_usage, model=model, error=error, metadata=metadata,
            )
        if timestamp is None:
            timestamp = _now()
        payload: Dict[str, Any] = {
            "session_id": session_id, "step_index": step_index,
            "step_type": step_type, "input": input, "output": output,
            "timestamp": timestamp,
        }
        if duration_ms  is not None: payload["duration_ms"]  = duration_ms
        if token_usage:              payload["token_usage"]  = token_usage
        if model:                    payload["model"]        = model
        if error        is not None: payload["error"]        = error
        if metadata:                 payload["metadata"]     = metadata
        try:
            async with _aiohttp.ClientSession() as session:
                async with session.post(
                    f"{self.base_url}/api/v1/events", json=payload, headers=self.headers,
                    timeout=_aiohttp.ClientTimeout(total=5),
                ) as resp:
                    data = await resp.json()
                    return data.get("event_id")
        except Exception as exc:
            _warn(f"Server unreachable (async) — {exc}")
            return None


# ── trace() — one-liner agent wrapper ────────────────────────────────────────

class TracedAgent:
    """
    Wraps any Python object and intercepts every method call.

    Before each call:
      1. Deep-scans all arguments for blocked patterns (raises BlockedCommandError).
      2. Emits a pre-execution trace event.

    After each call (or on error):
      3. Emits the result / error as a follow-up trace event.

    Usage::

        from interveil import trace
        agent = trace(MyAgent(), session_name="run-1", blocked_patterns=["DROP TABLE"])
    """

    def __init__(
        self,
        wrapped: Any,
        client: InterveillClient,
        session_id: str,
        verbose: bool = False,
        dry_run: bool = False,
        blocked_patterns: Optional[List[str]] = None,
        policy_agent_id: Optional[str] = None,
    ) -> None:
        # Use object.__setattr__ to avoid triggering our own __setattr__
        object.__setattr__(self, "_wrapped", wrapped)
        object.__setattr__(self, "_client", client)
        object.__setattr__(self, "_session_id", session_id)
        object.__setattr__(self, "_verbose", verbose)
        object.__setattr__(self, "_dry_run", dry_run)
        object.__setattr__(self, "_blocked_patterns", blocked_patterns or [])
        object.__setattr__(self, "_policy_agent_id", policy_agent_id)
        object.__setattr__(self, "_step_index", 0)

    def _next_step(self) -> int:
        idx = object.__getattribute__(self, "_step_index")
        object.__setattr__(self, "_step_index", idx + 1)
        return idx

    def __getattr__(self, name: str) -> Any:
        wrapped = object.__getattribute__(self, "_wrapped")
        attr = getattr(wrapped, name)

        if not callable(attr):
            return attr

        client          = object.__getattribute__(self, "_client")
        session_id      = object.__getattribute__(self, "_session_id")
        verbose         = object.__getattribute__(self, "_verbose")
        dry_run         = object.__getattribute__(self, "_dry_run")
        blocked_patterns = object.__getattribute__(self, "_blocked_patterns")
        policy_agent_id = object.__getattribute__(self, "_policy_agent_id")

        is_async = inspect.iscoroutinefunction(attr)

        if is_async:
            @functools.wraps(attr)
            async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
                return await _run_traced(
                    attr, name, args, kwargs,
                    client, session_id, self._next_step,
                    verbose, dry_run, blocked_patterns, policy_agent_id,
                )
            return async_wrapper
        else:
            @functools.wraps(attr)
            def sync_wrapper(*args: Any, **kwargs: Any) -> Any:
                import asyncio
                # If there's a running event loop, create a task; otherwise run sync
                try:
                    loop = asyncio.get_running_loop()
                    # We're inside an async context — return a coroutine so the
                    # caller can await it.  Sync methods become async when traced.
                    return _run_traced(
                        attr, name, args, kwargs,
                        client, session_id, self._next_step,
                        verbose, dry_run, blocked_patterns, policy_agent_id,
                    )
                except RuntimeError:
                    # No event loop running — run synchronously
                    return asyncio.run(_run_traced(
                        attr, name, args, kwargs,
                        client, session_id, self._next_step,
                        verbose, dry_run, blocked_patterns, policy_agent_id,
                    ))
            return sync_wrapper

    def end(self, status: str = "completed") -> None:
        """Mark the session as completed or failed."""
        client     = object.__getattribute__(self, "_client")
        session_id = object.__getattribute__(self, "_session_id")
        client.end_session(session_id, status)


async def _run_traced(
    fn: Any,
    method_name: str,
    args: tuple,
    kwargs: dict,
    client: InterveillClient,
    session_id: str,
    next_step,
    verbose: bool,
    dry_run: bool,
    blocked_patterns: List[str],
    policy_agent_id: Optional[str] = None,
) -> Any:
    import time

    timestamp = _now()
    step_index = next_step()
    step_type = _infer_step_type(method_name)

    if verbose:
        print(f"[Interveil] {method_name} → {step_type} (step {step_index})", file=sys.stderr)

    # ── dry run ───────────────────────────────────────────────────────────────
    if dry_run:
        client.emit(
            session_id=session_id, step_index=step_index, step_type="COMMAND_DRY_RUN",
            input={"method": method_name, "args": list(args), "kwargs": kwargs},
            output=None, timestamp=timestamp, duration_ms=0,
            metadata={"dry_run": True},
        )
        if verbose:
            print(f"[Interveil] DRY RUN — {method_name} not executed", file=sys.stderr)
        return None

    # ── blocklist: deep-scan all args and kwargs ──────────────────────────────
    matched = _check_blocked([list(args), kwargs], blocked_patterns)
    if matched:
        client.emit(
            session_id=session_id, step_index=step_index, step_type="COMMAND_BLOCKED",
            input={"method": method_name, "args": list(args), "kwargs": kwargs},
            output=None, timestamp=timestamp, duration_ms=0,
            metadata={"blocked_pattern": matched, "severity": "high"},
        )
        if verbose:
            print(f"[Interveil] BLOCKED — {method_name}() matched \"{matched}\"", file=sys.stderr)
        raise BlockedCommandError(matched, method_name)

    # ── policy: ask the server, fail closed if it cannot answer ──────────────
    if policy_agent_id is not None:
        call_args = list(args) + ([kwargs] if kwargs else [])
        decision = client.evaluate_policy(method_name, call_args, policy_agent_id, session_id)
        if not decision or not decision.get("ok"):
            raise PolicyViolationError("policy-unavailable", method_name, "the Interveil server could not evaluate the policy, so the call was refused")
        if not decision.get("allowed"):
            if verbose:
                print(f"[Interveil] BLOCKED — {method_name}() by policy rule \"{decision.get('rule_id')}\"", file=sys.stderr)
            raise PolicyViolationError(decision.get("rule_id") or "policy", method_name, decision.get("message") or "blocked by policy")

    # ── execute ───────────────────────────────────────────────────────────────
    start_ms = time.monotonic()
    result = None
    error_info = None
    final_step_type = step_type

    try:
        if inspect.iscoroutinefunction(fn):
            result = await fn(*args, **kwargs)
        else:
            result = fn(*args, **kwargs)
    except Exception as exc:
        final_step_type = "ERROR"
        error_info = {"message": str(exc), "type": type(exc).__name__}

    duration_ms = int((time.monotonic() - start_ms) * 1000)

    client.emit(
        session_id=session_id, step_index=step_index, step_type=final_step_type,
        input={"method": method_name, "args": list(args), "kwargs": kwargs},
        output=result, timestamp=timestamp, duration_ms=duration_ms,
        error=error_info,
    )

    if error_info is not None:
        raise RuntimeError(error_info["message"])

    # Emit LLM_RESPONSE pair for LLM methods
    if step_type == "LLM_REQUEST":
        client.emit(
            session_id=session_id, step_index=next_step(), step_type="LLM_RESPONSE",
            input=None, output=result, timestamp=_now(), duration_ms=duration_ms,
        )

    return result


def trace(
    agent: Any,
    *,
    host: str = "localhost",
    port: int = 3000,
    session_name: Optional[str] = None,
    agent_id: Optional[str] = None,
    verbose: bool = False,
    dry_run: bool = False,
    blocked_patterns: Optional[List[str]] = None,
    enforce_policy: bool = False,
    api_key: Optional[str] = None,
) -> TracedAgent:
    """
    Wrap any Python object so every method call is traced, blocked if dangerous,
    and streamed to the Interveil server.

    Usage::

        from interveil import trace

        agent = trace(
            MyAgent(),
            session_name="research-run-1",
            blocked_patterns=["DROP TABLE", "rm -rf"],
            verbose=True,
        )
        result = agent.run("What is the capital of France?")
        agent.end()   # marks session as completed

    All keyword arguments:

    - ``host`` / ``port``: Interveil server location (default localhost:3000).
    - ``session_name``: Human-readable label shown in the UI.
    - ``agent_id``: Agent identifier used in policy rules.
    - ``verbose``: Print step names to stderr as they happen.
    - ``dry_run``: Record everything but never execute any method.
    - ``blocked_patterns``: Extra string patterns to block (in addition to the
      built-in blocklist of destructive commands).
    - ``enforce_policy``: Before each call, ask the server's YAML policy
      (``interveil serve --policy-file``) whether it may run. Positional
      arguments (plus kwargs as a final dict) are evaluated as ``args``. If the
      server cannot answer, the call is refused.
    - ``api_key``: Interveil API key (defaults to ``INTERVEIL_API_KEY``).
    """
    client = InterveillClient(host=host, port=port, api_key=api_key)
    session = client.start_session(name=session_name or _now(), agent_id=agent_id)
    session_id = session["session_id"]

    if verbose:
        print(f"[Interveil] Session started: {session_id}", file=sys.stderr)

    return TracedAgent(
        wrapped=agent,
        client=client,
        session_id=session_id,
        verbose=verbose,
        dry_run=dry_run,
        blocked_patterns=blocked_patterns,
        policy_agent_id=(agent_id or "default") if enforce_policy else None,
    )
