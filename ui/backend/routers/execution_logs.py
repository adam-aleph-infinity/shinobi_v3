from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from ui.backend.services import execution_logs

router = APIRouter(prefix="/execution-logs", tags=["execution-logs"])


class ClientExecutionEventIn(BaseModel):
    session_id: str = ""
    action: str = "client_event"
    source: str = "frontend"
    status: str = "running"
    level: str = "info"
    message: str = ""
    context: dict[str, Any] = {}
    data: dict[str, Any] = {}
    report: dict[str, Any] = {}
    error: str = ""
    client_local_time: str = ""
    client_timezone: str = ""
    finish: bool = False


@router.get("/recent")
def recent_execution_logs(
    limit: int = Query(100, ge=1, le=2000),
    action: str = Query(""),
    source: str = Query(""),
):
    return execution_logs.list_recent(limit=limit, action=action, source=source)


@router.get("/{session_id}")
def get_execution_log(session_id: str):
    row = execution_logs.get_session(session_id)
    if not row:
        raise HTTPException(404, "Execution log session not found")
    return row


@router.post("/client-event")
def client_execution_event(req: ClientExecutionEventIn):
    sid = execution_logs.start_session(
        action=req.action,
        source=req.source or "frontend",
        context=req.context,
        session_id=req.session_id,
        client_local_time=req.client_local_time,
        client_timezone=req.client_timezone,
        status=req.status or "running",
    )
    if req.message or req.data or req.error:
        execution_logs.append_event(
            sid,
            req.message or "client event",
            level=req.level or "info",
            status=req.status or "",
            data=req.data,
            error=req.error,
            client_local_time=req.client_local_time,
        )
    if req.report:
        execution_logs.set_report(sid, req.report)

    if req.finish or str(req.status or "").lower() in ("success", "failed", "cancelled"):
        execution_logs.finish_session(
            sid,
            status=req.status or "success",
            report=req.report or None,
            error=req.error or "",
        )
    return {"ok": True, "session_id": sid}

