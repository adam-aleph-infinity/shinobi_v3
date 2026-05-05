"""Tests for the ops summary metrics logic.

TDD: written before the implementation exists.
"""
import json
import pytest
from datetime import datetime, timedelta
from sqlmodel import SQLModel, create_engine, Session
from sqlalchemy.pool import StaticPool

import ui.backend.models.pipeline_run  # noqa: F401


@pytest.fixture(scope="function")
def db_engine():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    return engine


@pytest.fixture(scope="function")
def db_session(db_engine):
    with Session(db_engine) as session:
        yield session


def _run(run_id: str, status: str, started_at: datetime | None = None, run_origin: str = "webhook"):
    from ui.backend.models.pipeline_run import PipelineRun
    return PipelineRun(
        id=run_id,
        pipeline_id="pipe1",
        pipeline_name="P",
        sales_agent="a",
        customer="c",
        call_id="x",
        started_at=started_at or datetime.utcnow(),
        status=status,
        run_origin=run_origin,
        note_sent=False,
        canvas_json="{}",
        steps_json="[]",
        log_json="[]",
        review_required=False,
    )


# ── stall detection ──────────────────────────────────────────────────────────

def test_stalled_run_detected_when_running_too_long(db_session):
    from ui.backend.lib.ops_metrics import count_stalled_runs

    old_start = datetime.utcnow() - timedelta(minutes=20)
    db_session.add(_run("r1", status="running", started_at=old_start))
    db_session.commit()

    assert count_stalled_runs(db_session, stall_minutes=10) == 1


def test_recent_running_run_not_counted_as_stalled(db_session):
    from ui.backend.lib.ops_metrics import count_stalled_runs

    db_session.add(_run("r2", status="running", started_at=datetime.utcnow()))
    db_session.commit()

    assert count_stalled_runs(db_session, stall_minutes=10) == 0


def test_done_run_not_counted_as_stalled(db_session):
    from ui.backend.lib.ops_metrics import count_stalled_runs

    old_start = datetime.utcnow() - timedelta(minutes=20)
    db_session.add(_run("r3", status="done", started_at=old_start))
    db_session.commit()

    assert count_stalled_runs(db_session, stall_minutes=10) == 0


# ── failure rate ─────────────────────────────────────────────────────────────

def test_failure_rate_zero_when_all_succeed(db_session):
    from ui.backend.lib.ops_metrics import recent_failure_rate

    for i in range(5):
        db_session.add(_run(f"ok{i}", status="done"))
    db_session.commit()

    assert recent_failure_rate(db_session, lookback_hours=1) == 0.0


def test_failure_rate_one_hundred_when_all_fail(db_session):
    from ui.backend.lib.ops_metrics import recent_failure_rate

    for i in range(3):
        db_session.add(_run(f"fail{i}", status="error"))
    db_session.commit()

    assert recent_failure_rate(db_session, lookback_hours=1) == 100.0


def test_failure_rate_fifty_percent_on_mixed(db_session):
    from ui.backend.lib.ops_metrics import recent_failure_rate

    db_session.add(_run("ok1", status="done"))
    db_session.add(_run("ok2", status="done"))
    db_session.add(_run("bad1", status="error"))
    db_session.add(_run("bad2", status="error"))
    db_session.commit()

    assert recent_failure_rate(db_session, lookback_hours=1) == 50.0


def test_failure_rate_zero_when_no_runs(db_session):
    from ui.backend.lib.ops_metrics import recent_failure_rate

    assert recent_failure_rate(db_session, lookback_hours=1) == 0.0


# ── pending review count ─────────────────────────────────────────────────────

def test_pending_review_count(db_session):
    from ui.backend.lib.ops_metrics import count_pending_reviews
    from ui.backend.models.pipeline_run import PipelineRun

    r = _run("rev1", status="done")
    r.review_required = True
    r.review_status = None
    db_session.add(r)
    db_session.commit()

    assert count_pending_reviews(db_session) == 1
