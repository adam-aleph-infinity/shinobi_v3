import asyncio
import hmac
import json
import re
import uuid
from datetime import datetime, timezone
from typing import Any, Optional
from urllib.parse import unquote, urlparse

import httpx
from fastapi import APIRouter, Depends, Form, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import func as _sql_func, or_ as _sql_or
from sqlmodel import Session, select

from ui.backend.config import settings
from ui.backend.database import engine as _db_engine, get_session
from ui.backend.models.crm import CRMCall, CRMPair
from ui.backend.models.job import Job, JobStatus
from ui.backend.routers.transcription_process import CreateJobRequest, create_transcription_job

router = APIRouter(prefix="/webhooks", tags=["webhooks"])

_WEBHOOK_DIR = settings.ui_data_dir / "_webhooks"
_CALL_ENDED_CONFIG_FILE = _WEBHOOK_DIR / "call_ended_config.json"
_WEBHOOK_INBOX_DIR = _WEBHOOK_DIR / "inbox"
_WEBHOOK_TEST_DIR = settings.ui_data_dir / "webhook_test"
_WEBHOOK_TEST_SESSION_FILE = _WEBHOOK_TEST_DIR / "_session.json"


class CallEndedWebhookPayload(BaseModel):
    call_id: str
    account_id: str
    agent: str
    record_path: str = ""
    duration: Optional[int] = None
    crm_url: str = ""
    customer: str = ""
    token: str = ""


class CallEndedWebhookConfig(BaseModel):
    enabled: bool = True
    ingest_only: bool = True
    trigger_pipeline: bool = True
    live_pipeline_ids: list[str] = Field(default_factory=list)
    default_pipeline_id: str = ""
    pipeline_by_agent: dict[str, str] = Field(default_factory=dict)
    transcription_model: str = "gpt-5.4"
    transcription_timeout_s: int = 900
    transcription_poll_interval_s: float = 2.0
    run_payload: dict[str, Any] = Field(default_factory=dict)


def _default_call_ended_config() -> dict[str, Any]:
    return {
        "enabled": True,
        "ingest_only": True,
        "trigger_pipeline": True,
        "live_pipeline_ids": [],
        "default_pipeline_id": "",
        "pipeline_by_agent": {},
        "transcription_model": "gpt-5.4",
        "transcription_timeout_s": int(settings.crm_webhook_transcription_timeout_s or 900),
        "transcription_poll_interval_s": float(settings.crm_webhook_transcription_poll_interval_s or 2.0),
        "run_payload": {
            "resume_partial": True,
        },
    }


def _enum_value(value: Any) -> str:
    if hasattr(value, "value"):
        try:
            return str(value.value)
        except Exception:
            return str(value)
    return str(value or "")


def _normalize_call_ended_config(raw: Any) -> dict[str, Any]:
    base = _default_call_ended_config()
    if isinstance(raw, dict):
        base.update(raw)
    base["enabled"] = bool(base.get("enabled", True))
    base["ingest_only"] = bool(base.get("ingest_only", True))
    base["trigger_pipeline"] = bool(base.get("trigger_pipeline", True))
    live_ids = base.get("live_pipeline_ids")
    if isinstance(live_ids, list):
        dedup: list[str] = []
        seen: set[str] = set()
        for v in live_ids:
            pid = str(v or "").strip()
            if not pid or pid in seen:
                continue
            seen.add(pid)
            dedup.append(pid)
        base["live_pipeline_ids"] = dedup
    else:
        base["live_pipeline_ids"] = []
    base["default_pipeline_id"] = str(base.get("default_pipeline_id") or "").strip()
    base["transcription_model"] = str(base.get("transcription_model") or "gpt-5.4").strip() or "gpt-5.4"
    try:
        base["transcription_timeout_s"] = max(30, min(int(base.get("transcription_timeout_s") or 900), 3600))
    except Exception:
        base["transcription_timeout_s"] = 900
    try:
        base["transcription_poll_interval_s"] = max(
            0.2,
            min(float(base.get("transcription_poll_interval_s") or 2.0), 30.0),
        )
    except Exception:
        base["transcription_poll_interval_s"] = 2.0

    mapping = base.get("pipeline_by_agent")
    if isinstance(mapping, dict):
        norm_map: dict[str, str] = {}
        for k, v in mapping.items():
            kk = str(k or "").strip()
            vv = str(v or "").strip()
            if kk and vv:
                norm_map[kk] = vv
        base["pipeline_by_agent"] = norm_map
    else:
        base["pipeline_by_agent"] = {}

    run_payload = base.get("run_payload")
    base["run_payload"] = run_payload if isinstance(run_payload, dict) else {}
    return base


def _load_call_ended_config() -> dict[str, Any]:
    _WEBHOOK_DIR.mkdir(parents=True, exist_ok=True)
    if not _CALL_ENDED_CONFIG_FILE.exists():
        cfg = _default_call_ended_config()
        _CALL_ENDED_CONFIG_FILE.write_text(json.dumps(cfg, indent=2, ensure_ascii=False), encoding="utf-8")
        return cfg
    try:
        raw = json.loads(_CALL_ENDED_CONFIG_FILE.read_text(encoding="utf-8"))
    except Exception:
        raw = {}
    cfg = _normalize_call_ended_config(raw)
    _CALL_ENDED_CONFIG_FILE.write_text(json.dumps(cfg, indent=2, ensure_ascii=False), encoding="utf-8")
    return cfg


def _save_call_ended_config(cfg: dict[str, Any]) -> dict[str, Any]:
    _WEBHOOK_DIR.mkdir(parents=True, exist_ok=True)
    norm = _normalize_call_ended_config(cfg)
    _CALL_ENDED_CONFIG_FILE.write_text(json.dumps(norm, indent=2, ensure_ascii=False), encoding="utf-8")
    return norm


def _safe_file_part(value: str, default: str = "unknown") -> str:
    raw = str(value or "").strip()
    if not raw:
        return default
    cleaned = re.sub(r"[^a-zA-Z0-9._-]+", "_", raw).strip("._-")
    if not cleaned:
        return default
    return cleaned[:80]


def _event_file_name(webhook_type: str, call_id: str, account_id: str) -> str:
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    w = _safe_file_part(webhook_type, "webhook")
    c = _safe_file_part(call_id, "call")
    a = _safe_file_part(account_id, "account")
    return f"{ts}_{w}_{a}_{c}_{uuid.uuid4().hex[:10]}.json"


def _persist_webhook_event(
    *,
    webhook_type: str,
    compat_mode: str,
    payload: dict[str, Any],
    request: Request,
) -> dict[str, Any]:
    _WEBHOOK_INBOX_DIR.mkdir(parents=True, exist_ok=True)

    now_iso = datetime.now(timezone.utc).isoformat()
    call_id = str(payload.get("call_id") or "")
    account_id = str(payload.get("account_id") or "")
    event_id = str(uuid.uuid4())
    file_name = _event_file_name(webhook_type, call_id, account_id)
    file_path = _WEBHOOK_INBOX_DIR / file_name

    event = {
        "event_id": event_id,
        "received_at": now_iso,
        "webhook_type": webhook_type,
        "compat_mode": compat_mode or "",
        "method": str(request.method or ""),
        "path": str(request.url.path or ""),
        "source_ip": str(getattr(request.client, "host", "") or ""),
        "content_type": str(request.headers.get("content-type") or ""),
        "payload": payload,
    }
    file_path.write_text(json.dumps(event, indent=2, ensure_ascii=False), encoding="utf-8")
    return {
        "event_id": event_id,
        "stored_at": now_iso,
        "file": str(file_path),
    }


def _extract_webhook_token(request: Request, payload: CallEndedWebhookPayload) -> str:
    configured_header = str(settings.crm_webhook_token_header or "x-webhook-token").strip().lower()
    candidates = [
        request.headers.get(configured_header, ""),
        request.headers.get("x-webhook-token", ""),
        request.headers.get("x-shinobi-webhook-token", ""),
        request.headers.get("x-api-token", ""),
    ]
    auth = str(request.headers.get("authorization") or "").strip()
    if auth.lower().startswith("bearer "):
        candidates.append(auth[7:].strip())
    if payload.token:
        candidates.append(payload.token)
    for value in candidates:
        token = str(value or "").strip()
        if token:
            return token
    return ""


def _extract_webhook_token_from_headers(request: Request) -> str:
    configured_header = str(settings.crm_webhook_token_header or "x-webhook-token").strip().lower()
    candidates = [
        request.headers.get(configured_header, ""),
        request.headers.get("x-webhook-token", ""),
        request.headers.get("x-shinobi-webhook-token", ""),
        request.headers.get("x-api-token", ""),
    ]
    auth = str(request.headers.get("authorization") or "").strip()
    if auth.lower().startswith("bearer "):
        candidates.append(auth[7:].strip())
    for value in candidates:
        token = str(value or "").strip()
        if token:
            return token
    return ""


def _assert_webhook_auth(request: Request, payload: CallEndedWebhookPayload) -> None:
    if not bool(settings.crm_webhook_enabled):
        raise HTTPException(status_code=403, detail="CRM webhook is disabled. Set CRM_WEBHOOK_ENABLED=true.")

    expected = str(settings.crm_webhook_secret or "").strip()
    require_secret = bool(settings.crm_webhook_require_secret)
    if not expected and not require_secret:
        return
    if not expected and require_secret:
        raise HTTPException(
            status_code=500,
            detail="CRM webhook secret is required but missing. Set CRM_WEBHOOK_SECRET.",
        )

    token = _extract_webhook_token(request, payload)
    if not token or not hmac.compare_digest(token, expected):
        raise HTTPException(status_code=401, detail="Invalid webhook token.")


def _assert_webhook_admin_auth(request: Request) -> None:
    """
    Guard configuration endpoints under /api/webhooks/*.
    These endpoints become publicly reachable once webhook path bypasses IAP.
    """
    if not bool(settings.crm_webhook_enabled):
        raise HTTPException(status_code=403, detail="CRM webhook is disabled. Set CRM_WEBHOOK_ENABLED=true.")

    expected = str(settings.crm_webhook_secret or "").strip()
    require_secret = bool(settings.crm_webhook_require_secret)
    if not expected and not require_secret:
        raise HTTPException(
            status_code=403,
            detail="Webhook config endpoints require a configured secret.",
        )
    if not expected and require_secret:
        raise HTTPException(
            status_code=500,
            detail="CRM webhook secret is required but missing. Set CRM_WEBHOOK_SECRET.",
        )

    token = _extract_webhook_token_from_headers(request)
    if not token or not hmac.compare_digest(token, expected):
        raise HTTPException(status_code=401, detail="Invalid webhook token.")


def _agent_candidate_names(agent: str) -> list[str]:
    raw = str(agent or "").strip()
    if not raw:
        return []
    try:
        from ui.backend.services.crm_service import _auto_detect_re_aliases, _load_aliases

        aliases = {**_auto_detect_re_aliases([raw]), **_load_aliases()}
    except Exception:
        aliases = {}

    primary = aliases.get(raw, raw)
    names = {raw, primary}
    for alias_name, target in aliases.items():
        if str(target or "").strip() == primary:
            names.add(str(alias_name or "").strip())
    return sorted([n for n in names if n])


def _resolve_pair(db: Session, payload: CallEndedWebhookPayload) -> dict[str, str]:
    account_id = str(payload.account_id or "").strip()
    if not account_id:
        raise HTTPException(status_code=400, detail="Missing account_id in webhook payload.")

    rows: list[CRMPair] = []
    names = _agent_candidate_names(payload.agent)
    if names:
        clause = _sql_or(*[_sql_func.lower(CRMPair.agent) == n.lower() for n in names])
        stmt = select(CRMPair).where(_sql_func.trim(CRMPair.account_id) == account_id).where(clause)
        rows = db.exec(stmt).all()

    if not rows:
        stmt = select(CRMPair).where(_sql_func.trim(CRMPair.account_id) == account_id)
        rows = db.exec(stmt).all()

    if not rows:
        raise HTTPException(
            status_code=404,
            detail=f"No CRM pair found for account_id={account_id}.",
        )

    rows.sort(
        key=lambda p: (
            int(getattr(p, "call_count", 0) or 0),
            float(getattr(p, "net_deposits", 0.0) or 0.0),
        ),
        reverse=True,
    )
    best = rows[0]
    return {
        "account_id": str(best.account_id or "").strip(),
        "agent": str(best.agent or "").strip(),
        "customer": str(best.customer or "").strip(),
        "crm_url": str(best.crm_url or "").strip(),
    }


def _resolve_record_path(
    db: Session,
    payload: CallEndedWebhookPayload,
    pair: dict[str, str],
) -> str:
    incoming = str(payload.record_path or "").strip()
    # Accept either a CRM S3 object key (preferred) or a full URL.
    # If URL is provided, normalize to a path-like key when possible.
    if incoming.startswith("http://") or incoming.startswith("https://"):
        try:
            parsed = urlparse(incoming)
            candidate = unquote(str(parsed.path or "").lstrip("/"))
            if candidate:
                incoming = candidate
        except Exception:
            pass
    if incoming:
        return incoming

    call_id = str(payload.call_id or "").strip()
    account_id = str(pair.get("account_id") or "").strip()
    if not call_id or not account_id:
        return ""

    stmt = select(CRMCall).where(
        _sql_func.trim(CRMCall.account_id) == account_id,
        _sql_func.trim(CRMCall.call_id) == call_id,
    )
    names = _agent_candidate_names(payload.agent or pair.get("agent", ""))
    if names:
        clause = _sql_or(*[_sql_func.lower(CRMCall.agent) == n.lower() for n in names])
        stmt = stmt.where(clause)
    rows = db.exec(stmt).all()
    for row in rows:
        rp = str(getattr(row, "record_path", "") or "").strip()
        if rp:
            return rp
    return ""


def _transcript_exists(agent: str, customer: str, call_id: str) -> bool:
    p = (
        settings.agents_dir
        / str(agent or "")
        / str(customer or "")
        / str(call_id or "")
        / "transcribed"
        / "llm_final"
        / "smoothed.txt"
    )
    return p.exists()


async def _wait_for_job(job_id: str, timeout_s: int, poll_s: float) -> dict[str, Any]:
    deadline = asyncio.get_running_loop().time() + float(timeout_s)
    while True:
        with Session(_db_engine) as s:
            job = s.get(Job, job_id)
            if not job:
                raise HTTPException(status_code=404, detail=f"Transcription job {job_id} not found.")
            status = _enum_value(job.status)
            if job.status == JobStatus.complete:
                return {
                    "job_id": job_id,
                    "status": status,
                    "error": "",
                    "completed_at": str(getattr(job, "completed_at", None) or ""),
                }
            if job.status == JobStatus.failed:
                raise HTTPException(
                    status_code=502,
                    detail=f"Transcription failed for job {job_id}: {str(job.error or 'unknown error')}",
                )

        if asyncio.get_running_loop().time() >= deadline:
            raise HTTPException(
                status_code=504,
                detail=f"Timed out waiting for transcription job {job_id}.",
            )
        await asyncio.sleep(float(poll_s))


def _resolve_pipeline_id(cfg: dict[str, Any], payload_agent: str, resolved_agent: str) -> str:
    mapping = cfg.get("pipeline_by_agent")
    if not isinstance(mapping, dict):
        mapping = {}

    search_names = []
    for n in [payload_agent, resolved_agent]:
        vv = str(n or "").strip()
        if vv:
            search_names.append(vv)
    for n in _agent_candidate_names(payload_agent):
        if n not in search_names:
            search_names.append(n)

    for candidate in search_names:
        for map_key, map_val in mapping.items():
            if str(map_key or "").strip().lower() == candidate.lower():
                pid = str(map_val or "").strip()
                if pid:
                    return pid
    return str(cfg.get("default_pipeline_id") or "").strip()


def _resolve_live_pipeline_ids(cfg: dict[str, Any]) -> list[str]:
    raw = cfg.get("live_pipeline_ids")
    if not isinstance(raw, list):
        return []
    out: list[str] = []
    seen: set[str] = set()
    for v in raw:
        pid = str(v or "").strip()
        if not pid or pid in seen:
            continue
        seen.add(pid)
        out.append(pid)
    return out


def _assert_pipeline_exists(pipeline_id: str) -> None:
    if not pipeline_id:
        raise HTTPException(status_code=400, detail="Missing pipeline_id mapping.")
    try:
        from ui.backend.routers.pipelines import _find_file

        _find_file(pipeline_id)
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=404, detail=f"Mapped pipeline not found: {pipeline_id}")


async def _trigger_pipeline_run(
    request: Request,
    pipeline_id: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    base_url = str(settings.crm_webhook_internal_base_url or "").strip().rstrip("/")
    if not base_url:
        base_url = str(request.base_url).rstrip("/")
    endpoint = f"{base_url}/pipelines/{pipeline_id}/run"

    run_id = ""
    event_tail: list[str] = []
    status_code = 0
    async with httpx.AsyncClient(follow_redirects=True, timeout=httpx.Timeout(15.0, read=None)) as client:
        async with client.stream(
            "POST",
            endpoint,
            json=payload,
            headers={"accept": "text/event-stream"},
        ) as resp:
            status_code = int(resp.status_code)
            if status_code >= 400:
                body = (await resp.aread()).decode("utf-8", errors="ignore")
                raise HTTPException(
                    status_code=502,
                    detail=f"Pipeline run request failed ({status_code}): {body[:500]}",
                )

            started = asyncio.get_running_loop().time()
            async for line in resp.aiter_lines():
                if not line.startswith("data: "):
                    continue
                raw = line[6:].strip()
                if not raw:
                    continue
                try:
                    event = json.loads(raw)
                except Exception:
                    continue
                evt_type = str(event.get("type") or "")
                if evt_type:
                    event_tail.append(evt_type)
                    event_tail = event_tail[-20:]
                if evt_type == "execution_session":
                    run_id = str((event.get("data") or {}).get("run_id") or "")
                    if run_id:
                        break
                if evt_type == "error":
                    msg = str((event.get("data") or {}).get("msg") or "unknown pipeline startup error")
                    raise HTTPException(status_code=502, detail=f"Pipeline startup failed: {msg}")
                if asyncio.get_running_loop().time() - started > 15:
                    break

    return {
        "endpoint": endpoint,
        "status_code": status_code,
        "run_id": run_id,
        "events": event_tail,
    }


@router.get("/call-ended/config")
def get_call_ended_config(request: Request) -> dict[str, Any]:
    _assert_webhook_admin_auth(request)
    return _load_call_ended_config()


@router.put("/call-ended/config")
def set_call_ended_config(req: CallEndedWebhookConfig, request: Request) -> dict[str, Any]:
    _assert_webhook_admin_auth(request)
    return _save_call_ended_config(req.model_dump())


@router.get("/events")
def list_webhook_events(
    request: Request,
    limit: int = Query(20, ge=1, le=200),
) -> dict[str, Any]:
    _assert_webhook_admin_auth(request)
    _WEBHOOK_INBOX_DIR.mkdir(parents=True, exist_ok=True)
    files = sorted(_WEBHOOK_INBOX_DIR.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)[:limit]
    out: list[dict[str, Any]] = []
    for fp in files:
        try:
            data = json.loads(fp.read_text(encoding="utf-8"))
        except Exception:
            continue
        payload = data.get("payload") if isinstance(data.get("payload"), dict) else {}
        out.append(
            {
                "event_id": str(data.get("event_id") or ""),
                "received_at": str(data.get("received_at") or ""),
                "webhook_type": str(data.get("webhook_type") or ""),
                "call_id": str(payload.get("call_id") or ""),
                "account_id": str(payload.get("account_id") or ""),
                "agent": str(payload.get("agent") or ""),
                "file": str(fp),
            }
        )
    return {"ok": True, "count": len(out), "events": out}


async def _handle_call_webhook(
    payload: CallEndedWebhookPayload,
    request: Request,
    db: Session = Depends(get_session),
    webhook_type: str = "call-ended",
    compat_mode: str = "",
) -> dict[str, Any]:
    _assert_webhook_auth(request, payload)
    cfg = _load_call_ended_config()
    if not cfg.get("enabled", True):
        raise HTTPException(status_code=403, detail="Call-ended webhook flow is disabled in config.")

    stored = _persist_webhook_event(
        webhook_type=webhook_type,
        compat_mode=compat_mode,
        payload=payload.model_dump(),
        request=request,
    )
    if bool(cfg.get("ingest_only", True)):
        return {
            "ok": True,
            "webhook_type": webhook_type,
            "compat_mode": compat_mode or "",
            "ingest_only": True,
            "stored": stored,
            "message": "Webhook payload received and saved. Runtime execution is disabled (ingest_only=true).",
        }

    pair = _resolve_pair(db, payload)
    if payload.customer and str(payload.customer).strip():
        pair["customer"] = str(payload.customer).strip()
    if payload.crm_url and str(payload.crm_url).strip():
        pair["crm_url"] = str(payload.crm_url).strip()

    call_id = str(payload.call_id or "").strip()
    if not call_id:
        raise HTTPException(status_code=400, detail="Missing call_id in webhook payload.")

    record_path = _resolve_record_path(db, payload, pair)
    if not record_path:
        raise HTTPException(
            status_code=400,
            detail="Missing record_path in webhook payload and CRM call record.",
        )

    transcription_info: dict[str, Any] = {
        "used_cached_transcript": False,
        "job_id": "",
        "status": "",
    }
    if _transcript_exists(pair["agent"], pair["customer"], call_id):
        transcription_info["used_cached_transcript"] = True
        transcription_info["status"] = "complete"
    else:
        create_req = CreateJobRequest(
            crm_url=pair["crm_url"],
            account_id=pair["account_id"],
            agent=pair["agent"],
            customer=pair["customer"],
            call_id=call_id,
            record_path=record_path,
            smooth_model=str(cfg.get("transcription_model") or "gpt-5.4"),
        )
        job_resp = await create_transcription_job(create_req, db)
        job_id = str(job_resp.get("job_id") or "")
        transcription_info["job_id"] = job_id
        transcription_info["status"] = _enum_value(job_resp.get("status") or "")
        waited = await _wait_for_job(
            job_id=job_id,
            timeout_s=int(cfg.get("transcription_timeout_s") or 900),
            poll_s=float(cfg.get("transcription_poll_interval_s") or 2.0),
        )
        transcription_info.update(waited)

    pipeline_info: dict[str, Any] = {
        "triggered": False,
        "pipeline_id": "",
        "run_id": "",
        "pipelines": [],
    }
    if bool(cfg.get("trigger_pipeline", True)):
        configured_live_ids = _resolve_live_pipeline_ids(cfg)
        target_pipeline_ids: list[str] = []
        if configured_live_ids:
            target_pipeline_ids = configured_live_ids
        else:
            mapped_id = _resolve_pipeline_id(cfg, payload.agent, pair["agent"])
            if mapped_id:
                target_pipeline_ids = [mapped_id]

        if target_pipeline_ids:
            run_payload = {
                "sales_agent": pair["agent"],
                "customer": pair["customer"],
                "call_id": call_id,
                "resume_partial": True,
            }
            cfg_run_payload = cfg.get("run_payload")
            if isinstance(cfg_run_payload, dict):
                for k, v in cfg_run_payload.items():
                    run_payload[str(k)] = v

            pipeline_runs: list[dict[str, Any]] = []
            for idx, pipeline_id in enumerate(target_pipeline_ids):
                entry: dict[str, Any] = {
                    "pipeline_id": pipeline_id,
                    "triggered": False,
                    "run_id": "",
                }
                try:
                    _assert_pipeline_exists(pipeline_id)
                    run_result = await _trigger_pipeline_run(
                        request=request,
                        pipeline_id=pipeline_id,
                        payload=run_payload,
                    )
                    entry.update(
                        {
                            "triggered": True,
                            "run_id": str(run_result.get("run_id") or ""),
                            "trigger_result": run_result,
                        }
                    )
                except Exception as e:
                    entry["error"] = str(getattr(e, "detail", "") or str(e) or "pipeline trigger failed")
                pipeline_runs.append(entry)

                # Preserve previous single-pipeline response fields for compatibility.
                if idx == 0:
                    pipeline_info["pipeline_id"] = pipeline_id
                    pipeline_info["run_id"] = str(entry.get("run_id") or "")
                    if entry.get("trigger_result"):
                        pipeline_info["trigger_result"] = entry.get("trigger_result")

            pipeline_info["pipelines"] = pipeline_runs
            pipeline_info["triggered"] = any(bool(x.get("triggered")) for x in pipeline_runs)
        else:
            pipeline_info["message"] = "No pipeline mapping found for this agent."

    return {
        "ok": True,
        "webhook_type": webhook_type,
        "compat_mode": compat_mode or "",
        "ingest_only": False,
        "stored": stored,
        "received": {
            "call_id": call_id,
            "account_id": pair["account_id"],
            "agent": payload.agent,
            "record_path": record_path,
            "duration": payload.duration,
        },
        "resolved_pair": pair,
        "transcription": transcription_info,
        "pipeline": pipeline_info,
    }


@router.post("/call-ended")
async def handle_call_ended_webhook(
    payload: CallEndedWebhookPayload,
    request: Request,
    db: Session = Depends(get_session),
) -> dict[str, Any]:
    return await _handle_call_webhook(
        payload=payload,
        request=request,
        db=db,
        webhook_type="call-ended",
        compat_mode="json",
    )


# ── Catch-all test listener ────────────────────────────────────────────────────

@router.post("/test/open")
async def open_test_session(duration_minutes: int = 60) -> dict[str, Any]:
    """Open a test capture session. All pings to /webhooks/test/capture will be saved."""
    _WEBHOOK_TEST_DIR.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc)
    expires_at = now.timestamp() + duration_minutes * 60
    session = {
        "opened_at": now.isoformat(),
        "expires_at": datetime.fromtimestamp(expires_at, tz=timezone.utc).isoformat(),
        "duration_minutes": duration_minutes,
    }
    _WEBHOOK_TEST_SESSION_FILE.write_text(json.dumps(session, indent=2), encoding="utf-8")
    return {"ok": True, "message": f"Test capture open for {duration_minutes} minutes.", **session}


@router.post("/test/close")
async def close_test_session() -> dict[str, Any]:
    """Close the test capture session."""
    if _WEBHOOK_TEST_SESSION_FILE.exists():
        _WEBHOOK_TEST_SESSION_FILE.unlink()
    return {"ok": True, "message": "Test capture session closed."}


@router.get("/test/results")
async def get_test_results() -> dict[str, Any]:
    """List all captured webhook payloads from the current/last session."""
    _WEBHOOK_TEST_DIR.mkdir(parents=True, exist_ok=True)
    files = sorted(_WEBHOOK_TEST_DIR.glob("capture_*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
    results = []
    for fp in files:
        try:
            results.append(json.loads(fp.read_text(encoding="utf-8")))
        except Exception:
            continue
    session = {}
    if _WEBHOOK_TEST_SESSION_FILE.exists():
        try:
            session = json.loads(_WEBHOOK_TEST_SESSION_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {"ok": True, "count": len(results), "session": session, "captures": results}


@router.api_route("/test/capture", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
@router.api_route("/test/capture/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
async def catch_all_test_capture(request: Request, path: str = "") -> dict[str, Any]:
    """Catch-all endpoint — saves full request (headers, body, query params) to webhook_test/."""
    _WEBHOOK_TEST_DIR.mkdir(parents=True, exist_ok=True)

    # Check session is open
    if _WEBHOOK_TEST_SESSION_FILE.exists():
        try:
            session = json.loads(_WEBHOOK_TEST_SESSION_FILE.read_text(encoding="utf-8"))
            expires_at = datetime.fromisoformat(session["expires_at"])
            if datetime.now(timezone.utc) > expires_at:
                return {"ok": False, "error": "Test capture session has expired. Call /webhooks/test/open to reopen."}
        except Exception:
            pass
    else:
        return {"ok": False, "error": "No active test session. Call POST /webhooks/test/open first."}

    # Read raw body
    try:
        raw_body = await request.body()
        body_str = raw_body.decode("utf-8", errors="replace")
    except Exception:
        body_str = ""

    # Try to parse body as JSON or form
    body_parsed: Any = None
    content_type = str(request.headers.get("content-type") or "")
    if "application/json" in content_type:
        try:
            body_parsed = json.loads(body_str)
        except Exception:
            body_parsed = body_str
    elif "application/x-www-form-urlencoded" in content_type or "multipart/form-data" in content_type:
        try:
            form = await request.form()
            body_parsed = dict(form)
        except Exception:
            body_parsed = body_str
    else:
        body_parsed = body_str

    now = datetime.now(timezone.utc)
    capture_id = uuid.uuid4().hex[:12]
    capture = {
        "capture_id": capture_id,
        "received_at": now.isoformat(),
        "method": str(request.method),
        "path": str(request.url.path),
        "extra_path": path or "",
        "query_params": dict(request.query_params),
        "headers": dict(request.headers),
        "content_type": content_type,
        "body_raw": body_str,
        "body_parsed": body_parsed,
        "source_ip": str(getattr(request.client, "host", "") or ""),
    }

    fname = f"capture_{now.strftime('%Y%m%dT%H%M%S')}_{capture_id}.json"
    (_WEBHOOK_TEST_DIR / fname).write_text(json.dumps(capture, indent=2, ensure_ascii=False), encoding="utf-8")

    return {"ok": True, "capture_id": capture_id, "saved_to": f"webhook_test/{fname}"}


@router.post("/call-updated")
async def handle_call_updated_webhook_form(
    request: Request,
    db: Session = Depends(get_session),
    call_id: str = Form(...),
    account_id: str = Form(...),
    agent: str = Form(...),
    record_path: str = Form(""),
    duration: Optional[int] = Form(None),
    crm_url: str = Form(""),
    customer: str = Form(""),
    token: str = Form(""),
) -> dict[str, Any]:
    """
    Compatibility endpoint for CRM managers using:
      POST /api/webhooks/call-updated
      Content-Type: application/x-www-form-urlencoded
    """
    payload = CallEndedWebhookPayload(
        call_id=call_id,
        account_id=account_id,
        agent=agent,
        record_path=record_path,
        duration=duration,
        crm_url=crm_url,
        customer=customer,
        token=token,
    )
    return await _handle_call_webhook(
        payload=payload,
        request=request,
        db=db,
        webhook_type="call-updated",
        compat_mode="form-urlencoded",
    )
