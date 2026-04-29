"""Global pipeline execution history — all runs across all pipelines."""
import json
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlmodel import Session, select

from ui.backend.config import settings
from ui.backend.database import get_session

router = APIRouter(prefix="/history", tags=["history"])
_WEBHOOK_INBOX_DIR = settings.ui_data_dir / "_webhooks" / "inbox"


def _norm_ci(value: Any) -> str:
    return str(value or "").strip().lower()


def _parse_iso_utc(raw: Any) -> Optional[datetime]:
    s = str(raw or "").strip()
    if not s:
        return None
    if s.endswith("Z"):
        s = f"{s[:-1]}+00:00"
    try:
        dt = datetime.fromisoformat(s)
    except Exception:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _normalize_run_origin(value: Any) -> str:
    v = str(value or "").strip().lower()
    if v in {"webhook", "production"}:
        return "webhook"
    if v in {"local", "test"}:
        return "local"
    return ""


def _extract_run_origin_from_steps_json(steps_json: Any) -> str:
    raw = str(steps_json or "").strip()
    if not raw:
        return ""
    try:
        parsed = json.loads(raw)
    except Exception:
        return ""
    if not isinstance(parsed, list):
        return ""
    for row in parsed:
        if not isinstance(row, dict):
            continue
        origin = _normalize_run_origin(row.get("run_origin"))
        if origin:
            return origin
    return ""


def _load_webhook_event_index(limit_files: int = 5000) -> tuple[dict[tuple[str, str, str], list[float]], dict[str, list[float]]]:
    by_key: dict[tuple[str, str, str], list[float]] = {}
    by_call: dict[str, list[float]] = {}
    if not _WEBHOOK_INBOX_DIR.exists():
        return by_key, by_call
    try:
        files = sorted(
            _WEBHOOK_INBOX_DIR.glob("*.json"),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )[: max(100, min(int(limit_files or 5000), 20000))]
    except Exception:
        return by_key, by_call

    for fp in files:
        try:
            doc = json.loads(fp.read_text(encoding="utf-8"))
            payload = doc.get("payload") if isinstance(doc.get("payload"), dict) else {}
            call_id = _norm_ci(payload.get("call_id"))
            if not call_id:
                continue
            agent = _norm_ci(payload.get("agent"))
            customer = _norm_ci(payload.get("customer"))
            received = _parse_iso_utc(doc.get("received_at"))
            ts = (
                float(received.timestamp())
                if received is not None
                else float(fp.stat().st_mtime)
            )
            if agent and customer:
                key = (call_id, agent, customer)
                by_key.setdefault(key, []).append(ts)
            by_call.setdefault(call_id, []).append(ts)
        except Exception:
            continue

    return by_key, by_call


def _matches_webhook_event(
    *,
    started_at: Optional[datetime],
    call_id: str,
    agent: str,
    customer: str,
    by_key: dict[tuple[str, str, str], list[float]],
    by_call: dict[str, list[float]],
) -> bool:
    if started_at is None:
        return False
    call_norm = _norm_ci(call_id)
    if not call_norm:
        return False
    start_ts = float(started_at.timestamp())
    # Webhook is received first, then transcription may run for minutes before pipeline starts.
    window_start = start_ts - (2 * 60 * 60)  # 2h before run start
    window_end = start_ts + (3 * 60)         # small clock drift tolerance

    def _hit(values: list[float]) -> bool:
        for ts in values:
            if window_start <= ts <= window_end:
                return True
        return False

    key = (call_norm, _norm_ci(agent), _norm_ci(customer))
    if key in by_key and _hit(by_key[key]):
        return True
    if call_norm in by_call and _hit(by_call[call_norm]):
        return True
    return False


@router.get("/runs")
def list_runs(
    sales_agent: str = Query(""),
    customer: str = Query(""),
    pipeline_id: str = Query(""),
    call_id: str = Query(""),
    status: str = Query(""),
    crm_url: str = Query(""),
    date_from: str = Query(""),
    date_to: str = Query(""),
    sort_by: str = Query("started_at"),
    sort_dir: str = Query("desc"),
    limit: int = Query(200, ge=1, le=2000),
    db: Session = Depends(get_session),
):
    """Return recent pipeline runs, newest first."""
    from ui.backend.models.pipeline_run import PipelineRun as PR
    from ui.backend.models.crm import CRMCall, CRMPair

    stmt = select(PR)

    def parse_dt(raw: str, field_name: str) -> Optional[datetime]:
        s = str(raw or "").strip()
        if not s:
            return None
        if s.endswith("Z"):
            s = f"{s[:-1]}+00:00"
        try:
            dt = datetime.fromisoformat(s)
        except ValueError as exc:
            raise HTTPException(400, f"Invalid {field_name} (expected ISO date/time)") from exc
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc).replace(tzinfo=None)

    if sales_agent:
        stmt = stmt.where(PR.sales_agent == sales_agent)
    if customer:
        stmt = stmt.where(PR.customer == customer)
    if pipeline_id:
        stmt = stmt.where(PR.pipeline_id == pipeline_id)
    if call_id:
        stmt = stmt.where(PR.call_id == call_id)
    if status:
        status_values = [s.strip().lower() for s in str(status).split(",") if s.strip()]
        if status_values:
            stmt = stmt.where(PR.status.in_(status_values))

    from_dt = parse_dt(date_from, "date_from")
    to_dt = parse_dt(date_to, "date_to")
    if from_dt is not None:
        stmt = stmt.where(PR.started_at >= from_dt)
    if to_dt is not None:
        stmt = stmt.where(PR.started_at <= to_dt)

    sort_key = str(sort_by or "started_at").strip().lower()
    sort_desc = str(sort_dir or "desc").strip().lower() != "asc"
    sort_cols = {
        "started_at": PR.started_at,
        "finished_at": PR.finished_at,
        "pipeline_name": PR.pipeline_name,
        "sales_agent": PR.sales_agent,
        "customer": PR.customer,
        "status": PR.status,
        "call_id": PR.call_id,
    }
    sort_col = sort_cols.get(sort_key, PR.started_at)
    stmt = stmt.order_by(sort_col.desc() if sort_desc else sort_col.asc()).limit(limit)
    rows = db.exec(stmt).all()

    def norm(v: str) -> str:
        return str(v or "").strip().lower()

    # Prefetch CRM call mappings for run call IDs (best-effort).
    call_ids = list({str(r.call_id or "").strip() for r in rows if str(r.call_id or "").strip()})
    call_rows = []
    if call_ids:
        try:
            call_rows = db.exec(select(CRMCall).where(CRMCall.call_id.in_(call_ids))).all()
        except Exception:
            call_rows = []

    crm_by_call_triplet: dict[tuple[str, str, str], str] = {}
    crm_by_call_id: dict[str, str] = {}
    for c in call_rows:
        c_call = norm(c.call_id)
        c_agent = norm(c.agent)
        c_customer = norm(c.customer)
        c_url = str(c.crm_url or "").strip()
        if not c_call or not c_url:
            continue
        crm_by_call_triplet[(c_call, c_agent, c_customer)] = c_url
        crm_by_call_id.setdefault(c_call, c_url)

    crm_by_pair_cache: dict[tuple[str, str], str] = {}
    webhook_idx_loaded = False
    webhook_by_key: dict[tuple[str, str, str], list[float]] = {}
    webhook_by_call: dict[str, list[float]] = {}

    def ensure_webhook_idx() -> None:
        nonlocal webhook_idx_loaded, webhook_by_key, webhook_by_call
        if webhook_idx_loaded:
            return
        webhook_by_key, webhook_by_call = _load_webhook_event_index()
        webhook_idx_loaded = True

    out_rows = []
    for r in rows:
        call_key = norm(r.call_id)
        pair_key = (norm(r.sales_agent), norm(r.customer))
        resolved_crm = (
            crm_by_call_triplet.get((call_key, pair_key[0], pair_key[1]))
            or crm_by_call_id.get(call_key, "")
        )
        if not resolved_crm:
            if pair_key in crm_by_pair_cache:
                resolved_crm = crm_by_pair_cache[pair_key]
            else:
                pair_row = db.exec(
                    select(CRMPair)
                    .where(CRMPair.agent == r.sales_agent)
                    .where(CRMPair.customer == r.customer)
                    .limit(1)
                ).first()
                resolved_crm = str(pair_row.crm_url or "").strip() if pair_row else ""
                crm_by_pair_cache[pair_key] = resolved_crm

        run_origin = _extract_run_origin_from_steps_json(r.steps_json) or "local"
        if run_origin != "webhook":
            # Backfill detection for historical webhook-triggered runs that predate explicit run_origin tagging.
            if str(r.call_id or "").strip():
                ensure_webhook_idx()
                if _matches_webhook_event(
                    started_at=r.started_at.replace(tzinfo=timezone.utc) if r.started_at and r.started_at.tzinfo is None else r.started_at,
                    call_id=r.call_id,
                    agent=r.sales_agent,
                    customer=r.customer,
                    by_key=webhook_by_key,
                    by_call=webhook_by_call,
                ):
                    run_origin = "webhook"

        out_rows.append(
            {
                "id": r.id,
                "pipeline_id": r.pipeline_id,
                "pipeline_name": r.pipeline_name,
                "sales_agent": r.sales_agent,
                "customer": r.customer,
                "call_id": r.call_id,
                "crm_url": resolved_crm,
                "started_at": r.started_at.isoformat() if r.started_at else None,
                "finished_at": r.finished_at.isoformat() if r.finished_at else None,
                "status": r.status,
                "canvas_json": r.canvas_json,
                "steps_json": r.steps_json,
                "log_json": r.log_json,
                "run_origin": run_origin,
            }
        )

    crm_filter = str(crm_url or "").strip().lower()
    if crm_filter:
        out_rows = [row for row in out_rows if crm_filter in str(row.get("crm_url") or "").strip().lower()]

    return out_rows


@router.delete("/runs/{run_id}")
def delete_run(run_id: str, db: Session = Depends(get_session)):
    """Delete a pipeline run and all its step data."""
    from ui.backend.models.pipeline_run import PipelineRun as PR

    run = db.get(PR, run_id)
    if not run:
        raise HTTPException(404, "Run not found")
    db.delete(run)
    db.commit()
    return {"deleted": True}
