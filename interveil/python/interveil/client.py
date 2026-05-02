"""
Interveil Python SDK — thin client for the Interveil trace server.
No dependencies beyond the standard library (uses urllib) and requests (optional).
"""

import json
import sys
import uuid
import warnings
from datetime import datetime, timezone
from typing import Optional, Dict, Any

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
                    url,
                    data=body,
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
                    url,
                    data=body,
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
        """
        Register a new session. Returns {"session_id": "..."}.
        Generates a uuid v4 session_id locally and POSTs to the server.
        """
        session_id = str(uuid.uuid4())
        payload: Dict[str, Any] = {"session_id": session_id}
        if name:
            payload["name"] = name
        if agent_id:
            payload["agent_id"] = agent_id
        if metadata:
            payload["metadata"] = metadata

        result = self._post("/api/v1/sessions", payload)
        if result and result.get("ok"):
            return {"session_id": session_id}
        return {"session_id": session_id}  # Return locally generated id even if server is down

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
        """
        Emit a single trace event. Returns the event_id or None if server unreachable.
        """
        if timestamp is None:
            timestamp = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

        payload: Dict[str, Any] = {
            "session_id": session_id,
            "step_index": step_index,
            "step_type": step_type,
            "input": input,
            "output": output,
            "timestamp": timestamp,
        }
        if duration_ms is not None:
            payload["duration_ms"] = duration_ms
        if token_usage is not None:
            payload["token_usage"] = token_usage
        if model is not None:
            payload["model"] = model
        if error is not None:
            payload["error"] = error
        if metadata is not None:
            payload["metadata"] = metadata

        result = self._post("/api/v1/events", payload)
        if result and result.get("ok"):
            return result.get("event_id")
        return None

    def end_session(self, session_id: str, status: str = "completed") -> bool:
        """
        Mark a session as completed or failed.
        """
        ended_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        result = self._patch(f"/api/v1/sessions/{session_id}", {
            "status": status,
            "ended_at": ended_at,
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
        """
        Async version of emit() using aiohttp.
        """
        if not _HAS_AIOHTTP:
            _warn("aiohttp not installed — falling back to synchronous emit()")
            return self.emit(
                session_id=session_id,
                step_index=step_index,
                step_type=step_type,
                input=input,
                output=output,
                timestamp=timestamp,
                duration_ms=duration_ms,
                token_usage=token_usage,
                model=model,
                error=error,
                metadata=metadata,
            )

        if timestamp is None:
            timestamp = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

        payload: Dict[str, Any] = {
            "session_id": session_id,
            "step_index": step_index,
            "step_type": step_type,
            "input": input,
            "output": output,
            "timestamp": timestamp,
        }
        if duration_ms is not None:
            payload["duration_ms"] = duration_ms
        if token_usage:
            payload["token_usage"] = token_usage
        if model:
            payload["model"] = model
        if error is not None:
            payload["error"] = error
        if metadata:
            payload["metadata"] = metadata

        try:
            async with _aiohttp.ClientSession() as session:
                async with session.post(
                    f"{self.base_url}/api/v1/events",
                    json=payload,
                    timeout=_aiohttp.ClientTimeout(total=5),
                ) as resp:
                    data = await resp.json()
                    return data.get("event_id")
        except Exception as exc:
            _warn(f"Server unreachable (async) — {exc}")
            return None
