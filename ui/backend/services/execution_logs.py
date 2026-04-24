"""Persistent execution session logs.

Each execution (pipeline run, CRM refresh, client-reported failure, etc.)
is stored as one JSON file under ui/data/execution_logs/.
"""
from __future__ import annotations

import json
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from ui.backend.config import settings

_LOG_DIR: Path = settings.ui_data_dir / "execution_logs"
_LOG_DIR.mkdir(parents=True, exist_ok=True)
_LOCK = threading.Lock()


def _now_utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _now_local_iso() -> str:
    return datetime.now().astimezone().isoformat()


def _session_path(session_id: str) -> Path:
    sid = str(session_id or "").strip()
    if not sid:
        raise ValueError("session_id is required")
    return _LOG_DIR / f"{sid}.json"


def _json_safe(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, dict):
        return {str(k): _json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_json_safe(v) for v in value]
    return str(value)


def _read_json(path: Path) -> dict[str, Any]:
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(parsed, dict):
            return parsed
    except Exception:
        pass
    return {}


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.write_text(json.dumps(_json_safe(payload), ensure_ascii=False, indent=2), encoding="utf-8")


def start_session(
    action: str,
    *,
    source: str = "backend",
    context: Optional[dict[str, Any]] = None,
    session_id: str = "",
    client_local_time: str = "",
    client_timezone: str = "",
    status: str = "running",
) -> str:
    sid = str(session_id or "").strip() or str(uuid.uuid4())
    now_utc = _now_utc_iso()
    now_local = _now_local_iso()
    path = _session_path(sid)

    with _LOCK:
        if path.exists():
            data = _read_json(path)
            data["action"] = str(action or data.get("action") or "unknown")
            data["source"] = str(source or data.get("source") or "backend")
            data["status"] = str(status or data.get("status") or "running")
            data["updated_at_utc"] = now_utc
            data["updated_at_local"] = now_local
            if context:
                old_ctx = data.get("context") if isinstance(data.get("context"), dict) else {}
                data["context"] = {**old_ctx, **_json_safe(context)}
            if client_local_time:
                data["started_at_client_local"] = str(client_local_time)
            if client_timezone:
                data["client_timezone"] = str(client_timezone)
            _write_json(path, data)
            return sid

        payload: dict[str, Any] = {
            "session_id": sid,
            "action": str(action or "unknown"),
            "source": str(source or "backend"),
            "status": str(status or "running"),
            "started_at_utc": now_utc,
            "started_at_local": now_local,
            "updated_at_utc": now_utc,
            "updated_at_local": now_local,
            "finished_at_utc": "",
            "finished_at_local": "",
            "started_at_client_local": str(client_local_time or ""),
            "client_timezone": str(client_timezone or ""),
            "context": _json_safe(context or {}),
            "report": {},
            "errors": [],
            "events": [],
        }
        _write_json(path, payload)
    return sid


def append_event(
    session_id: str,
    message: str,
    *,
    level: str = "info",
    status: str = "",
    data: Optional[dict[str, Any]] = None,
    error: str = "",
    client_local_time: str = "",
) -> None:
    sid = str(session_id or "").strip()
    if not sid:
        return
    path = _session_path(sid)
    now_utc = _now_utc_iso()
    now_local = _now_local_iso()

    with _LOCK:
        payload = _read_json(path) if path.exists() else {}
        if not payload:
            payload = {
                "session_id": sid,
                "action": "unknown",
                "source": "backend",
                "status": "running",
                "started_at_utc": now_utc,
                "started_at_local": now_local,
                "updated_at_utc": now_utc,
                "updated_at_local": now_local,
                "finished_at_utc": "",
                "finished_at_local": "",
                "started_at_client_local": "",
                "client_timezone": "",
                "context": {},
                "report": {},
                "errors": [],
                "events": [],
            }

        events = payload.get("events") if isinstance(payload.get("events"), list) else []
        event = {
            "idx": len(events) + 1,
            "ts_utc": now_utc,
            "ts_local": now_local,
            "client_local_time": str(client_local_time or ""),
            "level": str(level or "info"),
            "status": str(status or ""),
            "message": str(message or ""),
            "data": _json_safe(data or {}),
            "error": str(error or ""),
        }
        events.append(event)
        payload["events"] = events

        if error:
            errs = payload.get("errors") if isinstance(payload.get("errors"), list) else []
            errs.append(
                {
                    "ts_utc": now_utc,
                    "ts_local": now_local,
                    "message": str(error),
                }
            )
            payload["errors"] = errs

        if status:
            payload["status"] = str(status)
        payload["updated_at_utc"] = now_utc
        payload["updated_at_local"] = now_local

        # Prevent unbounded growth for noisy sessions.
        if len(payload["events"]) > 5000:
            payload["events"] = payload["events"][-5000:]
        if len(payload.get("errors", [])) > 500:
            payload["errors"] = payload["errors"][-500:]

        _write_json(path, payload)


def set_report(session_id: str, report: Optional[dict[str, Any]]) -> None:
    sid = str(session_id or "").strip()
    if not sid:
        return
    path = _session_path(sid)
    if not path.exists():
        return
    now_utc = _now_utc_iso()
    now_local = _now_local_iso()
    with _LOCK:
        payload = _read_json(path)
        payload["report"] = _json_safe(report or {})
        payload["updated_at_utc"] = now_utc
        payload["updated_at_local"] = now_local
        _write_json(path, payload)


def finish_session(
    session_id: str,
    *,
    status: str,
    report: Optional[dict[str, Any]] = None,
    error: str = "",
) -> None:
    sid = str(session_id or "").strip()
    if not sid:
        return
    path = _session_path(sid)
    now_utc = _now_utc_iso()
    now_local = _now_local_iso()
    with _LOCK:
        payload = _read_json(path) if path.exists() else {}
        if not payload:
            payload = {
                "session_id": sid,
                "action": "unknown",
                "source": "backend",
                "status": "running",
                "started_at_utc": now_utc,
                "started_at_local": now_local,
                "updated_at_utc": now_utc,
                "updated_at_local": now_local,
                "finished_at_utc": "",
                "finished_at_local": "",
                "started_at_client_local": "",
                "client_timezone": "",
                "context": {},
                "report": {},
                "errors": [],
                "events": [],
            }
        payload["status"] = str(status or payload.get("status") or "done")
        payload["finished_at_utc"] = now_utc
        payload["finished_at_local"] = now_local
        payload["updated_at_utc"] = now_utc
        payload["updated_at_local"] = now_local
        if report is not None:
            payload["report"] = _json_safe(report)
        if error:
            errs = payload.get("errors") if isinstance(payload.get("errors"), list) else []
            errs.append(
                {
                    "ts_utc": now_utc,
                    "ts_local": now_local,
                    "message": str(error),
                }
            )
            payload["errors"] = errs
        _write_json(path, payload)


def get_session(session_id: str) -> Optional[dict[str, Any]]:
    sid = str(session_id or "").strip()
    if not sid:
        return None
    path = _session_path(sid)
    if not path.exists():
        return None
    return _read_json(path)


def list_recent(limit: int = 100, *, action: str = "", source: str = "") -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for path in sorted(_LOG_DIR.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
        data = _read_json(path)
        if not data:
            continue
        if action and str(data.get("action", "")) != action:
            continue
        if source and str(data.get("source", "")) != source:
            continue
        rows.append(
            {
                "session_id": data.get("session_id", path.stem),
                "action": data.get("action", ""),
                "source": data.get("source", ""),
                "status": data.get("status", ""),
                "started_at_utc": data.get("started_at_utc", ""),
                "started_at_local": data.get("started_at_local", ""),
                "finished_at_utc": data.get("finished_at_utc", ""),
                "finished_at_local": data.get("finished_at_local", ""),
                "updated_at_utc": data.get("updated_at_utc", ""),
                "events_count": len(data.get("events", []) or []),
                "errors_count": len(data.get("errors", []) or []),
                "context": data.get("context", {}),
            }
        )
        if len(rows) >= max(1, int(limit)):
            break
    return rows

