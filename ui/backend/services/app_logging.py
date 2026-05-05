from __future__ import annotations

import atexit
import json
import queue
import threading
import traceback
import uuid
from contextvars import ContextVar
from datetime import datetime
from time import monotonic
from typing import Any, Optional

from fastapi import Request
from sqlmodel import Session

from ui.backend.database import engine
from ui.backend.models.app_log import AppLog
from ui.backend.services import log_buffer

_LEVELS = {"debug", "info", "warn", "error", "audit"}
_CATEGORIES = {
    "system",
    "http",
    "auth",
    "pipeline",
    "llm",
    "elevenlabs",
    "webhook",
    "crm",
    "job",
    "ui",
    "db",
    "transcription",
}

_trace_id_ctx: ContextVar[str] = ContextVar("app_log_trace_id", default="")
_user_email_ctx: ContextVar[str] = ContextVar("app_log_user_email", default="")

_queue: queue.Queue[dict[str, Any]] = queue.Queue(maxsize=10_000)
_writer_stop = threading.Event()
_writer_thread: Optional[threading.Thread] = None
_writer_started = False
_writer_lock = threading.Lock()


def _normalize_level(level: str) -> str:
    v = str(level or "").strip().lower()
    if v == "warning":
        v = "warn"
    if v == "critical":
        v = "error"
    return v if v in _LEVELS else "info"


def _normalize_category(value: str) -> str:
    v = str(value or "").strip().lower()
    return v if v in _CATEGORIES else "system"


def _normalize_email(value: Any) -> str:
    return str(value or "").strip().lower()


def _extract_email(raw: Any) -> str:
    value = str(raw or "").strip()
    if not value:
        return ""
    if ":" in value and "@" in value:
        value = value.split(":")[-1]
    return _normalize_email(value)


def extract_user_email_from_headers(request: Request | None) -> str:
    if request is None:
        return ""
    headers = request.headers
    for candidate in (
        headers.get("x-goog-authenticated-user-email"),
        headers.get("x-auth-request-email"),
        headers.get("x-forwarded-email"),
        headers.get("x-user-email"),
        headers.get("x-email"),
    ):
        email = _extract_email(candidate)
        if email and "@" in email:
            return email
    return ""


def infer_category(message: str, *, source: str = "", component: str = "") -> str:
    s = str(message or "")
    t = s.upper()
    c = str(component or "").lower()
    src = str(source or "").lower()

    if src == "http":
        if "AUTH" in t or "TOKEN" in t or "FORBIDDEN" in t or "UNAUTHORIZED" in t:
            return "auth"
        return "http"
    if "ELEVENLABS" in t:
        return "elevenlabs"
    if "LLM" in t or "OPENAI" in t or "GPT-" in t or "ANTHROPIC" in t or "GEMINI" in t:
        return "llm"
    if "PIPELINE" in t or "CANVAS" in t or "STEP " in t or "RUN QUEUE" in t:
        return "pipeline"
    if "WEBHOOK" in t:
        return "webhook"
    if "CRM" in t or "SYNC" in t:
        return "crm"
    if "TRANSCRIB" in t or "AUDIO" in t:
        return "transcription"
    if "JOB " in t or "DEQUEUED" in t:
        return "job"
    if "AUTH" in t or "FORBIDDEN" in t or "PERMISSION" in t:
        return "auth"
    if "ui" in c or src == "ui":
        return "ui"
    return "system"


def push_context(*, trace_id: str = "", user_email: str = "") -> tuple[Any, Any]:
    trace_token = _trace_id_ctx.set(str(trace_id or "").strip())
    user_token = _user_email_ctx.set(_normalize_email(user_email))
    return trace_token, user_token


def pop_context(tokens: tuple[Any, Any]) -> None:
    trace_token, user_token = tokens
    try:
        _trace_id_ctx.reset(trace_token)
    except Exception:
        pass
    try:
        _user_email_ctx.reset(user_token)
    except Exception:
        pass


def current_trace_id() -> str:
    return _trace_id_ctx.get().strip()


def current_user_email() -> str:
    return _normalize_email(_user_email_ctx.get())


def _safe_json(value: Any) -> str:
    if value is None:
        return ""
    try:
        return json.dumps(value, ensure_ascii=False, default=str)
    except Exception:
        return json.dumps({"value": str(value)}, ensure_ascii=False)


def _persist_rows(rows: list[dict[str, Any]]) -> None:
    if not rows:
        return
    try:
        with Session(engine) as db:
            for row in rows:
                db.add(
                    AppLog(
                        ts=row.get("ts") or datetime.utcnow(),
                        trace_id=str(row.get("trace_id") or ""),
                        service=str(row.get("service") or "backend"),
                        source=str(row.get("source") or "system"),
                        component=str(row.get("component") or ""),
                        category=str(row.get("category") or "system"),
                        level=str(row.get("level") or "info"),
                        message=str(row.get("message") or ""),
                        user_email=str(row.get("user_email") or ""),
                        job_id=str(row.get("job_id") or ""),
                        context_json=str(row.get("context_json") or ""),
                        error_body=str(row.get("error_body") or ""),
                    )
                )
            db.commit()
    except Exception:
        # Never crash app behavior because log persistence fails.
        pass


def _worker() -> None:
    while True:
        if _writer_stop.is_set() and _queue.empty():
            break
        try:
            first = _queue.get(timeout=0.25)
        except queue.Empty:
            continue
        batch = [first]
        # Burst-drain up to 100 rows for fewer DB commits.
        while len(batch) < 100:
            try:
                batch.append(_queue.get_nowait())
            except queue.Empty:
                break
        _persist_rows(batch)


def start() -> None:
    global _writer_started, _writer_thread
    with _writer_lock:
        if _writer_started:
            return
        _writer_stop.clear()
        _writer_thread = threading.Thread(target=_worker, name="app-log-writer", daemon=True)
        _writer_thread.start()
        log_buffer.register_persistent_hook(_ingest_buffer_line)
        _writer_started = True
    atexit.register(stop)


def stop() -> None:
    global _writer_started
    with _writer_lock:
        if not _writer_started:
            return
        _writer_stop.set()
        thread = _writer_thread
    if thread is not None:
        thread.join(timeout=2.0)
    # Final best-effort drain to avoid losing tail events on shutdown.
    drained: list[dict[str, Any]] = []
    while True:
        try:
            drained.append(_queue.get_nowait())
        except queue.Empty:
            break
        if len(drained) >= 200:
            _persist_rows(drained)
            drained = []
    if drained:
        _persist_rows(drained)
    _writer_started = False


def _enqueue(row: dict[str, Any]) -> None:
    try:
        _queue.put_nowait(row)
    except queue.Full:
        _persist_rows([row])


def _ingest_buffer_line(line: log_buffer.LogLine) -> None:
    # Buffer lines from print()/logging become persistent automatically.
    _enqueue(
        {
            "ts": datetime.utcnow(),
            "trace_id": str(line.trace_id or ""),
            "service": str(line.service or "backend"),
            "source": str(line.source or "stdout"),
            "component": str(line.component or ""),
            "category": _normalize_category(line.category or infer_category(line.text, source=line.source, component=line.component)),
            "level": _normalize_level(line.level),
            "message": str(line.text or ""),
            "user_email": _normalize_email(line.user_email),
            "job_id": str(line.job_id or ""),
            "context_json": str(line.context_json or ""),
            "error_body": "",
        }
    )


def emit(
    message: str,
    *,
    level: str = "info",
    category: str = "",
    source: str = "system",
    component: str = "",
    service: str = "backend",
    user_email: str = "",
    trace_id: str = "",
    job_id: str = "",
    context: Any = None,
    error_body: str = "",
    stream: bool = True,
) -> None:
    msg = str(message or "").strip()
    if not msg and not error_body:
        return
    resolved_level = _normalize_level(level)
    resolved_source = str(source or "system").strip().lower() or "system"
    resolved_component = str(component or "").strip()
    resolved_trace = str(trace_id or current_trace_id()).strip()
    resolved_user = _normalize_email(user_email or current_user_email())
    resolved_category = _normalize_category(
        category or infer_category(msg, source=resolved_source, component=resolved_component)
    )
    context_json = _safe_json(context) if context is not None else ""
    payload = {
        "ts": datetime.utcnow(),
        "trace_id": resolved_trace,
        "service": str(service or "backend"),
        "source": resolved_source,
        "component": resolved_component,
        "category": resolved_category,
        "level": resolved_level,
        "message": msg,
        "user_email": resolved_user,
        "job_id": str(job_id or ""),
        "context_json": context_json,
        "error_body": str(error_body or ""),
    }
    _enqueue(payload)

    if stream:
        try:
            log_buffer.emit(
                msg,
                level=resolved_level,
                category=resolved_category,
                source=resolved_source,
                component=resolved_component,
                trace_id=resolved_trace,
                user_email=resolved_user,
                service=str(service or "backend"),
                context_json=context_json,
                job_id=str(job_id or "") or None,
                persist=False,
            )
        except Exception:
            pass


def emit_exception(
    exc: BaseException,
    *,
    message: str = "Unhandled exception",
    category: str = "",
    source: str = "system",
    component: str = "",
    service: str = "backend",
    user_email: str = "",
    trace_id: str = "",
    job_id: str = "",
    context: Any = None,
    stream: bool = True,
) -> None:
    tb = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
    emit(
        f"{message}: {exc}",
        level="error",
        category=category or "system",
        source=source,
        component=component,
        service=service,
        user_email=user_email,
        trace_id=trace_id,
        job_id=job_id,
        context=context,
        error_body=tb,
        stream=stream,
    )


def log_http_access(
    *,
    method: str,
    path: str,
    status_code: int,
    duration_ms: float,
    user_email: str = "",
    trace_id: str = "",
    context: dict[str, Any] | None = None,
) -> None:
    level = "error" if status_code >= 500 else "warn" if status_code >= 400 else "info"
    msg = f"{method.upper()} {path} -> {int(status_code)} ({duration_ms:.1f}ms)"
    data = {
        "method": method.upper(),
        "path": path,
        "status_code": int(status_code),
        "duration_ms": round(float(duration_ms), 2),
    }
    if context:
        data.update(context)
    emit(
        msg,
        level=level,
        category="http",
        source="http",
        component="fastapi",
        user_email=user_email,
        trace_id=trace_id,
        context=data,
        stream=True,
    )


def new_trace_id() -> str:
    return uuid.uuid4().hex


def timed_ms(start_monotonic: float) -> float:
    return max(0.0, (monotonic() - start_monotonic) * 1000.0)
