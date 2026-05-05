"""Ops dashboard — queue health, stall detection, failure rates, pending reviews."""
from datetime import datetime, timedelta
from typing import Any

from fastapi import APIRouter, Depends, Query
from sqlmodel import Session, select

from ui.backend.database import get_session
from ui.backend.lib.ops_metrics import get_ops_summary, count_stalled_runs, recent_failure_rate
from ui.backend.models.pipeline_run import PipelineRun

router = APIRouter(prefix="/ops", tags=["ops"])

_SUCCESS_STATUSES = {"done", "completed", "success", "ok", "finished", "cached"}
_INFLIGHT_STATUSES = {"queued", "running", "retrying", "preparing"}


@router.get("/summary")
def ops_summary(db: Session = Depends(get_session)):
    """Aggregated health metrics: stalled runs, failure rates, pending review count."""
    return get_ops_summary(db)


@router.get("/recent-runs")
def recent_runs(
    limit: int = Query(default=50, le=200),
    db: Session = Depends(get_session),
):
    """Last N runs (all origins) for the control center table."""
    stmt = (
        select(PipelineRun)
        .order_by(PipelineRun.started_at.desc())
        .limit(limit)
    )
    rows = db.exec(stmt).all()
    return {"runs": [_run_row(r) for r in rows]}


@router.get("/stalled")
def stalled_runs(
    stall_minutes: int = Query(default=15, ge=1),
    db: Session = Depends(get_session),
):
    """Runs stuck in 'running' state beyond stall_minutes threshold."""
    cutoff = datetime.utcnow() - timedelta(minutes=stall_minutes)
    stmt = (
        select(PipelineRun)
        .where(PipelineRun.status == "running")
        .where(PipelineRun.started_at < cutoff)
        .order_by(PipelineRun.started_at.asc())
    )
    rows = db.exec(stmt).all()
    return {"stalled": [_run_row(r) for r in rows], "count": len(rows)}


def _run_row(r: PipelineRun) -> dict[str, Any]:
    return {
        "id": r.id,
        "pipeline_id": r.pipeline_id,
        "pipeline_name": r.pipeline_name,
        "sales_agent": r.sales_agent,
        "customer": r.customer,
        "call_id": r.call_id,
        "started_at": r.started_at.isoformat() if r.started_at else None,
        "finished_at": r.finished_at.isoformat() if r.finished_at else None,
        "status": r.status,
        "run_origin": r.run_origin,
        "note_sent": r.note_sent,
        "review_required": r.review_required,
        "review_status": r.review_status,
    }
