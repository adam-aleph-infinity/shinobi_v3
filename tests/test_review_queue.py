"""Tests for the review queue endpoints.

TDD: written before the endpoints exist.
Uses an in-memory SQLite DB so no external state is needed.
"""
import json
import pytest
from datetime import datetime
from fastapi.testclient import TestClient
from sqlmodel import SQLModel, create_engine, Session
from sqlalchemy.pool import StaticPool

# Import models so SQLModel.metadata is populated before create_all
import ui.backend.models.pipeline_run  # noqa: F401


# ── Fixtures ────────────────────────────────────────────────────────────────

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


def _make_run(run_id: str, review_required: bool = True, review_status: str | None = None,
              note_id: str = "", note_sent: bool = False) -> dict:
    return {
        "id": run_id,
        "pipeline_id": "pipe1",
        "pipeline_name": "Test Pipeline",
        "sales_agent": "agent1",
        "customer": "customer1",
        "call_id": "call1",
        "started_at": datetime.utcnow(),
        "status": "done",
        "run_origin": "webhook",
        "note_sent": note_sent,
        "canvas_json": "{}",
        "steps_json": json.dumps([{"note_id": note_id}]) if note_id else "[]",
        "log_json": "[]",
        "review_required": review_required,
        "review_status": review_status,
    }


# ── review queue list ────────────────────────────────────────────────────────

def test_pending_runs_appear_in_review_queue(db_session):
    from ui.backend.models.pipeline_run import PipelineRun
    from ui.backend.lib.review_queue import get_review_queue

    run = PipelineRun(**_make_run("run-1", review_required=True, review_status=None))
    db_session.add(run)
    db_session.commit()

    items = get_review_queue(db_session)
    assert len(items) == 1
    assert items[0]["id"] == "run-1"


def test_approved_runs_excluded_from_review_queue(db_session):
    from ui.backend.models.pipeline_run import PipelineRun
    from ui.backend.lib.review_queue import get_review_queue

    run = PipelineRun(**_make_run("run-2", review_required=True, review_status="approved"))
    db_session.add(run)
    db_session.commit()

    assert get_review_queue(db_session) == []


def test_rejected_runs_excluded_from_review_queue(db_session):
    from ui.backend.models.pipeline_run import PipelineRun
    from ui.backend.lib.review_queue import get_review_queue

    run = PipelineRun(**_make_run("run-3", review_required=True, review_status="rejected"))
    db_session.add(run)
    db_session.commit()

    assert get_review_queue(db_session) == []


def test_non_review_runs_excluded_from_queue(db_session):
    from ui.backend.models.pipeline_run import PipelineRun
    from ui.backend.lib.review_queue import get_review_queue

    run = PipelineRun(**_make_run("run-4", review_required=False, review_status=None))
    db_session.add(run)
    db_session.commit()

    assert get_review_queue(db_session) == []


# ── review action ────────────────────────────────────────────────────────────

def test_reject_action_sets_rejected_status(db_session):
    from ui.backend.models.pipeline_run import PipelineRun
    from ui.backend.lib.review_queue import apply_review_decision

    run = PipelineRun(**_make_run("run-5", review_required=True, review_status=None))
    db_session.add(run)
    db_session.commit()

    result = apply_review_decision(
        run_id="run-5", action="reject", reason="Insufficient data", db=db_session
    )

    assert result["ok"] is True
    db_session.expire_all()
    updated = db_session.get(PipelineRun, "run-5")
    assert updated.review_status == "rejected"
    assert updated.reviewed_at is not None


def test_approve_action_sets_approved_status(db_session):
    from ui.backend.models.pipeline_run import PipelineRun
    from ui.backend.lib.review_queue import apply_review_decision

    run = PipelineRun(**_make_run("run-6", review_required=True, review_status=None))
    db_session.add(run)
    db_session.commit()

    result = apply_review_decision(
        run_id="run-6", action="approve", reason="Looks good", db=db_session
    )

    assert result["ok"] is True
    db_session.expire_all()
    updated = db_session.get(PipelineRun, "run-6")
    assert updated.review_status == "approved"
    assert updated.reviewed_at is not None


def test_review_decision_on_missing_run_returns_error(db_session):
    from ui.backend.lib.review_queue import apply_review_decision

    result = apply_review_decision(
        run_id="nonexistent", action="approve", reason="", db=db_session
    )
    assert result["ok"] is False


def test_invalid_action_returns_error(db_session):
    from ui.backend.models.pipeline_run import PipelineRun
    from ui.backend.lib.review_queue import apply_review_decision

    run = PipelineRun(**_make_run("run-7", review_required=True, review_status=None))
    db_session.add(run)
    db_session.commit()

    result = apply_review_decision(
        run_id="run-7", action="maybe", reason="", db=db_session
    )
    assert result["ok"] is False
