import asyncio
import hmac
import json
import re
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Optional
from urllib.parse import unquote, urlparse

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import func as _sql_func, or_ as _sql_or
from sqlmodel import Session, select

from ui.backend.config import settings
from ui.backend.database import engine as _db_engine, get_session
from ui.backend.models.app_state_kv import AppStateKV
from ui.backend.models.crm import CRMCall, CRMPair
from ui.backend.models.job import Job
from ui.backend.models.pipeline_run import PipelineRun
from ui.backend.services.run_status import (
    derive_effective_run_status,
    is_active_run_like,
    is_terminal_run_like,
    normalize_state_token,
    reconcile_run_row_status,
)

router = APIRouter(prefix="/webhooks", tags=["webhooks"])

_WEBHOOK_DIR = settings.ui_data_dir / "_webhooks"
_CALL_ENDED_CONFIG_FILE = _WEBHOOK_DIR / "call_ended_config.json"
_WEBHOOK_INBOX_DIR = _WEBHOOK_DIR / "inbox"
_LIVE_QUEUE_FILE = _WEBHOOK_DIR / "live_queue.json"
_REJECTED_WEBHOOKS_FILE = _WEBHOOK_DIR / "rejections.json"
_REJECTED_WEBHOOKS_ARCHIVE_FILE = _WEBHOOK_DIR / "rejections_archive.json"
_REJECTED_WEBHOOKS_CORRUPT_PREFIX = "rejections.corrupt."
_WEBHOOK_TEST_DIR = settings.ui_data_dir / "webhook_test"
_WEBHOOK_TEST_SESSION_FILE = _WEBHOOK_TEST_DIR / "_session.json"
_LIVE_QUEUE_LOCK = asyncio.Lock()
_LIVE_DISPATCHER_TASK: Optional[asyncio.Task] = None
_STATE_KEY_LIVE_QUEUE = "webhooks.live_queue"
_STATE_KEY_REJECTIONS = "webhooks.rejections"
_STATE_KEY_REJECTIONS_ARCHIVE = "webhooks.rejections_archive"
_STATE_KEY_LIVE_CONFIG = "webhooks.live_config"


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
    agent_continuity_filter_enabled: bool = True
    agent_continuity_pair_tag_fallback_enabled: bool = True
    agent_continuity_reject_multi_agent_pair_tags: bool = True
    live_pipeline_ids: list[str] = Field(default_factory=list)
    default_pipeline_id: str = ""
    pipeline_by_agent: dict[str, str] = Field(default_factory=dict)
    transcription_model: str = "gpt-5.4"
    transcription_timeout_s: int = 900
    transcription_poll_interval_s: float = 2.0
    backfill_historical_transcripts: bool = True
    backfill_timeout_s: int = 5400
    backfill_no_progress_timeout_s: int = 300
    max_live_running: int = 5
    auto_retry_enabled: bool = True
    retry_max_attempts: int = 2
    retry_delay_s: int = 45
    retry_on_server_error: bool = True
    retry_on_rate_limit: bool = True
    retry_on_timeout: bool = True
    run_payload: dict[str, Any] = Field(default_factory=dict)


def _default_call_ended_config() -> dict[str, Any]:
    return {
        "enabled": True,
        "ingest_only": True,
        "trigger_pipeline": True,
        "agent_continuity_filter_enabled": True,
        "agent_continuity_pair_tag_fallback_enabled": True,
        "agent_continuity_reject_multi_agent_pair_tags": True,
        "live_pipeline_ids": [],
        "default_pipeline_id": "",
        "pipeline_by_agent": {},
        "transcription_model": "gpt-5.4",
        "transcription_timeout_s": int(settings.crm_webhook_transcription_timeout_s or 900),
        "transcription_poll_interval_s": float(settings.crm_webhook_transcription_poll_interval_s or 2.0),
        "backfill_historical_transcripts": True,
        "backfill_timeout_s": 5400,
        "backfill_no_progress_timeout_s": 300,
        "max_live_running": 5,
        "auto_retry_enabled": True,
        "retry_max_attempts": 2,
        "retry_delay_s": 45,
        "retry_on_server_error": True,
        "retry_on_rate_limit": True,
        "retry_on_timeout": True,
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
    base["agent_continuity_filter_enabled"] = bool(base.get("agent_continuity_filter_enabled", True))
    base["agent_continuity_pair_tag_fallback_enabled"] = bool(
        base.get("agent_continuity_pair_tag_fallback_enabled", True)
    )
    base["agent_continuity_reject_multi_agent_pair_tags"] = bool(
        base.get("agent_continuity_reject_multi_agent_pair_tags", True)
    )
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
    base["backfill_historical_transcripts"] = bool(base.get("backfill_historical_transcripts", True))
    try:
        base["backfill_timeout_s"] = max(120, min(int(base.get("backfill_timeout_s") or 5400), 21600))
    except Exception:
        base["backfill_timeout_s"] = 5400
    try:
        base["backfill_no_progress_timeout_s"] = max(
            30,
            min(int(base.get("backfill_no_progress_timeout_s") or 300), 3600),
        )
    except Exception:
        base["backfill_no_progress_timeout_s"] = 300
    try:
        base["max_live_running"] = max(1, min(int(base.get("max_live_running") or 5), 64))
    except Exception:
        base["max_live_running"] = 5
    base["auto_retry_enabled"] = bool(base.get("auto_retry_enabled", True))
    try:
        base["retry_max_attempts"] = max(0, min(int(base.get("retry_max_attempts") or 2), 10))
    except Exception:
        base["retry_max_attempts"] = 2
    try:
        base["retry_delay_s"] = max(5, min(int(base.get("retry_delay_s") or 45), 3600))
    except Exception:
        base["retry_delay_s"] = 45
    base["retry_on_server_error"] = bool(base.get("retry_on_server_error", True))
    base["retry_on_rate_limit"] = bool(base.get("retry_on_rate_limit", True))
    base["retry_on_timeout"] = bool(base.get("retry_on_timeout", True))

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
    if _live_state_use_db():
        ok, raw = _load_state_blob_db(_STATE_KEY_LIVE_CONFIG)
        if ok and isinstance(raw, dict):
            return _normalize_call_ended_config(raw)
    _WEBHOOK_DIR.mkdir(parents=True, exist_ok=True)
    if not _CALL_ENDED_CONFIG_FILE.exists():
        cfg = _default_call_ended_config()
        _CALL_ENDED_CONFIG_FILE.write_text(json.dumps(cfg, indent=2, ensure_ascii=False), encoding="utf-8")
        if _live_state_use_db():
            _save_state_blob_db(_STATE_KEY_LIVE_CONFIG, cfg)
        return cfg
    try:
        raw = json.loads(_CALL_ENDED_CONFIG_FILE.read_text(encoding="utf-8"))
    except Exception:
        raw = {}
    cfg = _normalize_call_ended_config(raw)
    # Promote local file into DB on first read so both VMs converge.
    if _live_state_use_db():
        _save_state_blob_db(_STATE_KEY_LIVE_CONFIG, cfg)
    return cfg


def _save_call_ended_config(cfg: dict[str, Any]) -> dict[str, Any]:
    norm = _normalize_call_ended_config(cfg)
    if _live_state_use_db():
        _save_state_blob_db(_STATE_KEY_LIVE_CONFIG, norm)
    _WEBHOOK_DIR.mkdir(parents=True, exist_ok=True)
    _CALL_ENDED_CONFIG_FILE.write_text(json.dumps(norm, indent=2, ensure_ascii=False), encoding="utf-8")
    return norm


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parse_iso(raw: Any) -> Optional[datetime]:
    s = str(raw or "").strip()
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(s)
    except Exception:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _live_state_use_db() -> bool:
    return bool(getattr(settings, "live_state_use_db", True))


def _live_state_file_fallback() -> bool:
    return bool(getattr(settings, "live_state_file_fallback", False))


def _load_state_blob_db(key: str) -> tuple[bool, Any]:
    try:
        with Session(_db_engine) as s:
            row = s.get(AppStateKV, str(key))
            if row is None:
                return True, None
            raw = str(getattr(row, "value_json", "") or "").strip()
            if not raw:
                return True, None
            return True, json.loads(raw)
    except Exception:
        return False, None


def _save_state_blob_db(key: str, value: Any) -> bool:
    try:
        payload = json.dumps(value, ensure_ascii=False)
    except Exception:
        return False
    try:
        with Session(_db_engine) as s:
            row = s.get(AppStateKV, str(key))
            if row is None:
                row = AppStateKV(key=str(key))
            row.value_json = payload
            row.updated_at = datetime.utcnow()
            s.add(row)
            s.commit()
        return True
    except Exception:
        return False


def _normalize_dict_list(raw: Any) -> list[dict[str, Any]]:
    if not isinstance(raw, list):
        return []
    out: list[dict[str, Any]] = []
    for item in raw:
        if isinstance(item, dict):
            out.append(item)
    return out


def _load_live_queue() -> list[dict[str, Any]]:
    if _live_state_use_db():
        ok, raw = _load_state_blob_db(_STATE_KEY_LIVE_QUEUE)
        if ok:
            return _normalize_dict_list(raw)
    _WEBHOOK_DIR.mkdir(parents=True, exist_ok=True)
    if not _LIVE_QUEUE_FILE.exists():
        return []
    try:
        raw = json.loads(_LIVE_QUEUE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return []
    return _normalize_dict_list(raw)


def _save_live_queue(items: list[dict[str, Any]]) -> None:
    normalized = _normalize_dict_list(items)
    wrote_db = False
    if _live_state_use_db():
        wrote_db = _save_state_blob_db(_STATE_KEY_LIVE_QUEUE, normalized)
    if wrote_db and not _live_state_file_fallback():
        return
    _WEBHOOK_DIR.mkdir(parents=True, exist_ok=True)
    _LIVE_QUEUE_FILE.write_text(
        json.dumps(normalized, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )


def _default_rejections_store() -> dict[str, Any]:
    return {
        "updated_at": _utc_now_iso(),
        "items": [],
    }


def _default_rejections_archive_store() -> dict[str, Any]:
    return {
        "updated_at": _utc_now_iso(),
        "items": [],
    }


def _write_json_atomic(path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp-{uuid.uuid4().hex}")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)


def _normalize_rejections_store(raw: Any) -> dict[str, Any]:
    base = _default_rejections_store()
    if not isinstance(raw, dict):
        return base
    items_raw = raw.get("items")
    items: list[dict[str, Any]] = []
    if isinstance(items_raw, list):
        for row in items_raw:
            if isinstance(row, dict):
                items.append(dict(row))
    base["updated_at"] = str(raw.get("updated_at") or _utc_now_iso())
    base["items"] = items
    return base


def _normalize_rejections_archive_store(raw: Any) -> dict[str, Any]:
    base = _default_rejections_archive_store()
    if not isinstance(raw, dict):
        return base
    items_raw = raw.get("items")
    items: list[dict[str, Any]] = []
    if isinstance(items_raw, list):
        for row in items_raw:
            if isinstance(row, dict):
                items.append(dict(row))
    base["updated_at"] = str(raw.get("updated_at") or _utc_now_iso())
    base["items"] = items
    return base


def _load_rejections_store() -> dict[str, Any]:
    if _live_state_use_db():
        ok, raw = _load_state_blob_db(_STATE_KEY_REJECTIONS)
        if ok:
            if raw is None:
                data = _default_rejections_store()
                _save_rejections_store(data)
                return data
            return _normalize_rejections_store(raw)
    _WEBHOOK_DIR.mkdir(parents=True, exist_ok=True)
    if not _REJECTED_WEBHOOKS_FILE.exists():
        data = _default_rejections_store()
        _write_json_atomic(_REJECTED_WEBHOOKS_FILE, data)
        return data
    try:
        raw = json.loads(_REJECTED_WEBHOOKS_FILE.read_text(encoding="utf-8"))
    except Exception:
        # Keep a copy of the bad payload for forensic recovery instead of
        # silently overwriting it with an empty store.
        try:
            ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
            corrupt_path = _REJECTED_WEBHOOKS_FILE.with_name(f"{_REJECTED_WEBHOOKS_CORRUPT_PREFIX}{ts}.json")
            _REJECTED_WEBHOOKS_FILE.replace(corrupt_path)
        except Exception:
            pass
        raw = {}
    data = _normalize_rejections_store(raw)
    _write_json_atomic(_REJECTED_WEBHOOKS_FILE, data)
    return data


def _load_rejections_archive_store() -> dict[str, Any]:
    if _live_state_use_db():
        ok, raw = _load_state_blob_db(_STATE_KEY_REJECTIONS_ARCHIVE)
        if ok:
            if raw is None:
                data = _default_rejections_archive_store()
                _save_rejections_archive_store(data)
                return data
            return _normalize_rejections_archive_store(raw)
    _WEBHOOK_DIR.mkdir(parents=True, exist_ok=True)
    if not _REJECTED_WEBHOOKS_ARCHIVE_FILE.exists():
        data = _default_rejections_archive_store()
        _write_json_atomic(_REJECTED_WEBHOOKS_ARCHIVE_FILE, data)
        return data
    try:
        raw = json.loads(_REJECTED_WEBHOOKS_ARCHIVE_FILE.read_text(encoding="utf-8"))
    except Exception:
        raw = {}
    data = _normalize_rejections_archive_store(raw)
    _write_json_atomic(_REJECTED_WEBHOOKS_ARCHIVE_FILE, data)
    return data


def _save_rejections_store(data: dict[str, Any]) -> dict[str, Any]:
    norm = _normalize_rejections_store(data)
    norm["updated_at"] = _utc_now_iso()
    wrote_db = False
    if _live_state_use_db():
        wrote_db = _save_state_blob_db(_STATE_KEY_REJECTIONS, norm)
    if (not wrote_db) or _live_state_file_fallback():
        _WEBHOOK_DIR.mkdir(parents=True, exist_ok=True)
        _write_json_atomic(_REJECTED_WEBHOOKS_FILE, norm)
    return norm


def _save_rejections_archive_store(data: dict[str, Any]) -> dict[str, Any]:
    norm = _normalize_rejections_archive_store(data)
    norm["updated_at"] = _utc_now_iso()
    wrote_db = False
    if _live_state_use_db():
        wrote_db = _save_state_blob_db(_STATE_KEY_REJECTIONS_ARCHIVE, norm)
    if (not wrote_db) or _live_state_file_fallback():
        _WEBHOOK_DIR.mkdir(parents=True, exist_ok=True)
        _write_json_atomic(_REJECTED_WEBHOOKS_ARCHIVE_FILE, norm)
    return norm


def _append_rejected_webhook(item: dict[str, Any]) -> dict[str, Any]:
    now_iso = _utc_now_iso()
    store = _load_rejections_store()
    items = store.get("items")
    if not isinstance(items, list):
        items = []
    row = dict(item or {})
    row.setdefault("id", str(uuid.uuid4()))
    row.setdefault("status", "rejected")
    row.setdefault("created_at", now_iso)
    row["updated_at"] = now_iso
    items.append(row)
    # Keep recent 20k rows.
    if len(items) > 20000:
        items = items[-20000:]
    store["items"] = items
    _save_rejections_store(store)
    return row


def _append_ingress_rejection(
    *,
    reason: str,
    message: str,
    webhook_type: str,
    payload: CallEndedWebhookPayload,
    stored: Optional[dict[str, Any]] = None,
    cfg: Optional[dict[str, Any]] = None,
    status: str = "rejected",
) -> dict[str, Any]:
    account_id = str(payload.account_id or "").strip()
    call_id = str(payload.call_id or "").strip()
    agent = str(payload.agent or "").strip()
    customer = str(payload.customer or "").strip()
    crm_url = str(payload.crm_url or "").strip()
    pipeline_ids = _resolve_live_pipeline_ids(cfg or {})
    return _append_rejected_webhook(
        {
            "source": "ingress",
            "reason": str(reason or "ingress_error"),
            "status": str(status or "rejected"),
            "message": str(message or "Webhook ingress rejected."),
            "webhook_type": str(webhook_type or "call-updated"),
            "event_id": str((stored or {}).get("event_id") or ""),
            "event_file": str((stored or {}).get("file") or ""),
            "sales_agent": agent,
            "customer": customer,
            "call_id": call_id,
            "account_id": account_id,
            "crm_url": crm_url,
            "pipeline_ids": pipeline_ids,
            "pair": {
                "crm_url": crm_url,
                "account_id": account_id,
                "agent": agent,
                "customer": customer,
            },
            "payload": payload.model_dump(),
        }
    )


def _rejection_sort_key(row: dict[str, Any]) -> str:
    if not isinstance(row, dict):
        return ""
    return str(
        row.get("created_at")
        or row.get("updated_at")
        or row.get("stashed_at")
        or "",
    )


def _load_json_list(path: Path) -> list[dict[str, Any]]:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return []
    if not isinstance(raw, list):
        return []
    out: list[dict[str, Any]] = []
    for row in raw:
        if isinstance(row, dict):
            out.append(dict(row))
    return out


def _resolve_event_payload(event_file: Any) -> dict[str, Any]:
    raw = str(event_file or "").strip()
    if not raw:
        return {}
    candidates: list[Path] = []
    p = Path(raw)
    if p.is_absolute():
        candidates.append(p)
    else:
        candidates.extend(
            [
                Path(raw),
                settings.ui_data_dir / raw,
                settings.ui_data_dir.parent / raw,
                _WEBHOOK_DIR / raw,
            ]
        )
    for candidate in candidates:
        try:
            if not candidate.exists() or not candidate.is_file():
                continue
            obj = json.loads(candidate.read_text(encoding="utf-8"))
            if isinstance(obj, dict):
                payload = obj.get("payload")
                if isinstance(payload, dict):
                    return dict(payload)
                if all(k in obj for k in ("call_id", "account_id")):
                    return dict(obj)
        except Exception:
            continue
    return {}


def _infer_rejection_reason(error_text: str) -> str:
    raw = str(error_text or "").strip().lower()
    if not raw:
        return ""
    known = (
        "no_call_history",
        "multi_agent_pair",
        "payload_agent_mismatch",
        "resolved_agent_mismatch",
        "no_agent_history",
        "missing_account_id",
        "no_pair",
        "pair_resolution_failed",
        "missing_call_id",
        "webhook_disabled",
    )
    for key in known:
        if key in raw:
            return key
    if "rejected" in raw:
        return "rejected"
    return ""


def _derive_rejected_from_live_queue(limit: int = 20000) -> list[dict[str, Any]]:
    lim = max(1, min(int(limit or 20000), 20000))
    files: list[Path] = [_LIVE_QUEUE_FILE]
    files.extend(sorted(_WEBHOOK_DIR.glob("live_queue.pre*.json"), reverse=True))
    seen: set[str] = set()
    out: list[dict[str, Any]] = []

    for path in files:
        for item in _load_json_list(path):
            last_error = str(item.get("last_error") or "")
            reason = _infer_rejection_reason(last_error)
            if not reason:
                continue
            base_id = str(item.get("id") or item.get("run_id") or item.get("event_id") or "").strip()
            if not base_id:
                continue
            rid = f"derived:{base_id}"
            if rid in seen:
                continue
            seen.add(rid)
            event_file = str(item.get("event_file") or "").strip()
            payload = item.get("payload") if isinstance(item.get("payload"), dict) else {}
            if not payload and event_file:
                payload = _resolve_event_payload(event_file)

            pipeline_id = str(item.get("pipeline_id") or "").strip()
            row = {
                "id": rid,
                "source": "live_queue_derived",
                "reason": reason,
                "status": "rejected",
                "message": last_error or "Rejected by policy.",
                "webhook_type": str(item.get("webhook_type") or "call-updated"),
                "event_id": str(item.get("event_id") or "").strip(),
                "event_file": event_file,
                "sales_agent": str(item.get("sales_agent") or "").strip(),
                "customer": str(item.get("customer") or "").strip(),
                "call_id": str(item.get("call_id") or "").strip(),
                "account_id": str(((item.get("pair") or {}).get("account_id") if isinstance(item.get("pair"), dict) else "") or ""),
                "crm_url": str(((item.get("pair") or {}).get("crm_url") if isinstance(item.get("pair"), dict) else "") or ""),
                "pipeline_ids": [pipeline_id] if pipeline_id else [],
                "payload": payload,
                "created_at": str(item.get("created_at") or item.get("updated_at") or ""),
                "updated_at": str(item.get("updated_at") or item.get("created_at") or ""),
            }
            out.append(row)
            if len(out) >= lim:
                break
        if len(out) >= lim:
            break

    out.sort(key=_rejection_sort_key, reverse=True)
    return out[:lim]


def _mark_rejection_queued_manual(rejection_id: str, run_ids: list[str], pipeline_ids: list[str]) -> Optional[dict[str, Any]]:
    rid = str(rejection_id or "").strip()
    if not rid:
        return None
    store = _load_rejections_store()
    items = store.get("items")
    if not isinstance(items, list):
        return None
    for idx, row in enumerate(items):
        if not isinstance(row, dict):
            continue
        if str(row.get("id") or "").strip() != rid:
            continue
        updated = dict(row)
        updated["status"] = "queued_manual"
        updated["updated_at"] = _utc_now_iso()
        updated["moved_run_ids"] = [str(x) for x in (run_ids or []) if str(x)]
        updated["moved_pipeline_ids"] = [str(x) for x in (pipeline_ids or []) if str(x)]
        items[idx] = updated
        store["items"] = items
        _save_rejections_store(store)
        return updated
    archive = _load_rejections_archive_store()
    arch_items = archive.get("items")
    if not isinstance(arch_items, list):
        return None
    for idx, row in enumerate(arch_items):
        if not isinstance(row, dict):
            continue
        if str(row.get("id") or "").strip() != rid:
            continue
        updated = dict(row)
        updated["status"] = "queued_manual"
        updated["updated_at"] = _utc_now_iso()
        updated["moved_run_ids"] = [str(x) for x in (run_ids or []) if str(x)]
        updated["moved_pipeline_ids"] = [str(x) for x in (pipeline_ids or []) if str(x)]
        arch_items[idx] = updated
        archive["items"] = arch_items
        _save_rejections_archive_store(archive)
        return updated
    # If this record is derived from queue snapshots (legacy fallback),
    # persist a concrete row in active rejections so status changes remain visible.
    derived_row, source = _find_rejected_webhook(rid, include_archive=True)
    if source == "live_queue_derived" and isinstance(derived_row, dict):
        new_row = dict(derived_row)
        new_row["status"] = "queued_manual"
        new_row["updated_at"] = _utc_now_iso()
        new_row["moved_run_ids"] = [str(x) for x in (run_ids or []) if str(x)]
        new_row["moved_pipeline_ids"] = [str(x) for x in (pipeline_ids or []) if str(x)]
        store = _load_rejections_store()
        active_items = store.get("items")
        if not isinstance(active_items, list):
            active_items = []
        active_items.append(new_row)
        if len(active_items) > 20000:
            active_items = active_items[-20000:]
        store["items"] = active_items
        _save_rejections_store(store)
        return new_row
    return None


def _list_rejected_webhooks(
    limit: int = 200,
    include_non_rejected: bool = True,
    include_archive: bool = True,
) -> list[dict[str, Any]]:
    lim = max(1, min(int(limit or 200), 20000))
    items: list[dict[str, Any]] = []

    def _collect(rows: Any, source: str) -> None:
        if not isinstance(rows, list):
            return
        for row in rows:
            if not isinstance(row, dict):
                continue
            status = str(row.get("status") or "rejected").strip().lower()
            if not include_non_rejected and status != "rejected":
                continue
            out = dict(row)
            out["source"] = str(out.get("source") or source)
            items.append(out)

    store = _load_rejections_store()
    store_rows = store.get("items") or []
    # Track IDs that exist in the store with a non-rejected status (e.g. queued_manual).
    # Derived items with these IDs must not re-appear as rejected.
    non_rejected_store_ids: set[str] = set()
    for _r in store_rows:
        if not isinstance(_r, dict):
            continue
        _st = str(_r.get("status") or "rejected").strip().lower()
        if _st != "rejected":
            non_rejected_store_ids.add(str(_r.get("id") or "").strip())
    _collect(store_rows, "active")
    archive_rows: list = []
    if include_archive:
        archive = _load_rejections_archive_store()
        archive_rows = archive.get("items") or []
        for _r in archive_rows:
            if not isinstance(_r, dict):
                continue
            _st = str(_r.get("status") or "rejected").strip().lower()
            if _st != "rejected":
                non_rejected_store_ids.add(str(_r.get("id") or "").strip())
        _collect(archive_rows, "archive")
    # Always try derived fallback for items that aren't already tracked in the store.
    # Skip any derived item whose ID already exists in the store with a moved/non-rejected status.
    derived = _derive_rejected_from_live_queue(limit=20000)
    store_ids: set[str] = {
        str((_r or {}).get("id") or "").strip()
        for _r in list(store_rows) + list(archive_rows)
        if isinstance(_r, dict)
    }
    new_derived: list[dict[str, Any]] = []
    for derived_row in derived:
        if not isinstance(derived_row, dict):
            continue
        did = str(derived_row.get("id") or "").strip()
        if did in store_ids:
            continue  # already in store (either rejected or queued_manual)
        if did in non_rejected_store_ids:
            continue  # was moved, don't re-derive as rejected
        out = dict(derived_row)
        out["source"] = "live_queue_derived"
        items.append(out)
        new_derived.append(out)
    # Promote derived items into the shared DB store so all VMs see them.
    if new_derived:
        try:
            _store = _load_rejections_store()
            _store_items = _store.get("items") if isinstance(_store.get("items"), list) else []
            _existing_ids = {str(r.get("id") or "").strip() for r in _store_items if isinstance(r, dict)}
            _added = False
            for _row in new_derived:
                _rid = str(_row.get("id") or "").strip()
                if _rid and _rid not in _existing_ids:
                    _store_items.append(_row)
                    _existing_ids.add(_rid)
                    _added = True
            if _added:
                if len(_store_items) > 20000:
                    _store_items = _store_items[-20000:]
                _store["items"] = _store_items
                _save_rejections_store(_store)
        except Exception:
            pass

    items.sort(key=_rejection_sort_key, reverse=True)
    return items[:lim]


def _find_rejected_webhook(rejection_id: str, include_archive: bool = True) -> tuple[Optional[dict[str, Any]], str]:
    rid = str(rejection_id or "").strip()
    if not rid:
        return None, ""

    store = _load_rejections_store()
    rows = store.get("items") if isinstance(store.get("items"), list) else []
    for row in rows:
        if not isinstance(row, dict):
            continue
        if str(row.get("id") or "").strip() != rid:
            continue
        out = dict(row)
        out["source"] = str(out.get("source") or "active")
        return out, "active"

    if include_archive:
        archive = _load_rejections_archive_store()
        rows = archive.get("items") if isinstance(archive.get("items"), list) else []
        for row in rows:
            if not isinstance(row, dict):
                continue
            if str(row.get("id") or "").strip() != rid:
                continue
            out = dict(row)
            out["source"] = str(out.get("source") or "archive")
            return out, "archive"

    for row in _derive_rejected_from_live_queue(limit=20000):
        if str((row or {}).get("id") or "").strip() == rid:
            out = dict(row)
            out["source"] = str(out.get("source") or "live_queue_derived")
            return out, "live_queue_derived"

    return None, ""


def _get_rejected_webhook_stats() -> dict[str, Any]:
    active = _load_rejections_store()
    archive = _load_rejections_archive_store()
    rows: list[dict[str, Any]] = []
    for src in (active.get("items"), archive.get("items")):
        if not isinstance(src, list):
            continue
        for row in src:
            if isinstance(row, dict):
                rows.append(row)
    by_reason: dict[str, int] = {}
    for row in rows:
        reason = str((row or {}).get("reason") or "unknown").strip() or "unknown"
        by_reason[reason] = int(by_reason.get(reason, 0)) + 1
    updated_candidates = [
        str(active.get("updated_at") or "").strip(),
        str(archive.get("updated_at") or "").strip(),
    ]
    updated_at = max(updated_candidates) if any(updated_candidates) else _utc_now_iso()
    return {
        "rejected_webhooks_total": len(rows),
        "rejected_by_reason": by_reason,
        "updated_at": updated_at,
    }


async def _touch_live_queue_item(
    *,
    run_id: str,
    state: Optional[str] = None,
    last_error: Optional[str] = None,
) -> None:
    rid = str(run_id or "").strip()
    if not rid:
        return
    now_iso = _utc_now_iso()
    async with _LIVE_QUEUE_LOCK:
        queue = _load_live_queue()
        changed = False
        for row in queue:
            if not isinstance(row, dict):
                continue
            if str(row.get("run_id") or "").strip() != rid:
                continue
            row["updated_at"] = now_iso
            if state:
                row["state"] = str(state)
            if last_error is not None:
                row["last_error"] = str(last_error)
            changed = True
            break
        if changed:
            _save_live_queue(queue)


def _build_step_skeleton(pipeline_id: str) -> list[dict[str, Any]]:
    try:
        from ui.backend.routers.pipelines import _find_file

        _, pipeline_def = _find_file(pipeline_id)
        steps = pipeline_def.get("steps", [])
        return [
            {
                "agent_id": str(step.get("agent_id", "")),
                "agent_name": "",
                "model": "",
                "state": "waiting",
                "status": "waiting",
                "content": "",
                "error_msg": "",
                "run_origin": "webhook",
            }
            for step in steps
        ]
    except Exception:
        return []


def _upsert_pipeline_run_stub(
    *,
    run_id: str,
    pipeline_id: str,
    pipeline_name: str,
    sales_agent: str,
    customer: str,
    call_id: str,
    status: str,
    log_line: str = "",
    run_origin: str = "webhook",
) -> None:
    now_iso = _utc_now_iso()
    _status = str(status or "").strip().lower()
    _terminal_statuses = {"done", "completed", "error", "failed", "cancelled"}
    _running_like = {"running", "loading", "started", "in_progress", "queued", "preparing", "retrying"}
    _cancel_like = {"cancelled", "canceled"}
    try:
        with Session(_db_engine) as s:
            row = s.get(PipelineRun, run_id)
            if row is None:
                _steps = _build_step_skeleton(pipeline_id)
                if _status == "preparing" and _steps:
                    # Preflight/backfill is active, but no pipeline step has started yet.
                    # Keep step execution idle to avoid showing agent nodes as running.
                    _steps[0]["state"] = "preparing"
                    _steps[0]["status"] = "preparing"
                row = PipelineRun(
                    id=run_id,
                    pipeline_id=pipeline_id,
                    pipeline_name=pipeline_name,
                    sales_agent=sales_agent,
                    customer=customer,
                    call_id=call_id,
                    status=status,
                    run_origin=str(run_origin or "webhook").strip(),
                    started_at=datetime.now(timezone.utc).replace(tzinfo=None),
                    finished_at=(
                        datetime.now(timezone.utc).replace(tzinfo=None)
                        if _status in _terminal_statuses
                        else None
                    ),
                    steps_json=json.dumps(_steps, ensure_ascii=False),
                    log_json=json.dumps(
                        ([{"ts": now_iso, "text": log_line, "level": "pipeline"}] if log_line else []),
                        ensure_ascii=False,
                    ),
                )
                s.add(row)
            else:
                row.pipeline_id = pipeline_id
                row.pipeline_name = pipeline_name
                row.sales_agent = sales_agent
                row.customer = customer
                row.call_id = call_id
                existing_status = str(getattr(row, "status", "") or "").strip().lower()
                # Do not regress successful terminal runs back to active states due
                # late queue/stub updates arriving out of order.
                lock_done_status = existing_status in {"done", "completed"} and _status not in {"done", "completed"}
                if not lock_done_status:
                    row.status = status
                    if _status in _terminal_statuses:
                        row.finished_at = datetime.now(timezone.utc).replace(tzinfo=None)
                    else:
                        row.finished_at = None
                elif row.finished_at is None:
                    row.finished_at = datetime.now(timezone.utc).replace(tzinfo=None)
                try:
                    parsed_steps = json.loads(str(row.steps_json or "[]"))
                except Exception:
                    parsed_steps = []
                if (not lock_done_status) and isinstance(parsed_steps, list) and parsed_steps:
                    changed_steps = False
                    if _status == "preparing":
                        # Show visible progress on canvas while backfill/transcription is active.
                        first = parsed_steps[0] if isinstance(parsed_steps[0], dict) else None
                        if isinstance(first, dict):
                            prev = str(first.get("state") or first.get("status") or "").strip().lower()
                            if prev in {"", "waiting", "pending"}:
                                # Preflight should not imply an agent step is executing yet.
                                first["state"] = "preparing"
                                first["status"] = "preparing"
                                changed_steps = True
                    if _status in _cancel_like:
                        for step in parsed_steps:
                            if not isinstance(step, dict):
                                continue
                            prev = str(step.get("state") or step.get("status") or "").strip().lower()
                            if prev in _running_like:
                                step["state"] = "cancelled"
                                step["status"] = "cancelled"
                                changed_steps = True
                    elif _status in {"failed", "error"}:
                        for step in parsed_steps:
                            if not isinstance(step, dict):
                                continue
                            prev = str(step.get("state") or step.get("status") or "").strip().lower()
                            if prev in _running_like:
                                step["state"] = "error"
                                step["status"] = "error"
                                if not str(step.get("error_msg") or "").strip():
                                    step["error_msg"] = "Run failed during preflight or dispatch."
                                changed_steps = True
                    elif _status in {"retrying", "queued"}:
                        # Reset failed/error step states when a failed run is manually
                        # moved back to the waiting queue, so stale failures do not
                        # keep the card in "failed" after requeue.
                        for step in parsed_steps:
                            if not isinstance(step, dict):
                                continue
                            prev = str(step.get("state") or step.get("status") or "").strip().lower()
                            if prev in {"failed", "error"}:
                                step["state"] = "waiting"
                                step["status"] = "waiting"
                                step["error_msg"] = ""
                                changed_steps = True
                    if changed_steps:
                        row.steps_json = json.dumps(parsed_steps, ensure_ascii=False)
                if log_line:
                    logs = []
                    try:
                        raw_logs = json.loads(str(row.log_json or "[]"))
                        if isinstance(raw_logs, list):
                            logs = raw_logs
                    except Exception:
                        logs = []
                    logs.append({"ts": now_iso, "text": log_line, "level": "pipeline"})
                    row.log_json = json.dumps(logs[-400:], ensure_ascii=False)
                s.add(row)
            s.commit()
    except Exception:
        pass


def _count_running_pipeline_runs(active_queue_items: Optional[list[dict[str, Any]]] = None) -> int:
    # Prefer queue-driven counting to avoid stale DB "running" rows blocking slots forever.
    if isinstance(active_queue_items, list):
        total = 0
        for item in active_queue_items:
            if not isinstance(item, dict):
                continue
            state = str(item.get("state") or "").strip().lower()
            # preparing consumes a live slot (transcription/backfill work is active).
            if state in {"running", "preparing"}:
                total += 1
        return total
    try:
        with Session(_db_engine) as s:
            rows = s.exec(
                select(PipelineRun).where(PipelineRun.status == "running")
            ).all()
            total = 0
            for row in rows or []:
                run_origin = ""
                try:
                    parsed_steps = json.loads(str(getattr(row, "steps_json", "") or "[]"))
                    if isinstance(parsed_steps, list):
                        for step in parsed_steps:
                            if not isinstance(step, dict):
                                continue
                            ro = str(step.get("run_origin") or "").strip().lower()
                            if ro in {"webhook", "production"}:
                                run_origin = "webhook"
                                break
                            if ro in {"local", "test"} and not run_origin:
                                run_origin = "local"
                except Exception:
                    run_origin = ""
                if run_origin == "webhook":
                    total += 1
            return total
    except Exception:
        return 0


def _is_retryable_text(err_text: str, cfg: dict[str, Any]) -> bool:
    txt = str(err_text or "").lower()
    if not txt:
        return False
    if bool(cfg.get("retry_on_rate_limit", True)):
        for k in ("rate limit", "too many requests", "429", "quota", "tokens per minute", "tpm"):
            if k in txt:
                return True
    if bool(cfg.get("retry_on_timeout", True)):
        for k in ("timeout", "timed out", "deadline exceeded", "read timeout", "connection reset"):
            if k in txt:
                return True
    if bool(cfg.get("retry_on_server_error", True)):
        for k in ("500", "502", "503", "504", "bad gateway", "service unavailable", "upstream error"):
            if k in txt:
                return True
    return False


def _extract_run_error(run_row: Optional[PipelineRun]) -> str:
    if not run_row:
        return ""
    errors: list[str] = []
    try:
        parsed = json.loads(str(run_row.steps_json or "[]"))
        if isinstance(parsed, list):
            for step in parsed:
                if isinstance(step, dict):
                    st = str(step.get("state") or step.get("status") or "").lower()
                    if st in {"failed", "error"}:
                        msg = str(step.get("error_msg") or "").strip()
                        if msg:
                            errors.append(msg)
    except Exception:
        pass
    if errors:
        return " | ".join(errors[:5])
    try:
        parsed_logs = json.loads(str(run_row.log_json or "[]"))
        if isinstance(parsed_logs, list):
            _keywords = (
                "error",
                "failed",
                "timeout",
                "timed out",
                "cancel",
                "interrupted",
                "restart",
                "exception",
            )
            for row in reversed(parsed_logs):
                if isinstance(row, dict):
                    txt = str(row.get("text") or "")
                    if txt and any(k in txt.lower() for k in _keywords):
                        return txt
    except Exception:
        pass
    _status = str(getattr(run_row, "status", "") or "").strip().lower()
    if _status == "cancelled":
        return "Run was cancelled."
    if _status in {"error", "failed"}:
        return "Run ended with an error before a step-level error was recorded (likely interrupted)."
    return ""


def _reconcile_pipeline_run_status(run_id: str) -> str:
    """
    Reconcile one pipeline_run row from step truth and return the effective status.
    """
    rid = str(run_id or "").strip()
    if not rid:
        return ""
    try:
        with Session(_db_engine) as s:
            row = s.get(PipelineRun, rid)
            if row is None:
                return ""
            effective, changed = reconcile_run_row_status(row)
            if changed:
                s.add(row)
                s.commit()
                return normalize_state_token(getattr(row, "status", "") or effective)
            return normalize_state_token(effective or getattr(row, "status", ""))
    except Exception:
        return ""


async def _wait_for_jobs(
    job_ids: list[str],
    timeout_s: int = 5400,
    no_progress_timeout_s: int = 300,
    progress_cb: Optional[Callable[[int, int, int], None]] = None,
) -> dict[str, Any]:
    def _job_status_text(value: Any) -> str:
        raw = getattr(value, "value", value)
        return str(raw or "").strip().lower()

    _ids = [str(x) for x in job_ids if str(x)]
    if not _ids:
        return {
            "ok": True,
            "failed": 0,
            "done": 0,
            "total": 0,
            "timed_out": False,
            "stalled": False,
            "failed_job_ids": [],
            "failed_job_errors": [],
        }
    deadline = time.monotonic() + max(60, int(timeout_s))
    stall_deadline = max(30, int(no_progress_timeout_s))
    _last_emit = 0.0
    _last_done = -1
    _last_failed = -1
    _last_running = -1
    _last_pending = -1
    _last_status_signature = ""
    _last_progress_at = time.monotonic()
    while True:
        with Session(_db_engine) as s:
            rows = s.exec(select(Job).where(Job.id.in_(_ids))).all()
        status_by_id = {str(r.id): _job_status_text(r.status) for r in rows}
        failed_rows = [r for r in rows if _job_status_text(r.status) == "failed"]
        failed_job_ids = [str(r.id) for r in failed_rows]
        failed_job_errors: list[str] = []
        for r in failed_rows:
            rid = str(r.id)
            err = str(r.error or r.message or "").strip()
            if err:
                failed_job_errors.append(f"{rid[:8]}: {err[:220]}")
        running = sum(1 for _id in _ids if status_by_id.get(_id) == "running")
        pending = sum(1 for _id in _ids if status_by_id.get(_id) == "pending")
        done = sum(1 for _id in _ids if status_by_id.get(_id) in {"complete", "failed"})
        failed = sum(1 for _id in _ids if status_by_id.get(_id) == "failed")
        # Progress must include status transitions, not only completed count.
        # In large queues, jobs can remain pending for minutes before workers pick
        # them up; that should not be treated as a hard stall.
        status_signature = "|".join(f"{_id}:{status_by_id.get(_id,'')}" for _id in _ids)
        if (
            done != _last_done
            or failed != _last_failed
            or running != _last_running
            or pending != _last_pending
            or status_signature != _last_status_signature
        ):
            _last_progress_at = time.monotonic()
        if progress_cb and (
            done != _last_done
            or failed != _last_failed
            or (time.monotonic() - _last_emit) >= 6.0
        ):
            try:
                progress_cb(done, len(_ids), failed)
            except Exception:
                pass
            _last_done = done
            _last_failed = failed
            _last_running = running
            _last_pending = pending
            _last_status_signature = status_signature
            _last_emit = time.monotonic()
        else:
            _last_done = done
            _last_failed = failed
            _last_running = running
            _last_pending = pending
            _last_status_signature = status_signature
        if done >= len(_ids):
            return {
                "ok": failed == 0,
                "failed": failed,
                "done": done,
                "total": len(_ids),
                "timed_out": False,
                "stalled": False,
                "failed_job_ids": failed_job_ids,
                "failed_job_errors": failed_job_errors,
            }
        # Mark stalled when there is no observable status change for too long.
        # This now includes pending-only jobs as well, so a blocked/backlogged
        # transcription queue cannot pin a run in "preparing" for hours.
        no_progress_for = time.monotonic() - _last_progress_at
        pending_only = pending > 0 and running == 0 and done < len(_ids)
        if (running > 0 or pending_only) and no_progress_for >= stall_deadline:
            return {
                "ok": False,
                "failed": failed,
                "done": done,
                "total": len(_ids),
                "timed_out": False,
                "stalled": True,
                "stall_reason": "pending_no_progress" if pending_only else "running_no_progress",
                "failed_job_ids": failed_job_ids,
                "failed_job_errors": failed_job_errors,
            }
        if time.monotonic() >= deadline:
            return {
                "ok": False,
                "failed": failed,
                "done": done,
                "total": len(_ids),
                "timed_out": True,
                "stalled": False,
                "failed_job_ids": failed_job_ids,
                "failed_job_errors": failed_job_errors,
            }
        await asyncio.sleep(2.0)


async def _backfill_pair_transcripts(
    pair: dict[str, str],
    cfg: dict[str, Any],
    progress_cb: Optional[Callable[[int, int, int], None]] = None,
) -> dict[str, Any]:
    from ui.backend.routers.transcription_process import BatchPairsRequest, PairSpec, batch_transcribe_pairs
    from ui.backend.services.crm_service import refresh_calls

    refresh_result: dict[str, Any] = {}
    # Best-effort sync from CRM before backfill so missing historical calls are discovered.
    try:
        refresh_result = await asyncio.wait_for(
            asyncio.to_thread(
                refresh_calls,
                str(pair.get("account_id") or ""),
                str(pair.get("crm_url") or ""),
                str(pair.get("agent") or ""),
                str(pair.get("customer") or ""),
            ),
            timeout=120,
        )
    except Exception as exc:
        refresh_result = {"count": 0, "error": f"refresh_calls failed: {exc}"}

    req = BatchPairsRequest(
        pairs=[
            PairSpec(
                crm_url=str(pair.get("crm_url") or ""),
                account_id=str(pair.get("account_id") or ""),
                agent=str(pair.get("agent") or ""),
                customer=str(pair.get("customer") or ""),
                call_ids=[],
            )
        ],
        smooth_model=str(cfg.get("transcription_model") or "gpt-5.4"),
    )
    batch_res = await batch_transcribe_pairs(req)
    submitted = int(batch_res.get("submitted") or 0)
    skipped = int(batch_res.get("skipped") or 0)
    job_ids = [str(x) for x in (batch_res.get("job_ids") or []) if str(x)]
    wait_meta: dict[str, Any] = {
        "ok": True,
        "failed": 0,
        "done": 0,
        "total": len(job_ids),
        "timed_out": False,
        "stalled": False,
    }
    if job_ids:
        wait_meta = await _wait_for_jobs(
            job_ids,
            timeout_s=int(cfg.get("backfill_timeout_s") or 5400),
            no_progress_timeout_s=int(cfg.get("backfill_no_progress_timeout_s") or 300),
            progress_cb=progress_cb,
        )
    # Fallback: if aggregate says failures occurred but detailed failed ids/errors
    # are missing, re-scan the known job ids so callers can surface actionable logs.
    try:
        _failed_count = int(wait_meta.get("failed") or 0)
    except Exception:
        _failed_count = 0
    _failed_ids = [str(x) for x in (wait_meta.get("failed_job_ids") or []) if str(x).strip()]
    _failed_errs = [str(x) for x in (wait_meta.get("failed_job_errors") or []) if str(x).strip()]
    if _failed_count > 0 and (not _failed_ids or not _failed_errs) and job_ids:
        try:
            with Session(_db_engine) as _s:
                _rows = _s.exec(select(Job).where(Job.id.in_(job_ids))).all()
            _rescanned_failed_ids: list[str] = []
            _rescanned_failed_errs: list[str] = []
            for _r in _rows:
                _st = str(getattr(getattr(_r, "status", None), "value", getattr(_r, "status", "")) or "").strip().lower()
                if _st != "failed":
                    continue
                _rid = str(getattr(_r, "id", "") or "").strip()
                if _rid:
                    _rescanned_failed_ids.append(_rid)
                _err = str(getattr(_r, "error", "") or getattr(_r, "message", "") or "").strip()
                if _err and _rid:
                    _rescanned_failed_errs.append(f"{_rid[:8]}: {_err[:220]}")
            if _rescanned_failed_ids:
                _failed_ids = _rescanned_failed_ids
            if _rescanned_failed_errs:
                _failed_errs = _rescanned_failed_errs
        except Exception:
            pass
    return {
        "submitted": submitted,
        "skipped": skipped,
        "job_ids": job_ids,
        "ok": bool(wait_meta.get("ok")),
        "failed": int(wait_meta.get("failed") or 0),
        "done": int(wait_meta.get("done") or 0),
        "total": int(wait_meta.get("total") or len(job_ids)),
        "timed_out": bool(wait_meta.get("timed_out")),
        "stalled": bool(wait_meta.get("stalled")),
        "failed_job_ids": _failed_ids,
        "failed_job_errors": _failed_errs,
        "refresh_count": int(refresh_result.get("count") or 0) if isinstance(refresh_result, dict) else 0,
        "refresh_error": str((refresh_result or {}).get("error") or "") if isinstance(refresh_result, dict) else "",
    }


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

    # Also mirror to webhook_test/ if a test session is active and not expired
    try:
        if _WEBHOOK_TEST_SESSION_FILE.exists():
            session = json.loads(_WEBHOOK_TEST_SESSION_FILE.read_text(encoding="utf-8"))
            expires_at = datetime.fromisoformat(session["expires_at"])
            if datetime.now(timezone.utc) <= expires_at:
                _WEBHOOK_TEST_DIR.mkdir(parents=True, exist_ok=True)
                test_fname = f"capture_{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S')}_{event_id[:12]}.json"
                (_WEBHOOK_TEST_DIR / test_fname).write_text(
                    json.dumps(event, indent=2, ensure_ascii=False), encoding="utf-8"
                )
    except Exception:
        pass

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
    if bool(settings.live_mirror_enabled):
        raise HTTPException(status_code=403, detail="CRM webhook ingest is disabled in live mirror mode.")
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
    if bool(settings.live_mirror_enabled):
        raise HTTPException(status_code=403, detail="Webhook admin endpoints are disabled in live mirror mode.")
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


def _load_agent_continuity_policy(fallback_cfg: Optional[dict[str, Any]] = None) -> dict[str, bool]:
    """Source of truth is live-webhook config; fallback to call-ended config."""
    policy = {"enabled": True}
    try:
        from ui.backend.routers.pipelines import _load_live_webhook_config as _load_live_cfg

        live_cfg = _load_live_cfg()
        if isinstance(live_cfg, dict):
            policy["enabled"] = bool(live_cfg.get("agent_continuity_filter_enabled", True))
            return policy
    except Exception:
        pass

    if isinstance(fallback_cfg, dict):
        policy["enabled"] = bool(fallback_cfg.get("agent_continuity_filter_enabled", True))
    return policy


def _load_agent_continuity_filter_enabled(fallback_cfg: Optional[dict[str, Any]] = None) -> bool:
    return bool(_load_agent_continuity_policy(fallback_cfg).get("enabled", True))


def _call_order_key(row: CRMCall) -> tuple[Any, ...]:
    started = _parse_iso(getattr(row, "started_at", None))
    if started is not None:
        return (0, started.timestamp(), str(getattr(row, "call_id", "") or ""))
    call_id = str(getattr(row, "call_id", "") or "").strip()
    if call_id.isdigit():
        return (1, int(call_id), call_id)
    return (2, call_id)


def _norm_agent_name(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip()).lower()


def _agent_alias_primary(name: str, alias_map: dict[str, str]) -> str:
    raw = str(name or "").strip()
    if not raw:
        return ""
    direct = str(alias_map.get(raw) or "").strip()
    if direct:
        return direct
    low = raw.lower()
    for k, v in alias_map.items():
        if str(k or "").strip().lower() == low:
            vv = str(v or "").strip()
            return vv or raw
    return raw


def _agent_continuity_check(
    db: Session,
    pair: dict[str, str],
    payload_agent: str = "",
    policy: Optional[dict[str, Any]] = None,
) -> tuple[bool, str, dict[str, Any]]:
    """Unique-pair-only admission rule for webhook jobs."""
    account_id = str(pair.get("account_id") or "").strip()
    crm_url = str(pair.get("crm_url") or "").strip()
    customer = str(pair.get("customer") or "").strip()
    current_agent = str(pair.get("agent") or payload_agent or "").strip()
    payload_agent_name = str(payload_agent or "").strip()
    base_meta: dict[str, Any] = {
        "account_id": account_id,
        "crm_url": crm_url,
        "customer": customer,
        "current_agent": current_agent,
        "payload_agent": payload_agent_name,
    }
    if not account_id:
        return False, "missing_account_id", base_meta

    history_source = "crm_call"
    stmt = select(CRMCall).where(_sql_func.trim(CRMCall.account_id) == account_id)
    if crm_url:
        stmt = stmt.where(_sql_func.trim(CRMCall.crm_url) == crm_url)
    rows = db.exec(stmt).all()
    if not rows:
        history_source = "crm_pair"
        pair_stmt = select(CRMPair).where(_sql_func.trim(CRMPair.account_id) == account_id)
        if customer:
            pair_stmt = pair_stmt.where(_sql_func.lower(_sql_func.trim(CRMPair.customer)) == customer.lower())
        if crm_url:
            pair_stmt = pair_stmt.where(_sql_func.trim(CRMPair.crm_url) == crm_url)
        rows = db.exec(pair_stmt).all()
        if not rows:
            pair_stmt = select(CRMPair).where(_sql_func.trim(CRMPair.account_id) == account_id)
            rows = db.exec(pair_stmt).all()

    raw_agents = sorted(
        {
            str(getattr(r, "agent", "") or "").strip()
            for r in rows
            if str(getattr(r, "agent", "") or "").strip()
        }
    )
    names_for_alias = sorted(
        {
            *raw_agents,
            *( [current_agent] if current_agent else [] ),
            *( [payload_agent_name] if payload_agent_name else [] ),
        }
    )

    alias_map: dict[str, str] = {}
    if names_for_alias:
        try:
            from ui.backend.services.crm_service import _auto_detect_re_aliases, _load_aliases

            alias_map = {**_auto_detect_re_aliases(names_for_alias), **_load_aliases()}
        except Exception:
            alias_map = {}

    canonical_set = sorted(
        {
            _norm_agent_name(_agent_alias_primary(name, alias_map))
            for name in raw_agents
            if _norm_agent_name(_agent_alias_primary(name, alias_map))
        }
    )
    current_canonical = _norm_agent_name(_agent_alias_primary(current_agent, alias_map))
    payload_canonical = _norm_agent_name(_agent_alias_primary(payload_agent_name, alias_map))

    meta = {
        **base_meta,
        "history_source": history_source,
        "history_rows": len(rows),
        "agents": raw_agents,
        "agents_canonical": canonical_set,
        "current_agent_canonical": current_canonical,
        "payload_agent_canonical": payload_canonical,
    }
    if not canonical_set:
        return False, "no_agent_history", meta
    if len(canonical_set) > 1:
        return False, "multi_agent_pair", meta

    unique_agent = canonical_set[0]
    if payload_canonical and payload_canonical != unique_agent:
        return False, "payload_agent_mismatch", meta
    if current_canonical and current_canonical != unique_agent:
        return False, "resolved_agent_mismatch", meta
    return True, "unique_pair", meta


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
    # Keep webhook dispatcher responsive: do not allow indefinite stream waits.
    async with httpx.AsyncClient(
        follow_redirects=True,
        timeout=httpx.Timeout(connect=10.0, read=20.0, write=10.0, pool=10.0),
    ) as client:
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


def _queue_item_sort_key(item: dict[str, Any]) -> tuple[float, float]:
    created = _parse_iso(item.get("created_at"))
    next_attempt = _parse_iso(item.get("next_attempt_at"))
    created_ts = created.timestamp() if created else 0.0
    next_ts = next_attempt.timestamp() if next_attempt else created_ts
    return (next_ts, created_ts)


async def _enqueue_live_item(item: dict[str, Any]) -> tuple[bool, dict[str, Any]]:
    """
    Enqueue a live item with duplicate suppression.
    Returns: (created, meta)
      - created=True: new queue item added
      - created=False: duplicate suppressed, meta contains existing run_id/state/message
    """
    # Single-writer guard: webhook requests can arrive concurrently.
    # Without this lock, read-modify-write races can drop queue entries.
    async with _LIVE_QUEUE_LOCK:
        queue = _load_live_queue()
        run_id = str(item.get("run_id") or "").strip()
        pipeline_id = str(item.get("pipeline_id") or "").strip()
        sales_agent = str(item.get("sales_agent") or "").strip()
        customer = str(item.get("customer") or "").strip()
        call_id = str(item.get("call_id") or "").strip()

        if run_id:
            for row in queue:
                if not isinstance(row, dict):
                    continue
                if str(row.get("run_id") or "").strip() == run_id:
                    return False, {
                        "run_id": run_id,
                        "state": str(row.get("state") or "queued"),
                        "message": "Run already exists in live queue.",
                    }

        active_states = {"queued", "preparing", "running", "retrying"}
        if pipeline_id and sales_agent and customer and call_id:
            for row in queue:
                if not isinstance(row, dict):
                    continue
                st = str(row.get("state") or "").strip().lower()
                if st not in active_states:
                    continue
                if (
                    str(row.get("pipeline_id") or "").strip() == pipeline_id
                    and str(row.get("sales_agent") or "").strip() == sales_agent
                    and str(row.get("customer") or "").strip() == customer
                    and str(row.get("call_id") or "").strip() == call_id
                ):
                    return False, {
                        "run_id": str(row.get("run_id") or ""),
                        "state": str(row.get("state") or "queued"),
                        "message": "Duplicate webhook suppressed (already queued/running).",
                    }

            # Fallback duplicate guard against orphaned/active DB rows.
            try:
                with Session(_db_engine) as s:
                    rows = s.exec(
                        select(PipelineRun).where(
                            PipelineRun.pipeline_id == pipeline_id,
                            PipelineRun.sales_agent == sales_agent,
                            PipelineRun.customer == customer,
                            PipelineRun.call_id == call_id,
                            PipelineRun.status.in_(["queued", "preparing", "running", "retrying"]),
                        )
                    ).all()
                for db_row in rows or []:
                    if not _steps_json_is_webhook_origin(getattr(db_row, "steps_json", "")):
                        continue
                    base_status = normalize_state_token(getattr(db_row, "status", ""))
                    effective_status = derive_effective_run_status(
                        base_status=base_status,
                        steps_json=getattr(db_row, "steps_json", ""),
                        finished_at=getattr(db_row, "finished_at", None),
                    )
                    if is_active_run_like(base_status) and is_terminal_run_like(effective_status) and (effective_status != base_status):
                        _reconcile_pipeline_run_status(str(getattr(db_row, "id", "") or ""))
                    if is_active_run_like(effective_status):
                        return False, {
                            "run_id": str(getattr(db_row, "id", "") or ""),
                            "state": effective_status or str(getattr(db_row, "status", "") or "queued"),
                            "message": "Duplicate webhook suppressed (active run already exists).",
                        }
            except Exception:
                pass

        queue.append(item)
        queue.sort(key=_queue_item_sort_key)
        _save_live_queue(queue)
        return True, {
            "run_id": run_id,
            "state": str(item.get("state") or "queued"),
            "message": "Queued for live dispatcher.",
        }


def _steps_json_is_webhook_origin(raw_steps_json: Any) -> bool:
    try:
        parsed = json.loads(str(raw_steps_json or "[]"))
    except Exception:
        return False
    if not isinstance(parsed, list):
        return False
    for step in parsed:
        if not isinstance(step, dict):
            continue
        origin = str(step.get("run_origin") or "").strip().lower()
        if origin in {"webhook", "production"}:
            return True
    return False


def _iso_from_dt(dt: Any, fallback_iso: str) -> str:
    if not isinstance(dt, datetime):
        return fallback_iso
    value = dt
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat()


def _pair_from_names(agent: str, customer: str) -> dict[str, str]:
    try:
        with Session(_db_engine) as s:
            row = s.exec(
                select(CRMPair)
                .where(CRMPair.agent == str(agent or ""))
                .where(CRMPair.customer == str(customer or ""))
                .limit(1)
            ).first()
            if row:
                return {
                    "crm_url": str(getattr(row, "crm_url", "") or ""),
                    "account_id": str(getattr(row, "account_id", "") or ""),
                    "agent": str(getattr(row, "agent", "") or agent or ""),
                    "customer": str(getattr(row, "customer", "") or customer or ""),
                }
    except Exception:
        pass
    return {
        "crm_url": "",
        "account_id": "",
        "agent": str(agent or ""),
        "customer": str(customer or ""),
    }


def _build_webhook_run_payload_from_row(row: PipelineRun, cfg: dict[str, Any]) -> dict[str, Any]:
    run_payload: dict[str, Any] = {
        "sales_agent": str(getattr(row, "sales_agent", "") or ""),
        "customer": str(getattr(row, "customer", "") or ""),
        "call_id": str(getattr(row, "call_id", "") or ""),
        "resume_partial": True,
        "run_origin": "webhook",
        "run_id": str(getattr(row, "id", "") or ""),
    }
    cfg_run_payload = cfg.get("run_payload")
    if isinstance(cfg_run_payload, dict):
        for k, v in cfg_run_payload.items():
            run_payload[str(k)] = v
    return run_payload


def _recover_orphaned_live_queue_items(
    *,
    queue: list[dict[str, Any]],
    cfg: dict[str, Any],
    request_base_url: str,
) -> int:
    """
    Recover webhook runs that were persisted as queued/preparing/retrying/running
    in pipeline_run but are missing from live_queue.json (e.g. concurrent write race).
    """
    existing_run_ids: set[str] = {
        str(item.get("run_id") or "").strip()
        for item in queue
        if isinstance(item, dict)
    }
    active_states = {"queued", "preparing", "running", "retrying"}
    existing_active_keys: set[tuple[str, str, str, str]] = set()
    for item in queue:
        if not isinstance(item, dict):
            continue
        st = str(item.get("state") or "").strip().lower()
        if st not in active_states:
            continue
        k = (
            str(item.get("pipeline_id") or "").strip(),
            str(item.get("sales_agent") or "").strip(),
            str(item.get("customer") or "").strip(),
            str(item.get("call_id") or "").strip(),
        )
        if all(k):
            existing_active_keys.add(k)
    now_iso = _utc_now_iso()
    recovered = 0

    try:
        with Session(_db_engine) as s:
            rows = s.exec(
                select(PipelineRun).where(
                    PipelineRun.status.in_(["queued", "preparing", "running", "retrying"])
                )
            ).all()
    except Exception:
        rows = []

    seen_active_keys = set(existing_active_keys)

    for row in rows or []:
        run_id = str(getattr(row, "id", "") or "").strip()
        if not run_id or run_id in existing_run_ids:
            continue
        if not _steps_json_is_webhook_origin(getattr(row, "steps_json", "")):
            continue

        row_status = normalize_state_token(getattr(row, "status", "") or "")
        effective_row_status = derive_effective_run_status(
            base_status=row_status,
            steps_json=getattr(row, "steps_json", ""),
            finished_at=getattr(row, "finished_at", None),
        )
        if is_active_run_like(row_status) and is_terminal_run_like(effective_row_status) and (effective_row_status != row_status):
            row_status = _reconcile_pipeline_run_status(run_id) or effective_row_status
        else:
            row_status = effective_row_status or row_status
        if row_status not in {"queued", "preparing", "running", "retrying"}:
            continue

        row_key = (
            str(getattr(row, "pipeline_id", "") or "").strip(),
            str(getattr(row, "sales_agent", "") or "").strip(),
            str(getattr(row, "customer", "") or "").strip(),
            str(getattr(row, "call_id", "") or "").strip(),
        )
        if all(row_key) and row_key in seen_active_keys:
            # Suppress duplicate active rows for the same logical run key so they
            # do not keep reappearing in queue recovery cycles.
            try:
                with Session(_db_engine) as s:
                    db_row = s.get(PipelineRun, run_id)
                    if db_row and str(getattr(db_row, "status", "") or "").lower() in active_states:
                        db_row.status = "cancelled"
                        logs = []
                        try:
                            raw_logs = json.loads(str(getattr(db_row, "log_json", "") or "[]"))
                            if isinstance(raw_logs, list):
                                logs = raw_logs
                        except Exception:
                            logs = []
                        logs.append(
                            {
                                "ts": _utc_now_iso(),
                                "text": "Suppressed duplicate active webhook run during queue recovery.",
                                "level": "pipeline",
                            }
                        )
                        db_row.log_json = json.dumps(logs[-400:], ensure_ascii=False)
                        s.add(db_row)
                        s.commit()
            except Exception:
                pass
            continue

        queue_state = "queued" if row_status == "preparing" else row_status
        pair = _pair_from_names(
            str(getattr(row, "sales_agent", "") or ""),
            str(getattr(row, "customer", "") or ""),
        )
        payload = _build_webhook_run_payload_from_row(row, cfg)
        created_iso = _iso_from_dt(getattr(row, "started_at", None), now_iso)
        updated_iso = created_iso
        max_attempts = int(cfg.get("retry_max_attempts") or 2)

        queue.append(
            {
                "id": str(uuid.uuid4()),
                "webhook_type": "recovered",
                "created_at": created_iso,
                "updated_at": updated_iso,
                "state": queue_state,
                "attempts": 0,
                "max_attempts": max_attempts,
                "next_attempt_at": now_iso,
                "last_error": "",
                "request_base_url": str(request_base_url or ""),
                "pipeline_id": str(getattr(row, "pipeline_id", "") or ""),
                "pipeline_name": str(getattr(row, "pipeline_name", "") or ""),
                "run_id": run_id,
                "sales_agent": str(getattr(row, "sales_agent", "") or ""),
                "customer": str(getattr(row, "customer", "") or ""),
                "call_id": str(getattr(row, "call_id", "") or ""),
                "pair": pair,
                "payload": payload,
            }
        )
        if all(row_key):
            seen_active_keys.add(row_key)
        existing_run_ids.add(run_id)
        recovered += 1
        if queue_state in {"queued", "retrying"}:
            _upsert_pipeline_run_stub(
                run_id=run_id,
                pipeline_id=str(getattr(row, "pipeline_id", "") or ""),
                pipeline_name=str(getattr(row, "pipeline_name", "") or ""),
                sales_agent=str(getattr(row, "sales_agent", "") or ""),
                customer=str(getattr(row, "customer", "") or ""),
                call_id=str(getattr(row, "call_id", "") or ""),
                status=queue_state,
                log_line="Recovered missing live-queue entry.",
            )

    if recovered:
        queue.sort(key=_queue_item_sort_key)
    return recovered


async def _execute_live_queue_item(
    item_snapshot: dict[str, Any],
    cfg: dict[str, Any],
    request_base_url: str = "",
) -> dict[str, Any]:
    item = dict(item_snapshot or {})
    run_id = str(item.get("run_id") or "").strip()
    pipeline_id = str(item.get("pipeline_id") or "").strip()
    payload = item.get("payload") if isinstance(item.get("payload"), dict) else {}
    pair = item.get("pair") if isinstance(item.get("pair"), dict) else {}
    attempt_num = int(item.get("attempts") or 0) + 1
    item["attempts"] = attempt_num

    if not run_id or not pipeline_id or not payload:
        item["state"] = "failed"
        item["last_error"] = "Invalid queued item payload."
        item["updated_at"] = _utc_now_iso()
        return item

    try:
        if bool(cfg.get("backfill_historical_transcripts", True)) and pair:
            def _on_backfill_progress(done: int, total: int, failed_jobs: int) -> None:
                try:
                    loop = asyncio.get_running_loop()
                    loop.create_task(_touch_live_queue_item(run_id=run_id, state="preparing"))
                except Exception:
                    pass
                _upsert_pipeline_run_stub(
                    run_id=run_id,
                    pipeline_id=pipeline_id,
                    pipeline_name=str(item.get("pipeline_name") or ""),
                    sales_agent=str(item.get("sales_agent") or ""),
                    customer=str(item.get("customer") or ""),
                    call_id=str(item.get("call_id") or ""),
                    status="preparing",
                    log_line=f"Backfill running ({done}/{total} complete, {failed_jobs} failed)",
                )

            _upsert_pipeline_run_stub(
                run_id=run_id,
                pipeline_id=pipeline_id,
                pipeline_name=str(item.get("pipeline_name") or ""),
                sales_agent=str(item.get("sales_agent") or ""),
                customer=str(item.get("customer") or ""),
                call_id=str(item.get("call_id") or ""),
                status="preparing",
                log_line="Backfilling historical transcripts (skipping existing)",
            )
            # Guard backfill so a stuck CRM/transcription dependency cannot pin live slots forever.
            backfill = await asyncio.wait_for(
                _backfill_pair_transcripts(pair, cfg, progress_cb=_on_backfill_progress),
                timeout=max(120, int(cfg.get("backfill_timeout_s") or 5400) + 60),
            )
            if not bool(backfill.get("ok")):
                stall_reason = str(backfill.get("stall_reason") or "").strip().lower()
                reason = (
                    (
                        "pending with no progress"
                        if stall_reason == "pending_no_progress"
                        else "running with no progress"
                    )
                    if bool(backfill.get("stalled"))
                    else ("timed out" if bool(backfill.get("timed_out")) else "failed")
                )
                failed_ids = [str(x) for x in (backfill.get("failed_job_ids") or []) if str(x).strip()]
                failed_errs = [str(x) for x in (backfill.get("failed_job_errors") or []) if str(x).strip()]
                if failed_ids:
                    failed_ids_short = ", ".join(x[:8] for x in failed_ids[:12])
                    if len(failed_ids) > 12:
                        failed_ids_short += ", …"
                    _upsert_pipeline_run_stub(
                        run_id=run_id,
                        pipeline_id=pipeline_id,
                        pipeline_name=str(item.get("pipeline_name") or ""),
                        sales_agent=str(item.get("sales_agent") or ""),
                        customer=str(item.get("customer") or ""),
                        call_id=str(item.get("call_id") or ""),
                        status="preparing",
                        log_line=f"Backfill failed job ids: {failed_ids_short}",
                    )
                if failed_errs:
                    _upsert_pipeline_run_stub(
                        run_id=run_id,
                        pipeline_id=pipeline_id,
                        pipeline_name=str(item.get("pipeline_name") or ""),
                        sales_agent=str(item.get("sales_agent") or ""),
                        customer=str(item.get("customer") or ""),
                        call_id=str(item.get("call_id") or ""),
                        status="preparing",
                        log_line=f"Backfill first error: {failed_errs[0][:300]}",
                    )
                detail_parts: list[str] = []
                if failed_ids:
                    failed_ids_short = ", ".join(x[:8] for x in failed_ids[:8])
                    if len(failed_ids) > 8:
                        failed_ids_short += ", …"
                    detail_parts.append(f"failed job ids: {failed_ids_short}")
                if failed_errs:
                    detail_parts.append(f"first error: {failed_errs[0]}")
                if not detail_parts and int(backfill.get("failed") or 0) > 0:
                    detail_parts.append("failed job details unavailable (inspect Jobs list for this pair)")
                detail_suffix = f" [{'; '.join(detail_parts)}]" if detail_parts else ""
                raise RuntimeError(
                    "Backfill "
                    f"{reason} ({int(backfill.get('done') or 0)}/{int(backfill.get('total') or 0)} complete, "
                    f"{int(backfill.get('failed') or 0)} failed jobs)."
                    f"{detail_suffix}"
                )
            _upsert_pipeline_run_stub(
                run_id=run_id,
                pipeline_id=pipeline_id,
                pipeline_name=str(item.get("pipeline_name") or ""),
                sales_agent=str(item.get("sales_agent") or ""),
                customer=str(item.get("customer") or ""),
                call_id=str(item.get("call_id") or ""),
                status="preparing",
                log_line=(
                    f"Backfill done: submitted {int(backfill.get('submitted') or 0)}, "
                    f"skipped {int(backfill.get('skipped') or 0)}, "
                    f"refresh added {int(backfill.get('refresh_count') or 0)} call(s)."
                ),
            )
            if str(backfill.get("refresh_error") or "").strip():
                _upsert_pipeline_run_stub(
                    run_id=run_id,
                    pipeline_id=pipeline_id,
                    pipeline_name=str(item.get("pipeline_name") or ""),
                    sales_agent=str(item.get("sales_agent") or ""),
                    customer=str(item.get("customer") or ""),
                    call_id=str(item.get("call_id") or ""),
                    status="preparing",
                    log_line=f"Backfill refresh warning: {str(backfill.get('refresh_error'))[:240]}",
                )

        req_base = str(item.get("request_base_url") or request_base_url or "").strip()
        fake_req = type("WebhookReq", (), {"base_url": req_base or "http://127.0.0.1:8000"})()
        payload_for_run = dict(payload)
        payload_for_run["run_id"] = run_id
        payload_for_run["run_origin"] = "webhook"
        result = await _trigger_pipeline_run(
            request=fake_req,  # type: ignore[arg-type]
            pipeline_id=pipeline_id,
            payload=payload_for_run,
        )
        actual_run_id = str(result.get("run_id") or run_id)
        item["run_id"] = actual_run_id
        item["state"] = "running"
        item["updated_at"] = _utc_now_iso()
        item["last_error"] = ""
        _upsert_pipeline_run_stub(
            run_id=actual_run_id,
            pipeline_id=pipeline_id,
            pipeline_name=str(item.get("pipeline_name") or ""),
            sales_agent=str(item.get("sales_agent") or ""),
            customer=str(item.get("customer") or ""),
            call_id=str(item.get("call_id") or ""),
            status="running",
            log_line="Pipeline execution started from live queue.",
        )
        return item
    except Exception as exc:
        err_text = str(getattr(exc, "detail", "") or str(exc) or "Dispatch failed")
        max_attempts = int(item.get("max_attempts") or int(cfg.get("retry_max_attempts") or 2))
        can_retry = (
            bool(cfg.get("auto_retry_enabled", True))
            and attempt_num < max_attempts
            and _is_retryable_text(err_text, cfg)
        )
        if can_retry:
            item["state"] = "retrying"
            item["last_error"] = err_text
            item["next_attempt_at"] = (
                datetime.now(timezone.utc)
                + timedelta(seconds=int(cfg.get("retry_delay_s") or 45))
            ).isoformat()
            item["updated_at"] = _utc_now_iso()
            _upsert_pipeline_run_stub(
                run_id=run_id,
                pipeline_id=pipeline_id,
                pipeline_name=str(item.get("pipeline_name") or ""),
                sales_agent=str(item.get("sales_agent") or ""),
                customer=str(item.get("customer") or ""),
                call_id=str(item.get("call_id") or ""),
                status="retrying",
                log_line=f"Dispatch retry scheduled: {err_text[:420]}",
            )
        else:
            item["state"] = "failed"
            item["last_error"] = err_text
            item["updated_at"] = _utc_now_iso()
            _upsert_pipeline_run_stub(
                run_id=run_id,
                pipeline_id=pipeline_id,
                pipeline_name=str(item.get("pipeline_name") or ""),
                sales_agent=str(item.get("sales_agent") or ""),
                customer=str(item.get("customer") or ""),
                call_id=str(item.get("call_id") or ""),
                status="failed",
                log_line=f"Dispatch failed: {err_text[:420]}",
            )
            # Persist in shared rejection store so all VMs (dev + prod) see it.
            _reason = _infer_rejection_reason(err_text) or "dispatch_failed"
            try:
                _append_rejected_webhook({
                    "id": str(item.get("id") or run_id or ""),
                    "source": "dispatch",
                    "reason": _reason,
                    "status": "rejected",
                    "message": err_text[:500],
                    "webhook_type": str(item.get("webhook_type") or "call-updated"),
                    "event_id": str(item.get("event_id") or ""),
                    "event_file": str(item.get("event_file") or ""),
                    "sales_agent": str(item.get("sales_agent") or ""),
                    "customer": str(item.get("customer") or ""),
                    "call_id": str(item.get("call_id") or ""),
                    "account_id": str((item.get("pair") or {}).get("account_id") or ""),
                    "crm_url": str((item.get("pair") or {}).get("crm_url") or ""),
                    "pipeline_ids": [pipeline_id] if pipeline_id else [],
                    "created_at": str(item.get("created_at") or ""),
                    "updated_at": str(item.get("updated_at") or ""),
                })
            except Exception:
                pass
        return item


def _prune_live_queue_items(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    pruned: list[dict[str, Any]] = []
    now_ts = datetime.now(timezone.utc).timestamp()
    for item in items:
        st = str(item.get("state") or "").lower()
        if st in {"done"}:
            updated = _parse_iso(item.get("updated_at"))
            if updated and (now_ts - updated.timestamp()) > 1800:
                continue
        pruned.append(item)
    return pruned


async def _dispatch_live_queue_once(request_base_url: str = "") -> None:
    cfg = _load_call_ended_config()
    if not bool(cfg.get("enabled", True)):
        return
    if bool(cfg.get("ingest_only", True)):
        return
    if not bool(cfg.get("trigger_pipeline", True)):
        return

    max_running = int(cfg.get("max_live_running") or 5)
    now = datetime.now(timezone.utc)
    preparing_stale_after_s = max(
        180,
        int(cfg.get("backfill_no_progress_timeout_s") or 300) + 30,
    )
    running_stale_after_s = max(180, int(cfg.get("running_stale_after_s") or 600))
    candidates: list[dict[str, Any]] = []

    async with _LIVE_QUEUE_LOCK:
        queue = _load_live_queue()
        recovered = _recover_orphaned_live_queue_items(
            queue=queue,
            cfg=cfg,
            request_base_url=str(request_base_url or ""),
        )
        changed = bool(recovered)
        if not queue:
            return

        # Re-validate queued webhook items against current continuity policy.
        # This ensures old queued items are filtered immediately after policy changes.
        continuity_policy = _load_agent_continuity_policy(cfg)
        if bool(continuity_policy.get("enabled", True)):
            try:
                with Session(_db_engine) as _s:
                    for item in queue:
                        if not isinstance(item, dict):
                            continue
                        state = str(item.get("state") or "").strip().lower()
                        if state not in {"queued", "retrying", "preparing"}:
                            continue
                        webhook_type = str(item.get("webhook_type") or "").strip().lower()
                        if webhook_type not in {"call-ended", "call-updated"}:
                            continue

                        pair_raw = item.get("pair")
                        pair = pair_raw if isinstance(pair_raw, dict) else {}
                        pair_obj = {
                            "account_id": str(pair.get("account_id") or item.get("account_id") or "").strip(),
                            "crm_url": str(pair.get("crm_url") or item.get("crm_url") or "").strip(),
                            "agent": str(pair.get("agent") or item.get("sales_agent") or "").strip(),
                            "customer": str(pair.get("customer") or item.get("customer") or "").strip(),
                        }
                        payload_raw = item.get("payload")
                        payload_obj = payload_raw if isinstance(payload_raw, dict) else {}
                        payload_agent = str(payload_obj.get("agent") or pair_obj.get("agent") or "").strip()
                        ok, reason, meta = _agent_continuity_check(
                            db=_s,
                            pair=pair_obj,
                            payload_agent=payload_agent,
                            policy=continuity_policy,
                        )
                        if ok:
                            continue

                        item["state"] = "failed"
                        item["last_error"] = f"Rejected by unique-pair filter ({reason})."
                        item["updated_at"] = _utc_now_iso()
                        changed = True

                        if not bool(item.get("continuity_rejected_logged")):
                            _append_rejected_webhook(
                                {
                                    "source": "queue_revalidation",
                                    "reason": reason,
                                    "status": "rejected",
                                    "webhook_type": webhook_type,
                                    "event_id": str(item.get("event_id") or ""),
                                    "event_file": str(item.get("event_file") or ""),
                                    "sales_agent": str(pair_obj.get("agent") or item.get("sales_agent") or ""),
                                    "customer": str(pair_obj.get("customer") or item.get("customer") or ""),
                                    "call_id": str(item.get("call_id") or ""),
                                    "account_id": str(pair_obj.get("account_id") or ""),
                                    "crm_url": str(pair_obj.get("crm_url") or ""),
                                    "pipeline_ids": [str(item.get("pipeline_id") or "")] if str(item.get("pipeline_id") or "").strip() else [],
                                    "run_id": str(item.get("run_id") or ""),
                                    "payload": payload_obj,
                                    "continuity_meta": meta,
                                    "message": "Rejected from live queue by unique-pair policy.",
                                }
                            )
                            item["continuity_rejected_logged"] = True

                        _upsert_pipeline_run_stub(
                            run_id=str(item.get("run_id") or ""),
                            pipeline_id=str(item.get("pipeline_id") or ""),
                            pipeline_name=str(item.get("pipeline_name") or ""),
                            sales_agent=str(pair_obj.get("agent") or item.get("sales_agent") or ""),
                            customer=str(pair_obj.get("customer") or item.get("customer") or ""),
                            call_id=str(item.get("call_id") or ""),
                            status="failed",
                            log_line=f"Rejected by unique-pair filter during queue revalidation ({reason})",
                        )
            except Exception:
                pass

        # Reconcile running/retrying/finalized items.
        for item in queue:
            state = str(item.get("state") or "queued").strip().lower()
            run_id = str(item.get("run_id") or "")
            if not run_id:
                continue
            row = None
            try:
                with Session(_db_engine) as s:
                    row = s.get(PipelineRun, run_id)
            except Exception:
                row = None

            if state in {"running", "preparing", "retrying"}:
                row_status = ""
                if row is not None:
                    base_row_status = normalize_state_token(getattr(row, "status", "") or "")
                    effective_row_status = derive_effective_run_status(
                        base_status=base_row_status,
                        steps_json=getattr(row, "steps_json", ""),
                        finished_at=getattr(row, "finished_at", None),
                    )
                    if (
                        is_active_run_like(base_row_status)
                        and is_terminal_run_like(effective_row_status)
                        and (effective_row_status != base_row_status)
                    ):
                        row_status = _reconcile_pipeline_run_status(run_id) or effective_row_status or base_row_status
                    else:
                        row_status = effective_row_status or base_row_status
                if row_status in {"done", "completed"}:
                    item["state"] = "done"
                    item["updated_at"] = _utc_now_iso()
                    changed = True
                    continue
                if row_status in {"error", "failed", "cancelled"}:
                    err_text = _extract_run_error(row)
                    attempts = int(item.get("attempts") or 0)
                    max_attempts = int(item.get("max_attempts") or int(cfg.get("retry_max_attempts") or 2))
                    can_retry = (
                        bool(cfg.get("auto_retry_enabled", True))
                        and attempts < max_attempts
                        and _is_retryable_text(err_text, cfg)
                    )
                    if can_retry:
                        item["state"] = "retrying"
                        item["next_attempt_at"] = (
                            now + timedelta(seconds=int(cfg.get("retry_delay_s") or 45))
                        ).isoformat()
                        item["last_error"] = err_text
                        item["updated_at"] = _utc_now_iso()
                        _upsert_pipeline_run_stub(
                            run_id=run_id,
                            pipeline_id=str(item.get("pipeline_id") or ""),
                            pipeline_name=str(item.get("pipeline_name") or ""),
                            sales_agent=str(item.get("sales_agent") or ""),
                            customer=str(item.get("customer") or ""),
                            call_id=str(item.get("call_id") or ""),
                            status="retrying",
                            log_line=f"Retry scheduled ({attempts + 1}/{max_attempts})",
                        )
                    else:
                        item["state"] = "failed"
                        item["last_error"] = err_text or str(item.get("last_error") or "Run failed")
                        item["updated_at"] = _utc_now_iso()
                    changed = True
                    continue
                # If a run already moved from preflight to active status, sync queue state.
                if row_status in {"running", "retrying"} and state != row_status:
                    item["state"] = row_status
                    item["updated_at"] = _utc_now_iso()
                    changed = True
                    continue
                # Recovery path: long-stuck "running"/"retrying" queue items are recycled.
                if state in {"running", "retrying"}:
                    updated_dt = _parse_iso(item.get("updated_at"))
                    is_stale = (
                        updated_dt is None
                        or (now - updated_dt).total_seconds() >= running_stale_after_s
                    )
                    if is_stale:
                        err_text = str(item.get("last_error") or "stale running item recovered")
                        attempts = int(item.get("attempts") or 0)
                        max_attempts = int(item.get("max_attempts") or int(cfg.get("retry_max_attempts") or 2))
                        can_retry = bool(cfg.get("auto_retry_enabled", True)) and attempts < max_attempts
                        if can_retry:
                            item["state"] = "retrying"
                            item["next_attempt_at"] = (
                                now + timedelta(seconds=int(cfg.get("retry_delay_s") or 45))
                            ).isoformat()
                            item["last_error"] = err_text
                            item["updated_at"] = _utc_now_iso()
                            _upsert_pipeline_run_stub(
                                run_id=run_id,
                                pipeline_id=str(item.get("pipeline_id") or ""),
                                pipeline_name=str(item.get("pipeline_name") or ""),
                                sales_agent=str(item.get("sales_agent") or ""),
                                customer=str(item.get("customer") or ""),
                                call_id=str(item.get("call_id") or ""),
                                status="retrying",
                                log_line="Recovered stale running item; retry scheduled.",
                            )
                        else:
                            item["state"] = "failed"
                            item["last_error"] = err_text or "stale running item failed"
                            item["updated_at"] = _utc_now_iso()
                            _upsert_pipeline_run_stub(
                                run_id=run_id,
                                pipeline_id=str(item.get("pipeline_id") or ""),
                                pipeline_name=str(item.get("pipeline_name") or ""),
                                sales_agent=str(item.get("sales_agent") or ""),
                                customer=str(item.get("customer") or ""),
                                call_id=str(item.get("call_id") or ""),
                                status="failed",
                                log_line="Recovered stale running item; marked failed.",
                            )
                        changed = True
                        continue
                # Recovery path: a queue item can be left in "preparing" after restart/interruption.
                # Re-queue it so dispatcher can attempt preflight again.
                if state == "preparing":
                    updated_dt = _parse_iso(item.get("updated_at"))
                    is_stale = (
                        updated_dt is None
                        or (now - updated_dt).total_seconds() >= preparing_stale_after_s
                    )
                    if is_stale:
                        item["state"] = "queued"
                        item["updated_at"] = _utc_now_iso()
                        item["last_error"] = str(item.get("last_error") or "")
                        _upsert_pipeline_run_stub(
                            run_id=run_id,
                            pipeline_id=str(item.get("pipeline_id") or ""),
                            pipeline_name=str(item.get("pipeline_name") or ""),
                            sales_agent=str(item.get("sales_agent") or ""),
                            customer=str(item.get("customer") or ""),
                            call_id=str(item.get("call_id") or ""),
                            status="queued",
                            log_line="Recovered stale preflight item; re-queued.",
                        )
                        changed = True

        running_count = _count_running_pipeline_runs(queue)
        slots = max(0, max_running - running_count)

        if slots > 0:
            queue.sort(key=_queue_item_sort_key)
            for item in queue:
                if slots <= 0:
                    break
                state = str(item.get("state") or "queued").strip().lower()
                # Only dequeue items that are actually waiting.
                # "preparing" items are already active and consume a slot.
                # If a preparing item goes stale, it is first converted to queued above.
                if state not in {"queued", "retrying"}:
                    continue
                next_attempt = _parse_iso(item.get("next_attempt_at"))
                if next_attempt and next_attempt > now:
                    continue

                run_id = str(item.get("run_id") or "").strip()
                pipeline_id = str(item.get("pipeline_id") or "").strip()
                payload = item.get("payload") if isinstance(item.get("payload"), dict) else {}
                if not run_id or not pipeline_id or not payload:
                    item["state"] = "failed"
                    item["last_error"] = "Invalid queued item payload."
                    item["updated_at"] = _utc_now_iso()
                    changed = True
                    continue

                item["state"] = "preparing"
                item["updated_at"] = _utc_now_iso()
                _upsert_pipeline_run_stub(
                    run_id=run_id,
                    pipeline_id=pipeline_id,
                    pipeline_name=str(item.get("pipeline_name") or ""),
                    sales_agent=str(item.get("sales_agent") or ""),
                    customer=str(item.get("customer") or ""),
                    call_id=str(item.get("call_id") or ""),
                    status="preparing",
                    log_line="Dequeued for preflight checks",
                )
                candidates.append(dict(item))
                slots -= 1
                changed = True

        pruned = _prune_live_queue_items(queue)
        if changed or len(pruned) != len(queue):
            _save_live_queue(pruned)

    if not candidates:
        return

    results = await asyncio.gather(
        *[_execute_live_queue_item(c, cfg, request_base_url) for c in candidates],
        return_exceptions=True,
    )

    async with _LIVE_QUEUE_LOCK:
        queue = _load_live_queue()
        changed = False
        for res in results:
            if isinstance(res, Exception):
                continue
            if not isinstance(res, dict):
                continue
            item_id = str(res.get("id") or "").strip()
            run_id = str(res.get("run_id") or "").strip()

            idx = -1
            if item_id:
                for i, row in enumerate(queue):
                    if str(row.get("id") or "").strip() == item_id:
                        idx = i
                        break
            if idx < 0 and run_id:
                for i, row in enumerate(queue):
                    if str(row.get("run_id") or "").strip() == run_id:
                        idx = i
                        break

            if idx >= 0:
                queue[idx].update(res)
                changed = True
            else:
                queue.append(dict(res))
                changed = True

        pruned = _prune_live_queue_items(queue)
        if changed or len(pruned) != len(queue):
            _save_live_queue(pruned)


async def _live_dispatcher_loop() -> None:
    while True:
        try:
            await _dispatch_live_queue_once()
        except Exception as e:
            # Keep dispatcher alive even if one cycle fails, but do not swallow
            # the error silently — this is critical for queue debugging.
            try:
                print(f"[live-dispatcher] cycle error: {e}")
            except Exception:
                pass
        await asyncio.sleep(2.0)


def ensure_live_dispatcher_started() -> None:
    global _LIVE_DISPATCHER_TASK
    loop = asyncio.get_event_loop()
    if _LIVE_DISPATCHER_TASK and not _LIVE_DISPATCHER_TASK.done():
        return
    _LIVE_DISPATCHER_TASK = loop.create_task(_live_dispatcher_loop())


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
    if bool(getattr(settings, "live_state_read_only", False)):
        raise HTTPException(status_code=403, detail="Live webhook writes are disabled in read-only mode.")
    cfg = _load_call_ended_config()

    stored = _persist_webhook_event(
        webhook_type=webhook_type,
        compat_mode=compat_mode,
        payload=payload.model_dump(),
        request=request,
    )
    if not cfg.get("enabled", True):
        msg = "Call-ended webhook flow is disabled in config."
        _append_ingress_rejection(
            reason="webhook_disabled",
            message=msg,
            webhook_type=webhook_type,
            payload=payload,
            stored=stored,
            cfg=cfg,
        )
        raise HTTPException(status_code=403, detail=msg)
    if bool(cfg.get("ingest_only", True)):
        return {
            "ok": True,
            "webhook_type": webhook_type,
            "compat_mode": compat_mode or "",
            "ingest_only": True,
            "stored": stored,
            "message": "Webhook payload received and saved. Runtime execution is disabled (ingest_only=true).",
        }

    try:
        pair = _resolve_pair(db, payload)
    except HTTPException as e:
        detail = str(getattr(e, "detail", "") or "Pair resolution failed.")
        status_code = int(getattr(e, "status_code", 500) or 500)
        if status_code == 404:
            reason = "no_pair"
        elif status_code == 400 and "account_id" in detail.lower():
            reason = "missing_account_id"
        else:
            reason = "pair_resolution_failed"
        _append_ingress_rejection(
            reason=reason,
            message=detail,
            webhook_type=webhook_type,
            payload=payload,
            stored=stored,
            cfg=cfg,
        )
        raise
    if payload.customer and str(payload.customer).strip():
        pair["customer"] = str(payload.customer).strip()
    if payload.crm_url and str(payload.crm_url).strip():
        pair["crm_url"] = str(payload.crm_url).strip()

    continuity_policy = _load_agent_continuity_policy(cfg)
    continuity_filter_enabled = bool(continuity_policy.get("enabled", True))
    continuity_ok = True
    continuity_reason = "disabled"
    continuity_meta: dict[str, Any] = {}
    if continuity_filter_enabled:
        continuity_ok, continuity_reason, continuity_meta = _agent_continuity_check(
            db=db,
            pair=pair,
            payload_agent=str(payload.agent or "").strip(),
            policy=continuity_policy,
        )
        if not continuity_ok:
            _append_rejected_webhook(
                {
                    "source": "ingress",
                    "reason": continuity_reason,
                    "status": "rejected",
                    "webhook_type": webhook_type,
                    "event_id": str(stored.get("event_id") or ""),
                    "event_file": str(stored.get("file") or ""),
                    "sales_agent": pair.get("agent") or "",
                    "customer": pair.get("customer") or "",
                    "call_id": str(payload.call_id or "").strip(),
                    "account_id": pair.get("account_id") or "",
                    "crm_url": pair.get("crm_url") or "",
                    "pipeline_ids": _resolve_live_pipeline_ids(cfg),
                    "payload": payload.model_dump(),
                    "continuity_meta": continuity_meta,
                    "message": "Rejected by unique-pair filter.",
                }
            )
            return {
                "ok": True,
                "webhook_type": webhook_type,
                "compat_mode": compat_mode or "",
                "ingest_only": False,
                "stored": stored,
                "received": {
                    "call_id": str(payload.call_id or "").strip(),
                    "account_id": pair.get("account_id") or "",
                    "agent": payload.agent,
                    "record_path": str(payload.record_path or "").strip(),
                    "duration": payload.duration,
                },
                "resolved_pair": pair,
                "continuity_filter": {
                    "enabled": True,
                    "passed": False,
                    "reason": continuity_reason,
                    "meta": continuity_meta,
                    "policy": continuity_policy,
                },
                "transcription": {
                    "used_cached_transcript": _transcript_exists(
                        pair.get("agent") or "",
                        pair.get("customer") or "",
                        str(payload.call_id or "").strip(),
                    ),
                    "job_id": "",
                    "status": "rejected_by_filter",
                    "message": "Rejected by unique-pair filter.",
                },
                "pipeline": {
                    "triggered": False,
                    "pipeline_id": "",
                    "run_id": "",
                    "pipelines": [],
                    "message": "Rejected by unique-pair filter.",
                },
            }
    else:
        continuity_reason = "disabled"

    call_id = str(payload.call_id or "").strip()
    if not call_id:
        msg = "Missing call_id in webhook payload."
        _append_ingress_rejection(
            reason="missing_call_id",
            message=msg,
            webhook_type=webhook_type,
            payload=payload,
            stored=stored,
            cfg=cfg,
        )
        raise HTTPException(status_code=400, detail=msg)

    record_path = _resolve_record_path(db, payload, pair)

    # Always async from webhook path: enqueue quickly, process heavy steps in dispatcher.
    # This avoids webhook request timeouts that can take the backend out of LB health.
    transcript_cached = _transcript_exists(pair["agent"], pair["customer"], call_id)
    transcription_info: dict[str, Any] = {
        "used_cached_transcript": transcript_cached,
        "job_id": "",
        "status": "queued_async",
        "message": (
            "Transcript already exists; pipeline preflight will continue in background."
            if transcript_cached
            else "Transcription/backfill queued for background preflight."
        ),
    }

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
            # Mark webhook-triggered runs explicitly for UI/source separation.
            run_payload["run_origin"] = "webhook"

            pipeline_runs: list[dict[str, Any]] = []
            queued_at = _utc_now_iso()
            for idx, pipeline_id in enumerate(target_pipeline_ids):
                entry: dict[str, Any] = {
                    "pipeline_id": pipeline_id,
                    "triggered": False,
                    "run_id": "",
                    "state": "queued",
                }
                try:
                    _assert_pipeline_exists(pipeline_id)
                    from ui.backend.routers.pipelines import _find_file

                    _, pdef = _find_file(pipeline_id)
                    pipeline_name = str(pdef.get("name") or pipeline_id)
                    run_id = str(uuid.uuid4())
                    queued_payload = dict(run_payload)
                    queued_payload["run_id"] = run_id
                    queued_payload["run_origin"] = "webhook"
                    max_attempts = int(cfg.get("retry_max_attempts") or 2)
                    queue_item = {
                        "id": str(uuid.uuid4()),
                        "webhook_type": webhook_type,
                        "event_id": str(stored.get("event_id") or ""),
                        "event_file": str(stored.get("file") or ""),
                        "created_at": queued_at,
                        "updated_at": queued_at,
                        "state": "queued",
                        "attempts": 0,
                        "max_attempts": max_attempts,
                        "next_attempt_at": queued_at,
                        "last_error": "",
                        "request_base_url": str(request.base_url or ""),
                        "pipeline_id": pipeline_id,
                        "pipeline_name": pipeline_name,
                        "run_id": run_id,
                        "sales_agent": pair["agent"],
                        "customer": pair["customer"],
                        "call_id": call_id,
                        "account_id": pair["account_id"],
                        "crm_url": pair["crm_url"],
                        "pair": {
                            "crm_url": pair["crm_url"],
                            "account_id": pair["account_id"],
                            "agent": pair["agent"],
                            "customer": pair["customer"],
                        },
                        "payload": queued_payload,
                        "record_path": record_path,
                    }
                    created, meta = await _enqueue_live_item(queue_item)
                    if created:
                        _upsert_pipeline_run_stub(
                            run_id=run_id,
                            pipeline_id=pipeline_id,
                            pipeline_name=pipeline_name,
                            sales_agent=pair["agent"],
                            customer=pair["customer"],
                            call_id=call_id,
                            status="queued",
                            log_line="Queued from webhook trigger",
                        )
                    entry.update(
                        {
                            "triggered": False,
                            "run_id": str(meta.get("run_id") or run_id),
                            "state": str(meta.get("state") or ("queued" if created else "queued")),
                            "message": str(meta.get("message") or "Queued for live dispatcher."),
                            "deduplicated": (not created),
                        }
                    )
                except Exception as e:
                    _append_rejected_webhook(
                        {
                            "source": "ingress",
                            "reason": "pipeline_enqueue_failed",
                            "message": str(getattr(e, "detail", "") or str(e) or "pipeline enqueue failed"),
                            "webhook_type": webhook_type,
                            "event_id": str(stored.get("event_id") or ""),
                            "event_file": str(stored.get("file") or ""),
                            "pipeline_ids": [pipeline_id],
                            "run_id": str(run_id),
                            "sales_agent": pair["agent"],
                            "customer": pair["customer"],
                            "call_id": call_id,
                            "pair": {
                                "crm_url": pair.get("crm_url") or "",
                                "account_id": pair.get("account_id") or "",
                                "agent": pair.get("agent") or "",
                                "customer": pair.get("customer") or "",
                            },
                            "payload": payload.model_dump(),
                        }
                    )
                    entry["error"] = str(getattr(e, "detail", "") or str(e) or "pipeline trigger failed")
                pipeline_runs.append(entry)

                # Preserve previous single-pipeline response fields for compatibility.
                if idx == 0:
                    pipeline_info["pipeline_id"] = pipeline_id
                    pipeline_info["run_id"] = str(entry.get("run_id") or "")
                    if entry.get("message"):
                        pipeline_info["message"] = str(entry.get("message") or "")

            ensure_live_dispatcher_started()
            # Kick dispatcher in background; webhook response must return immediately.
            asyncio.create_task(_dispatch_live_queue_once(str(request.base_url or "")))

            # Refresh state after dispatch attempt (some queued runs may become running immediately).
            for entry in pipeline_runs:
                rid = str(entry.get("run_id") or "")
                if not rid:
                    continue
                try:
                    with Session(_db_engine) as _s:
                        _row = _s.get(PipelineRun, rid)
                    if _row:
                        _st = str(_row.status or "").lower()
                        entry["state"] = _st or str(entry.get("state") or "queued")
                        entry["triggered"] = _st == "running"
                except Exception:
                    continue

            pipeline_info["pipelines"] = pipeline_runs
            pipeline_info["triggered"] = any(bool(x.get("triggered")) for x in pipeline_runs)
        else:
            _append_rejected_webhook(
                {
                    "source": "ingress",
                    "reason": "no_pipeline_mapping",
                    "message": "No pipeline mapping found for this agent.",
                    "webhook_type": webhook_type,
                    "event_id": str(stored.get("event_id") or ""),
                    "event_file": str(stored.get("file") or ""),
                    "pipeline_ids": [],
                    "run_id": "",
                    "sales_agent": pair["agent"],
                    "customer": pair["customer"],
                    "call_id": call_id,
                    "pair": {
                        "crm_url": pair.get("crm_url") or "",
                        "account_id": pair.get("account_id") or "",
                        "agent": pair.get("agent") or "",
                        "customer": pair.get("customer") or "",
                    },
                    "payload": payload.model_dump(),
                }
            )
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
        "continuity_filter": {
            "enabled": bool(continuity_filter_enabled),
            "passed": bool(continuity_ok),
            "reason": continuity_reason,
            "meta": continuity_meta,
            "policy": continuity_policy,
        },
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
async def handle_call_updated_webhook(
    request: Request,
    db: Session = Depends(get_session),
) -> dict[str, Any]:
    """
    Flexible endpoint — accepts JSON (flat or wrapped in 'payload' key)
    and form-urlencoded. Handles extra fields like brand_code gracefully.
    """
    content_type = str(request.headers.get("content-type") or "").lower()
    raw: dict[str, Any] = {}

    if "application/json" in content_type:
        try:
            body = await request.json()
        except Exception:
            body = {}
        if isinstance(body, dict):
            # Unwrap {"payload": {...}} if present
            if isinstance(body.get("payload"), dict):
                raw = body["payload"]
            else:
                raw = body
        else:
            raw = {}
    else:
        # form-urlencoded fallback
        try:
            form = await request.form()
            raw = dict(form)
        except Exception:
            raw = {}

    duration_val: Optional[int] = None
    try:
        if raw.get("duration") not in (None, "", "null"):
            duration_val = int(str(raw.get("duration")).strip())
    except Exception:
        duration_val = None

    payload = CallEndedWebhookPayload(
        call_id=str(raw.get("call_id") or "").strip(),
        account_id=str(raw.get("account_id") or "").strip(),
        agent=str(raw.get("agent") or "").strip(),
        record_path=str(raw.get("record_path") or "").strip(),
        duration=duration_val,
        crm_url=str(raw.get("crm_url") or "").strip(),
        customer=str(raw.get("customer") or "").strip(),
        token=str(raw.get("token") or "").strip(),
    )
    return await _handle_call_webhook(
        payload=payload,
        request=request,
        db=db,
        webhook_type="call-updated",
        compat_mode="json" if "application/json" in content_type else "form-urlencoded",
    )
