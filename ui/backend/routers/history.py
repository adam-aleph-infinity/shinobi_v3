"""Global pipeline execution history — all runs across all pipelines."""
from fastapi import APIRouter, Depends, Query
from sqlmodel import Session, select

from ui.backend.database import get_session

router = APIRouter(prefix="/history", tags=["history"])


@router.get("/runs")
def list_runs(
    sales_agent: str = Query(""),
    customer: str = Query(""),
    pipeline_id: str = Query(""),
    limit: int = Query(100),
    db: Session = Depends(get_session),
):
    """Return recent pipeline runs, newest first."""
    from ui.backend.models.pipeline_run import PipelineRun as PR

    stmt = select(PR)
    if sales_agent:  stmt = stmt.where(PR.sales_agent == sales_agent)
    if customer:     stmt = stmt.where(PR.customer == customer)
    if pipeline_id:  stmt = stmt.where(PR.pipeline_id == pipeline_id)
    stmt = stmt.order_by(PR.started_at.desc()).limit(limit)
    rows = db.exec(stmt).all()
    return [
        {
            "id": r.id,
            "pipeline_id": r.pipeline_id,
            "pipeline_name": r.pipeline_name,
            "sales_agent": r.sales_agent,
            "customer": r.customer,
            "call_id": r.call_id,
            "started_at": r.started_at.isoformat() if r.started_at else None,
            "finished_at": r.finished_at.isoformat() if r.finished_at else None,
            "status": r.status,
            "canvas_json": r.canvas_json,
            "steps_json": r.steps_json,
            "log_json": r.log_json,
        }
        for r in rows
    ]
