"""
Interveil Python SDK — thin client for the Interveil trace server.
No dependencies beyond the standard library (uses urllib) and requests (optional).
"""

import functools
import inspect
import json
import sys
import uuid
from datetime import datetime, timezone
from typing import Optional, Dict, Any, List

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
_DEFAULT_BLOCKED: List[str] = [
    "rm -rf", "rm -r ", "rm --recursive",
    "drop table", "drop database", "truncate",
    "format", "diskpart",
    "chmod 777 /", "curl | bash", "curl|bash", "wget | bash", "wget|bash",
    "sudo rm", "sudo mkfs",
    "/etc/passwd", "/etc/shadow", "/.ssh/", "~/.ssh/",
]


def _extract_strings(value: Any, depth: int = 0) -> List[str]:
    """Recursively extract every string value from a nested structure (depth-capped at 8)."""
    if depth > 8:
        return []
    if isinstance(value, str):
        return [value]
    if isinstance(value, (int, float, bool)):
        return [str(value)]
    if isinstance(value, (list, tuple)):
        result = []
        for item in value:
            result.extend(_extract_strings(item, depth + 1))
        return result
    if isinstance(value, dict):
        result = []
        for v in value.values():
            result.extend(_extract_strings(v, depth + 1))
        return result
    return []


def _check_blocked(value: Any, extra_patterns: Optional[List[str]] = None) -> Optional[str]:
    """
    Return the first blocked pattern found in value (or any nested string within it),
    or None if safe. Checks extra_patterns first, then the default blocklist.
    """
    candidates = _extract_strings(value)
    all_patterns = (extra_patterns or []) + _DEFAULT_BLOCKED
    for raw in candidates:
        lower = raw.lower()
        for pattern in all_patterns:
            if pattern.lower() in lower:
                return pattern
    return None


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

    def __init__(self, host: str = "localhost", port: int = 3000) -> None:
        self.base_url = f"http://{host}:{port}"

    def _post(self, path: str, data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        url = f"{self.base_url}{path}"
        body = json.dumps(data).encode("utf-8")
        try:
            if _HAS_REQUESTS:
                resp = _requests.post(url, data=body, headers={"Content-Type": "application/json"}, timeout=5)
                return resp.json()
            else:
                import urllib.request
                req = urllib.request.Request(
                    url, data=body,
                    headers={"Content-Type": "application/json"},
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
                resp = _requests.patch(url, data=body, headers={"Content-Type": "application/json"}, timeout=5)
                return resp.json()
            else:
                import urllib.request
                req = urllib.request.Request(
                    url, data=body,
                    headers={"Content-Type": "application/json"},
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
                    f"{self.base_url}/api/v1/events", json=payload,
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
    ) -> None:
        # Use object.__setattr__ to avoid triggering our own __setattr__
        object.__setattr__(self, "_wrapped", wrapped)
        object.__setattr__(self, "_client", client)
        object.__setattr__(self, "_session_id", session_id)
        object.__setattr__(self, "_verbose", verbose)
        object.__setattr__(self, "_dry_run", dry_run)
        object.__setattr__(self, "_blocked_patterns", blocked_patterns or [])
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

        is_async = inspect.iscoroutinefunction(attr)

        if is_async:
            @functools.wraps(attr)
            async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
                return await _run_traced(
                    attr, name, args, kwargs,
                    client, session_id, self._next_step,
                    verbose, dry_run, blocked_patterns,
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
                        verbose, dry_run, blocked_patterns,
                    )
                except RuntimeError:
                    # No event loop running — run synchronously
                    return asyncio.run(_run_traced(
                        attr, name, args, kwargs,
                        client, session_id, self._next_step,
                        verbose, dry_run, blocked_patterns,
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
    all_values = list(args) + list(kwargs.values())
    for value in all_values:
        matched = _check_blocked(value, blocked_patterns)
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
    """
    client = InterveillClient(host=host, port=port)
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
    )
