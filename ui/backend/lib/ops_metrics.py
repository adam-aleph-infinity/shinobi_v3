from datetime import datetime, timedelta
from sqlmodel import Session, select, func

from ui.backend.models.pipeline_run import PipelineRun

_SUCCESS_STATUSES = {"done", "completed", "success", "ok", "finished", "cached"}
_INFLIGHT_STATUSES = {"queued", "running", "retrying", "preparing"}


def count_stalled_runs(db: Session, stall_minutes: int = 15) -> int:
    cutoff = datetime.utcnow() - timedelta(minutes=stall_minutes)
    stmt = (
        select(func.count())
        .select_from(PipelineRun)
        .where(PipelineRun.status == "running")
        .where(PipelineRun.started_at < cutoff)
    )
    return db.exec(stmt).one() or 0


def recent_failure_rate(db: Session, lookback_hours: int = 24) -> float:
    """Return failure percentage (0-100) for terminal runs in the lookback window."""
    cutoff = datetime.utcnow() - timedelta(hours=lookback_hours)
    stmt = (
        select(PipelineRun.status)
        .where(PipelineRun.started_at >= cutoff)
        .where(~PipelineRun.status.in_(list(_INFLIGHT_STATUSES)))
    )
    statuses = db.exec(stmt).all()
    if not statuses:
        return 0.0
    failed = sum(1 for s in statuses if s not in _SUCCESS_STATUSES)
    return round(failed / len(statuses) * 100, 1)


def count_pending_reviews(db: Session) -> int:
    stmt = (
        select(func.count())
        .select_from(PipelineRun)
        .where(PipelineRun.review_required == True)  # noqa: E712
        .where(
            (PipelineRun.review_status == None)  # noqa: E711
            | (PipelineRun.review_status == "pending")
        )
    )
    return db.exec(stmt).one() or 0


def get_ops_summary(db: Session) -> dict:
    return {
        "stalled_runs": count_stalled_runs(db),
        "pending_reviews": count_pending_reviews(db),
        "failure_rate_24h": recent_failure_rate(db, lookback_hours=24),
        "failure_rate_1h": recent_failure_rate(db, lookback_hours=1),
    }
