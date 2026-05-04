from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any


_RUN_ACTIVE_STATES = {
    "running",
    "loading",
    "started",
    "in_progress",
    "queued",
    "preparing",
    "retrying",
}
_RUN_DONE_STATES = {"done", "completed", "success", "ok", "finished", "pass", "cached"}
_RUN_FAILED_STATES = {"failed", "error", "fail"}
_RUN_CANCELLED_STATES = {"cancelled", "canceled"}

_STEP_ACTIVE_STATES = {"running", "loading", "started", "in_progress", "preparing", "retrying", "queued"}


def normalize_state_token(raw: Any) -> str:
    return (
        str(raw or "")
        .strip()
        .lower()
        .replace(" ", "_")
        .replace("-", "_")
    )


def is_failed_like(status: Any) -> bool:
    s = normalize_state_token(status)
    return s in _RUN_FAILED_STATES or "exception" in s


def is_cancelled_like(status: Any) -> bool:
    s = normalize_state_token(status)
    return s in _RUN_CANCELLED_STATES or "cancel" in s or "abort" in s or "stop" in s


def is_done_like(status: Any) -> bool:
    return normalize_state_token(status) in _RUN_DONE_STATES


def is_active_run_like(status: Any) -> bool:
    return normalize_state_token(status) in _RUN_ACTIVE_STATES


def is_terminal_run_like(status: Any) -> bool:
    return is_done_like(status) or is_failed_like(status) or is_cancelled_like(status)


def _safe_steps_list(raw_steps_json: Any) -> list[dict[str, Any]]:
    if raw_steps_json is None:
        return []
    parsed: Any = raw_steps_json
    if isinstance(raw_steps_json, str):
        raw = raw_steps_json.strip()
        if not raw:
            return []
        try:
            parsed = json.loads(raw)
        except Exception:
            return []
    if not isinstance(parsed, list):
        return []
    out: list[dict[str, Any]] = []
    for row in parsed:
        if isinstance(row, dict):
            out.append(row)
    return out


def derive_effective_run_status(
    *,
    base_status: Any,
    steps_json: Any,
    finished_at: Any = None,
) -> str:
    """
    Derive a canonical run status from base row status + step states.
    Mirrors frontend logic and adds one extra rule:
    - when no step is active and all known steps are done-like, promote to done.
    """
    base = normalize_state_token(base_status)
    finished = finished_at is not None

    steps = _safe_steps_list(steps_json)
    step_states = [
        normalize_state_token(step.get("state") or step.get("status") or "")
        for step in steps
    ]
    step_states = [s for s in step_states if s]

    has_failed_step = any(is_failed_like(s) for s in step_states)
    has_cancelled_step = any(is_cancelled_like(s) for s in step_states)
    has_active_step = any(s in _STEP_ACTIVE_STATES for s in step_states)
    all_done_steps = bool(step_states) and all(is_done_like(s) for s in step_states)

    base_is_retry = base == "retrying"
    base_is_live = base in {"running", "preparing", "queued", "retrying"}
    run_is_active = is_active_run_like(base) and (not finished)

    # Manual retry/requeue should surface immediately even if stale failed
    # step states still exist from a previous attempt.
    if base_is_retry:
        return "retrying"

    # Real-status overrides for stale active rows.
    if (not has_active_step) and all_done_steps:
        return "done"
    if (not has_active_step) and has_failed_step:
        return "failed"
    if (not has_active_step) and has_cancelled_step:
        return "cancelled"
    if base_is_live and (not finished):
        return base

    if has_cancelled_step:
        return "cancelled"
    if has_failed_step:
        return "failed"
    if all_done_steps:
        return "done"
    if has_active_step and (not run_is_active):
        return "cancelled"
    return base or str(base_status or "").strip().lower()


def reconcile_run_row_status(row: Any) -> tuple[str, bool]:
    """
    Best-effort DB row reconciliation. Returns (effective_status, changed).
    Only promotes active base statuses to terminal statuses.
    """
    base = normalize_state_token(getattr(row, "status", ""))
    effective = derive_effective_run_status(
        base_status=base,
        steps_json=getattr(row, "steps_json", ""),
        finished_at=getattr(row, "finished_at", None),
    )
    changed = False
    if is_active_run_like(base) and is_terminal_run_like(effective) and (effective != base):
        setattr(row, "status", effective)
        if getattr(row, "finished_at", None) is None:
            setattr(row, "finished_at", datetime.now(timezone.utc).replace(tzinfo=None))
        changed = True
    return effective, changed

