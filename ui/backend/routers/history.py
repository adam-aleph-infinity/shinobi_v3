"""Global pipeline execution history — all runs across all pipelines."""
import json
import time
from datetime import datetime, timezone
from typing import Any, Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import tuple_
from sqlalchemy.orm import load_only
from sqlmodel import Session, select

from ui.backend.config import settings
from ui.backend.database import get_session
from ui.backend.services.run_status import derive_effective_run_status, reconcile_run_row_status

router = APIRouter(prefix="/history", tags=["history"])
_WEBHOOK_INBOX_DIR = settings.ui_data_dir / "_webhooks" / "inbox"
_WEBHOOK_INDEX_CACHE: dict[str, Any] = {
    "loaded_at": 0.0,
    "by_key": {},
    "by_call": {},
}
_RUN_STATUS_RECONCILE_CACHE: dict[str, float] = {"last_run_mono": 0.0}


def _is_live_mirror_mode(request: Optional[Request] = None) -> bool:
    if not bool(settings.live_mirror_enabled):
        return False
    if not str(settings.live_mirror_base_url or "").strip():
        return False
    if request is not None and str(request.headers.get("x-shinobi-live-mirror-hop") or "").strip() == "1":
        return False
    return True


def _live_mirror_headers() -> dict[str, str]:
    headers: dict[str, str] = {"x-shinobi-live-mirror-hop": "1"}
    token = str(settings.live_mirror_auth_token or "").strip()
    if token:
        hdr = str(settings.live_mirror_auth_header or "x-api-token").strip() or "x-api-token"
        headers[hdr] = token
    return headers


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


def _load_webhook_event_index(
    limit_files: int = 2000,
    cache_ttl_s: int = 120,
) -> tuple[dict[tuple[str, str, str], list[float]], dict[str, list[float]]]:
    by_key: dict[tuple[str, str, str], list[float]] = {}
    by_call: dict[str, list[float]] = {}
    if not _WEBHOOK_INBOX_DIR.exists():
        return by_key, by_call
    now = time.monotonic()
    try:
        loaded_at = float(_WEBHOOK_INDEX_CACHE.get("loaded_at") or 0.0)
    except Exception:
        loaded_at = 0.0
    if loaded_at > 0 and (now - loaded_at) < max(1, int(cache_ttl_s or 20)):
        try:
            cached_by_key = _WEBHOOK_INDEX_CACHE.get("by_key")
            cached_by_call = _WEBHOOK_INDEX_CACHE.get("by_call")
            if isinstance(cached_by_key, dict) and isinstance(cached_by_call, dict):
                return cached_by_key, cached_by_call
        except Exception:
            pass
    try:
        files = sorted(
            _WEBHOOK_INBOX_DIR.glob("*.json"),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )[: max(100, min(int(limit_files or 2000), 10000))]
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

    _WEBHOOK_INDEX_CACHE["loaded_at"] = now
    _WEBHOOK_INDEX_CACHE["by_key"] = by_key
    _WEBHOOK_INDEX_CACHE["by_call"] = by_call
    return by_key, by_call


def _maybe_reconcile_active_run_statuses(db: Session, throttle_s: float = 10.0) -> None:
    """
    Keep pipeline_run.status aligned with step truth for active rows.
    Runs with a short process-local throttle to avoid write-heavy read paths.
    """
    now_mono = time.monotonic()
    last_mono = float(_RUN_STATUS_RECONCILE_CACHE.get("last_run_mono") or 0.0)
    if (now_mono - last_mono) < max(0.5, float(throttle_s or 1.0)):
        return
    _RUN_STATUS_RECONCILE_CACHE["last_run_mono"] = now_mono
    try:
        from ui.backend.models.pipeline_run import PipelineRun as PR

        active_values = ["queued", "preparing", "running", "retrying", "loading", "started", "in_progress"]
        # Keep reconciliation bounded so list endpoints stay responsive under load.
        rows = db.exec(select(PR).where(PR.status.in_(active_values)).limit(2000)).all()
        changed = 0
        for row in rows or []:
            _, did_change = reconcile_run_row_status(row)
            if did_change:
                db.add(row)
                changed += 1
        if changed:
            db.commit()
    except Exception:
        try:
            db.rollback()
        except Exception:
            pass


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
    request: Request,
    sales_agent: str = Query(""),
    customer: str = Query(""),
    pipeline_id: str = Query(""),
    call_id: str = Query(""),
    status: str = Query(""),
    run_origin: str = Query(""),
    crm_url: str = Query(""),
    date_from: str = Query(""),
    date_to: str = Query(""),
    sort_by: str = Query("started_at"),
    sort_dir: str = Query("desc"),
    limit: int = Query(1000, ge=1, le=10000),
    compact: int = Query(0),
    mirror: int = Query(0),
    db: Session = Depends(get_session),
):
    """Return recent pipeline runs, newest first."""
    mirror_error: Optional[str] = None
    if bool(mirror) and _is_live_mirror_mode(request):
        base = str(settings.live_mirror_base_url or "").strip().rstrip("/")
        if base:
            url = f"{base}/api/history/runs"
            params = {
                "sales_agent": sales_agent,
                "customer": customer,
                "pipeline_id": pipeline_id,
                "call_id": call_id,
                "status": status,
                "crm_url": crm_url,
                "date_from": date_from,
                "date_to": date_to,
                "sort_by": sort_by,
                "sort_dir": sort_dir,
                "limit": limit,
                "compact": 1 if bool(compact) else 0,
            }
            timeout_s = max(3, min(int(settings.live_mirror_timeout_s or 20), 120))
            try:
                with httpx.Client(timeout=timeout_s, headers=_live_mirror_headers()) as client:
                    resp = client.get(url, params=params)
                if resp.status_code < 400:
                    data = resp.json()
                    if isinstance(data, list):
                        return data
                    mirror_error = "Live mirror returned invalid runs payload type."
                else:
                    detail = resp.text
                    try:
                        parsed = resp.json()
                        if isinstance(parsed, dict):
                            detail = str(parsed.get("detail") or parsed.get("error") or detail)
                    except Exception:
                        pass
                    mirror_error = f"Live mirror error: {detail}"
            except Exception as e:
                mirror_error = f"Live mirror request failed: {e}"
        else:
            mirror_error = "Live mirror is enabled but LIVE_MIRROR_BASE_URL is empty."
        if mirror_error:
            print(f"[history] mirror fallback to local runs: {mirror_error}")

    from ui.backend.models.note import Note
    from ui.backend.models.pipeline_run import PipelineRun as PR
    from ui.backend.models.crm import CRMCall, CRMPair

    _maybe_reconcile_active_run_statuses(db)

    stmt = select(PR)
    if bool(compact):
        # Compact mode powers high-frequency Jobs polling; skip large canvas blobs.
        stmt = stmt.options(
            load_only(
                PR.id,
                PR.pipeline_id,
                PR.pipeline_name,
                PR.sales_agent,
                PR.customer,
                PR.call_id,
                PR.started_at,
                PR.finished_at,
                PR.status,
                PR.steps_json,
                PR.log_json,
                PR.run_origin,
                PR.note_sent,
                PR.note_sent_at,
            )
        )

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
    if run_origin:
        stmt = stmt.where(PR.run_origin == str(run_origin).strip().lower())

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
    # Prefetch pair->crm_url in one DB round-trip (avoid N+1 lookup per run row).
    pair_candidates: set[tuple[str, str]] = {
        (str(r.sales_agent or "").strip(), str(r.customer or "").strip())
        for r in rows
        if str(r.sales_agent or "").strip() and str(r.customer or "").strip()
    }
    if pair_candidates:
        try:
            # SQLite has a variable limit; chunk pair tuples defensively.
            pair_list = list(pair_candidates)
            chunk_size = 300
            for i in range(0, len(pair_list), chunk_size):
                chunk = pair_list[i : i + chunk_size]
                pair_rows = db.exec(
                    select(CRMPair).where(
                        tuple_(CRMPair.agent, CRMPair.customer).in_(chunk)
                    )
                ).all()
                for pair_row in pair_rows:
                    k = (norm(pair_row.agent), norm(pair_row.customer))
                    v = str(pair_row.crm_url or "").strip()
                    if k[0] and k[1] and v:
                        crm_by_pair_cache[k] = v
        except Exception:
            # Best effort only; fallback to per-row query path below.
            pass
    note_id_by_triplet: dict[tuple[str, str, str], str] = {}
    note_created_by_triplet: dict[tuple[str, str, str], Optional[datetime]] = {}
    note_id_by_call: dict[str, str] = {}
    note_created_by_call: dict[str, Optional[datetime]] = {}
    if call_ids:
        try:
            note_rows = db.exec(select(Note).where(Note.call_id.in_(call_ids))).all()
        except Exception:
            note_rows = []
        for n in note_rows:
            n_id = str(getattr(n, "id", "") or "").strip()
            if not n_id:
                continue
            n_call = norm(getattr(n, "call_id", ""))
            if not n_call:
                continue
            n_agent = norm(getattr(n, "agent", ""))
            n_customer = norm(getattr(n, "customer", ""))
            n_created = getattr(n, "created_at", None)
            if n_agent and n_customer:
                n_key = (n_call, n_agent, n_customer)
                prev = note_created_by_triplet.get(n_key)
                if prev is None or (n_created is not None and n_created > prev):
                    note_created_by_triplet[n_key] = n_created
                    note_id_by_triplet[n_key] = n_id
            prev_call = note_created_by_call.get(n_call)
            if prev_call is None or (n_created is not None and n_created > prev_call):
                note_created_by_call[n_call] = n_created
                note_id_by_call[n_call] = n_id
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

    def _compact_steps_json(raw: Any) -> str:
        try:
            parsed = json.loads(str(raw or "[]"))
        except Exception:
            return "[]"
        if not isinstance(parsed, list):
            return "[]"
        compact_steps: list[dict[str, Any]] = []
        for item in parsed:
            if not isinstance(item, dict):
                continue
            compact_steps.append(
                {
                    "agent_name": str(item.get("agent_name") or ""),
                    "state": str(item.get("state") or item.get("status") or ""),
                    "start_time": item.get("start_time"),
                    "end_time": item.get("end_time"),
                    "note_id": str(item.get("note_id") or ""),
                    "note_call_id": str(item.get("note_call_id") or ""),
                }
            )
        return json.dumps(compact_steps, ensure_ascii=False)

    def _compact_log_json(raw: Any) -> str:
        raw_text = str(raw or "")
        if not raw_text:
            return "[]"
        # Large log blobs dominate response CPU time on list endpoints.
        # In compact mode, prefer fast list rendering over detailed logs.
        if len(raw_text) > 25000:
            return "[]"
        try:
            parsed = json.loads(raw_text)
        except Exception:
            return "[]"
        if not isinstance(parsed, list):
            return "[]"
        # Keep compact payload light for fast Jobs/History rendering.
        tail = parsed[-12:]
        out: list[dict[str, Any]] = []
        for item in tail:
            if isinstance(item, dict):
                out.append(
                    {
                        "ts": item.get("ts"),
                        "text": item.get("text") or item.get("message") or item.get("msg"),
                        "level": item.get("level"),
                    }
                )
            else:
                out.append({"text": str(item)})
        return json.dumps(out, ensure_ascii=False)

    def _extract_note_id_from_steps_json(raw: Any) -> str:
        try:
            parsed = json.loads(str(raw or "[]"))
        except Exception:
            return ""
        if not isinstance(parsed, list):
            return ""
        for item in reversed(parsed):
            if not isinstance(item, dict):
                continue
            nid = str(item.get("note_id") or "").strip()
            if nid:
                return nid
        return ""

    def _derive_note_sent_flags(row: Any) -> tuple[bool, Optional[str]]:
        sent = bool(getattr(row, "note_sent", False))
        sent_at_raw = getattr(row, "note_sent_at", None)
        sent_at = sent_at_raw.isoformat() if sent_at_raw is not None else None
        if sent or sent_at:
            return True, sent_at
        # Legacy fallback: older rows may only have CRM push evidence in logs.
        log_blob = str(getattr(row, "log_json", "") or "")
        if "[CRM-PUSH] ✓ Sent note " in log_blob:
            return True, sent_at
        return False, sent_at

    for r in rows:
        effective_status = derive_effective_run_status(
            base_status=r.status,
            steps_json=r.steps_json,
            finished_at=r.finished_at,
        )
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

        # Prefer the DB column (single source of truth, shared across VMs).
        # Fall back to derivation only for legacy rows created before the column existed.
        run_origin = _normalize_run_origin(getattr(r, "run_origin", None))
        if not run_origin:
            run_origin = _extract_run_origin_from_steps_json(r.steps_json)
        if not run_origin and str(r.call_id or "").strip():
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
        if not run_origin:
            run_origin = "local"

        step_note_id = _extract_note_id_from_steps_json(r.steps_json)
        resolved_note_id = (
            step_note_id
            or note_id_by_triplet.get((call_key, pair_key[0], pair_key[1]), "")
            or note_id_by_call.get(call_key, "")
        )
        note_sent, note_sent_at = _derive_note_sent_flags(r)

        row_payload = {
            "id": r.id,
            "pipeline_id": r.pipeline_id,
            "pipeline_name": r.pipeline_name,
            "sales_agent": r.sales_agent,
            "customer": r.customer,
            "call_id": r.call_id,
            "crm_url": resolved_crm,
            "started_at": r.started_at.isoformat() if r.started_at else None,
            "finished_at": r.finished_at.isoformat() if r.finished_at else None,
            "status": effective_status,
            "canvas_json": "" if bool(compact) else r.canvas_json,
            "steps_json": r.steps_json,
            "log_json": r.log_json,
            "run_origin": run_origin,
            "note_sent": note_sent,
            "note_sent_at": note_sent_at,
            "note_id": resolved_note_id,
        }
        if bool(compact):
            row_payload["steps_json"] = _compact_steps_json(r.steps_json)
            row_payload["log_json"] = _compact_log_json(r.log_json)
        out_rows.append(row_payload)

    crm_filter = str(crm_url or "").strip().lower()
    if crm_filter:
        out_rows = [row for row in out_rows if crm_filter in str(row.get("crm_url") or "").strip().lower()]

    return out_rows


@router.get("/runs/{run_id}")
def get_run_by_id(
    run_id: str,
    request: Request,
    compact: int = Query(0),
    mirror: int = Query(0),
    db: Session = Depends(get_session),
):
    rid = str(run_id or "").strip()
    if not rid:
        raise HTTPException(400, "Missing run_id")

    if bool(mirror) and _is_live_mirror_mode(request):
        base = str(settings.live_mirror_base_url or "").strip().rstrip("/")
        if base:
            url = f"{base}/api/history/runs/{rid}"
            params = {"compact": 1 if bool(compact) else 0}
            timeout_s = max(3, min(int(settings.live_mirror_timeout_s or 20), 120))
            try:
                with httpx.Client(timeout=timeout_s, headers=_live_mirror_headers()) as client:
                    resp = client.get(url, params=params)
                if resp.status_code < 400:
                    data = resp.json()
                    if isinstance(data, dict):
                        return data
                    raise HTTPException(502, "Live mirror returned invalid run payload type.")
                detail = resp.text
                try:
                    parsed = resp.json()
                    if isinstance(parsed, dict):
                        detail = str(parsed.get("detail") or parsed.get("error") or detail)
                except Exception:
                    pass
                raise HTTPException(resp.status_code, f"Live mirror error: {detail}")
            except HTTPException:
                raise
            except Exception as e:
                raise HTTPException(502, f"Live mirror request failed: {e}") from e

    from ui.backend.models.note import Note
    from ui.backend.models.pipeline_run import PipelineRun as PR
    from ui.backend.models.crm import CRMCall, CRMPair

    if bool(compact):
        r = db.exec(
            select(PR)
            .options(
                load_only(
                    PR.id,
                    PR.pipeline_id,
                    PR.pipeline_name,
                    PR.sales_agent,
                    PR.customer,
                    PR.call_id,
                    PR.started_at,
                    PR.finished_at,
                    PR.status,
                    PR.steps_json,
                    PR.log_json,
                    PR.run_origin,
                    PR.note_sent,
                    PR.note_sent_at,
                )
            )
            .where(PR.id == rid)
            .limit(1)
        ).first()
    else:
        r = db.get(PR, rid)
    if not r:
        raise HTTPException(404, "Run not found")

    effective_status, status_changed = reconcile_run_row_status(r)
    if status_changed:
        try:
            db.add(r)
            db.commit()
            if not bool(compact):
                db.refresh(r)
        except Exception:
            try:
                db.rollback()
            except Exception:
                pass
            effective_status = derive_effective_run_status(
                base_status=r.status,
                steps_json=r.steps_json,
                finished_at=r.finished_at,
            )
    else:
        effective_status = derive_effective_run_status(
            base_status=r.status,
            steps_json=r.steps_json,
            finished_at=r.finished_at,
        )

    def norm(v: Any) -> str:
        return str(v or "").strip().lower()

    call_key = norm(r.call_id)
    pair_key = (norm(r.sales_agent), norm(r.customer))

    resolved_crm = ""
    if call_key:
        try:
            call_row = db.exec(
                select(CRMCall).where(CRMCall.call_id == str(r.call_id or "").strip()).limit(1)
            ).first()
            resolved_crm = str(getattr(call_row, "crm_url", "") or "").strip() if call_row else ""
        except Exception:
            resolved_crm = ""

    if not resolved_crm:
        try:
            pair_row = db.exec(
                select(CRMPair)
                .where(CRMPair.agent == r.sales_agent)
                .where(CRMPair.customer == r.customer)
                .limit(1)
            ).first()
            resolved_crm = str(getattr(pair_row, "crm_url", "") or "").strip() if pair_row else ""
        except Exception:
            resolved_crm = ""

    run_origin = _normalize_run_origin(getattr(r, "run_origin", None))
    if not run_origin:
        run_origin = _extract_run_origin_from_steps_json(r.steps_json)
    if not run_origin and str(r.call_id or "").strip():
        by_key, by_call = _load_webhook_event_index()
        started = r.started_at
        if started is not None and getattr(started, "tzinfo", None) is None:
            started = started.replace(tzinfo=timezone.utc)
        if _matches_webhook_event(
            started_at=started,
            call_id=r.call_id,
            agent=r.sales_agent,
            customer=r.customer,
            by_key=by_key,
            by_call=by_call,
        ):
            run_origin = "webhook"
    if not run_origin:
        run_origin = "local"

    def _extract_note_id_from_steps_json(raw: Any) -> str:
        try:
            parsed = json.loads(str(raw or "[]"))
        except Exception:
            return ""
        if not isinstance(parsed, list):
            return ""
        for item in reversed(parsed):
            if not isinstance(item, dict):
                continue
            nid = str(item.get("note_id") or "").strip()
            if nid:
                return nid
        return ""

    def _derive_note_sent_flags(row: Any) -> tuple[bool, Optional[str]]:
        sent = bool(getattr(row, "note_sent", False))
        sent_at_raw = getattr(row, "note_sent_at", None)
        sent_at = sent_at_raw.isoformat() if sent_at_raw is not None else None
        if sent or sent_at:
            return True, sent_at
        log_blob = str(getattr(row, "log_json", "") or "")
        if "[CRM-PUSH] ✓ Sent note " in log_blob:
            return True, sent_at
        return False, sent_at

    resolved_note_id = _extract_note_id_from_steps_json(r.steps_json)
    if not resolved_note_id and call_key:
        try:
            notes = db.exec(select(Note).where(Note.call_id == str(r.call_id or "").strip())).all()
        except Exception:
            notes = []
        want_agent = norm(r.sales_agent)
        want_customer = norm(r.customer)
        best_pair: tuple[Optional[datetime], str] = (None, "")
        best_call: tuple[Optional[datetime], str] = (None, "")
        for n in notes:
            n_id = str(getattr(n, "id", "") or "").strip()
            if not n_id:
                continue
            n_created = getattr(n, "created_at", None)
            if best_call[0] is None or (n_created is not None and n_created > best_call[0]):
                best_call = (n_created, n_id)
            if norm(getattr(n, "agent", "")) == want_agent and norm(getattr(n, "customer", "")) == want_customer:
                if best_pair[0] is None or (n_created is not None and n_created > best_pair[0]):
                    best_pair = (n_created, n_id)
        resolved_note_id = best_pair[1] or best_call[1]
    note_sent, note_sent_at = _derive_note_sent_flags(r)

    def _compact_steps_json(raw: Any) -> str:
        try:
            parsed = json.loads(str(raw or "[]"))
        except Exception:
            return "[]"
        if not isinstance(parsed, list):
            return "[]"
        compact_steps: list[dict[str, Any]] = []
        for item in parsed:
            if not isinstance(item, dict):
                continue
            compact_steps.append(
                {
                    "agent_name": str(item.get("agent_name") or ""),
                    "state": str(item.get("state") or item.get("status") or ""),
                    "start_time": item.get("start_time"),
                    "end_time": item.get("end_time"),
                    "note_id": str(item.get("note_id") or ""),
                    "note_call_id": str(item.get("note_call_id") or ""),
                }
            )
        return json.dumps(compact_steps, ensure_ascii=False)

    def _compact_log_json(raw: Any) -> str:
        try:
            parsed = json.loads(str(raw or "[]"))
        except Exception:
            return "[]"
        if not isinstance(parsed, list):
            return "[]"
        # Keep compact payload light for fast Jobs/History rendering.
        tail = parsed[-12:]
        out: list[dict[str, Any]] = []
        for item in tail:
            if isinstance(item, dict):
                out.append(
                    {
                        "ts": item.get("ts"),
                        "text": item.get("text") or item.get("message") or item.get("msg"),
                        "level": item.get("level"),
                    }
                )
            else:
                out.append({"text": str(item)})
        return json.dumps(out, ensure_ascii=False)

    row_payload = {
        "id": r.id,
        "pipeline_id": r.pipeline_id,
        "pipeline_name": r.pipeline_name,
        "sales_agent": r.sales_agent,
        "customer": r.customer,
        "call_id": r.call_id,
        "crm_url": resolved_crm,
        "started_at": r.started_at.isoformat() if r.started_at else None,
        "finished_at": r.finished_at.isoformat() if r.finished_at else None,
        "status": effective_status,
        "canvas_json": "" if bool(compact) else r.canvas_json,
        "steps_json": r.steps_json,
        "log_json": r.log_json,
        "run_origin": run_origin,
        "note_sent": note_sent,
        "note_sent_at": note_sent_at,
        "note_id": resolved_note_id,
    }
    if bool(compact):
        row_payload["steps_json"] = _compact_steps_json(r.steps_json)
        row_payload["log_json"] = _compact_log_json(r.log_json)
    return row_payload


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
