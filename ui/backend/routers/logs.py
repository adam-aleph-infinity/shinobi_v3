import asyncio
import json
from typing import Any

from fastapi import APIRouter, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import func
from sqlmodel import Session, select

from ui.backend.database import engine
from ui.backend.models.app_log import AppLog
from ui.backend.services import log_buffer

router = APIRouter(prefix="/logs", tags=["logs"])


@router.delete("/buffer")
def clear_buffer():
    """Clear the in-memory log buffer."""
    log_buffer.clear()
    return {"cleared": True}


def _serialize_buffer_line(line: log_buffer.LogLine) -> dict[str, Any]:
    return {
        "ts": line.ts,
        "text": line.text,
        "level": line.level,
        "job_id": line.job_id,
        "category": line.category,
        "source": line.source,
        "component": line.component,
        "trace_id": line.trace_id,
        "user_email": line.user_email,
        "service": line.service,
        "context_json": line.context_json,
    }


@router.get("/recent")
def get_recent(n: int = 300):
    return [_serialize_buffer_line(l) for l in log_buffer.get_recent(n)]


def _parse_context(raw: str) -> Any:
    text = str(raw or "").strip()
    if not text:
        return {}
    try:
        return json.loads(text)
    except Exception:
        return {"raw": text}


@router.get("/app/recent")
def app_recent(
    limit: int = Query(300, ge=1, le=5000),
    since_id: int = Query(0, ge=0),
    level: str = Query(""),
    category: str = Query(""),
    source: str = Query(""),
    component: str = Query(""),
    service: str = Query(""),
    trace_id: str = Query(""),
    user_email: str = Query(""),
    text: str = Query(""),
    job_id: str = Query(""),
):
    with Session(engine) as db:
        stmt = select(AppLog)

        if since_id > 0:
            stmt = stmt.where(AppLog.id > since_id)
        if level:
            stmt = stmt.where(AppLog.level == level.strip().lower())
        if category:
            stmt = stmt.where(AppLog.category == category.strip().lower())
        if source:
            stmt = stmt.where(AppLog.source == source.strip().lower())
        if component:
            stmt = stmt.where(AppLog.component == component.strip())
        if service:
            stmt = stmt.where(AppLog.service == service.strip().lower())
        if trace_id:
            stmt = stmt.where(AppLog.trace_id == trace_id.strip())
        if user_email:
            stmt = stmt.where(AppLog.user_email == user_email.strip().lower())
        if job_id:
            stmt = stmt.where(AppLog.job_id == job_id.strip())
        if text:
            stmt = stmt.where(func.lower(AppLog.message).like(f"%{text.strip().lower()}%"))

        if since_id > 0:
            stmt = stmt.order_by(AppLog.id.asc()).limit(limit)
            rows = db.exec(stmt).all()
        else:
            stmt = stmt.order_by(AppLog.id.desc()).limit(limit)
            rows = list(reversed(db.exec(stmt).all()))

    return [
        {
            "id": row.id,
            "ts": row.ts.isoformat() if row.ts else "",
            "trace_id": row.trace_id,
            "service": row.service,
            "source": row.source,
            "component": row.component,
            "category": row.category,
            "level": row.level,
            "message": row.message,
            "user_email": row.user_email,
            "job_id": row.job_id,
            "context": _parse_context(row.context_json),
            "error_body": row.error_body,
        }
        for row in rows
    ]


@router.get("/stream")
async def stream_logs():
    async def generator():
        # Send backlog (last 500 lines already in buffer)
        backlog = log_buffer.get_recent(500)
        last_seq = backlog[-1].seq if backlog else 0
        for line in backlog:
            yield f"data: {json.dumps(_serialize_buffer_line(line))}\n\n"

        # Poll for new lines every 0.3 s — no asyncio.Queue, no call_soon_threadsafe
        heartbeat_ticks = 0
        while True:
            await asyncio.sleep(0.3)
            new_lines = log_buffer.get_after(last_seq)
            for line in new_lines:
                last_seq = line.seq
                yield f"data: {json.dumps(_serialize_buffer_line(line))}\n\n"
            heartbeat_ticks += 1
            if heartbeat_ticks >= 100:  # ~30 s
                heartbeat_ticks = 0
                yield "data: {\"heartbeat\": true}\n\n"

    return StreamingResponse(
        generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
