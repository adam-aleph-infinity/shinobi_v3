from datetime import datetime
from typing import Any
from sqlmodel import Session, select

from ui.backend.models.pipeline_run import PipelineRun

_VALID_ACTIONS = {"approve", "reject"}


def get_review_queue(db: Session) -> list[dict[str, Any]]:
    """Return runs flagged for review that haven't been actioned yet."""
    stmt = (
        select(PipelineRun)
        .where(PipelineRun.review_required == True)  # noqa: E712
        .where(
            (PipelineRun.review_status == None)  # noqa: E711
            | (PipelineRun.review_status == "pending")
        )
        .order_by(PipelineRun.started_at.desc())
        .limit(200)
    )
    rows = db.exec(stmt).all()
    return [_run_to_dict(r) for r in rows]


def apply_review_decision(
    run_id: str,
    action: str,
    reason: str,
    db: Session,
) -> dict[str, Any]:
    if action not in _VALID_ACTIONS:
        return {"ok": False, "error": f"Invalid action '{action}'. Use 'approve' or 'reject'."}

    run = db.get(PipelineRun, run_id)
    if run is None:
        return {"ok": False, "error": f"Run '{run_id}' not found."}

    run.review_status = "approved" if action == "approve" else "rejected"
    run.review_note = reason or None
    run.reviewed_at = datetime.utcnow()
    db.add(run)
    db.commit()
    db.refresh(run)
    return {"ok": True, "run_id": run_id, "review_status": run.review_status}


def _run_to_dict(r: PipelineRun) -> dict[str, Any]:
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
        "note_sent": r.note_sent,
        "review_required": r.review_required,
        "review_status": r.review_status,
        "review_note": r.review_note,
        "reviewed_at": r.reviewed_at.isoformat() if r.reviewed_at else None,
        "steps_json": r.steps_json,
    }
