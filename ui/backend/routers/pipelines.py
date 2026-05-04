"""Pipelines — ordered chains of universal agents."""
import asyncio
import math
import hashlib
import json
import os
import queue as _queue
import re as _re
import threading
import time
import uuid
from collections import Counter
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace as _SimpleNamespace
from typing import Any, Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import text as _sql_text, inspect as _sa_inspect, func as _sql_func
from sqlmodel import Session, select

from ui.backend.config import settings
from ui.backend.database import get_session, engine as _db_engine
from ui.backend.services import log_buffer, execution_logs
from ui.backend.services import user_profiles

router = APIRouter(prefix="/pipelines", tags=["pipelines"])

_DIR = settings.ui_data_dir / "_pipelines"
_STATE_DIR = settings.ui_data_dir / "_pipeline_states"
_RUBRIC_DIR = settings.ui_data_dir / "_analytics_rubrics"
_ARTIFACT_SCHEMA_DIR = settings.ui_data_dir / "_artifact_prompt_schemas"
_BUNDLE_DIR = settings.ui_data_dir / "_pipeline_bundles"
_UNIVERSAL_AGENTS_DIR = settings.ui_data_dir / "_universal_agents"
_AI_REGISTRY_DIR = settings.ui_data_dir / "_ai_registry"
_AI_PIPELINES_FILE = _AI_REGISTRY_DIR / "pipelines_snapshot.json"
_AI_INTERNAL_PROMPTS_FILE = _AI_REGISTRY_DIR / "internal_prompt_templates.json"
_AI_README_FILE = _AI_REGISTRY_DIR / "README.md"
_FOLDERS_FILE = settings.ui_data_dir / "_pipelines_folders.json"
_WEBHOOK_INBOX_DIR = settings.ui_data_dir / "_webhooks" / "inbox"
_WEBHOOK_DIR = settings.ui_data_dir / "_webhooks"
_WEBHOOK_CONFIG_FILE = _WEBHOOK_DIR / "call_ended_config.json"
_STATE_KEY_LIVE_CONFIG = "webhooks.live_config"
_WEBHOOK_STATS_FILE = _WEBHOOK_DIR / "stats.json"
_ACTIVE_RUN_LOCK = threading.Lock()
_ACTIVE_RUN_TASKS: dict[str, asyncio.Task] = {}
_STOP_REQUESTED: dict[str, threading.Event] = {}
_RUN_SUBSCRIBERS: dict[str, list[tuple[str, asyncio.Queue]]] = {}
_CALL_ARTIFACTS_CACHE_LOCK = threading.Lock()
_CALL_ARTIFACTS_CACHE: dict[tuple[str, str, str, str, int], tuple[float, dict[str, Any]]] = {}
_CALL_ARTIFACTS_CACHE_TTL_S = 75.0
_CALL_ARTIFACTS_CACHE_MAX = 600
_MERGED_CALL_INDEX_CACHE_LOCK = threading.Lock()
_MERGED_CALL_INDEX_CACHE: dict[str, tuple[int, list[tuple[str, str]], dict[str, list[str]], dict[str, float]]] = {}


def _user_profile(request: Request) -> dict[str, Any]:
    return user_profiles.get_current_user_profile(request)


def _require_can_view(request: Request) -> dict[str, Any]:
    profile = _user_profile(request)
    if not bool((profile.get("permissions") or {}).get("can_view")):
        raise HTTPException(status_code=403, detail="User is not allowed to access this environment.")
    return profile


def _require_can_create_pipeline(request: Request) -> dict[str, Any]:
    return user_profiles.require_permission(request, "can_create_pipelines")


def _require_can_edit_pipeline(request: Request) -> dict[str, Any]:
    return user_profiles.require_permission(request, "can_edit_pipelines")


def _require_can_run_pipeline(request: Request) -> dict[str, Any]:
    return user_profiles.require_permission(request, "can_run_pipelines")


def _require_can_manage_jobs(request: Request) -> dict[str, Any]:
    return user_profiles.require_permission(request, "can_manage_jobs")


def _require_can_manage_live(request: Request) -> dict[str, Any]:
    return user_profiles.require_permission(request, "can_manage_live_jobs")


def _workspace_owner_for_new_pipeline(request: Request, profile: dict[str, Any]) -> str:
    return ""


def _can_access_pipeline_record(profile: dict[str, Any], data: dict[str, Any]) -> bool:
    if not isinstance(data, dict):
        return False
    perms = profile.get("permissions") if isinstance(profile.get("permissions"), dict) else {}
    if not bool(perms.get("can_view")):
        return False
    if bool(profile.get("is_admin")):
        return True
    # Visibility is environment-wide; ownership is enforced only for modifications.
    # This lets dev users see all pipelines and live-enabled pipelines in selectors.
    return True


def _assert_can_modify_pipeline_record(request: Request, profile: dict[str, Any], data: dict[str, Any]) -> None:
    _require_can_edit_pipeline(request)


def _is_live_mirror_mode(request: Optional[Request] = None) -> bool:
    if not bool(settings.live_mirror_enabled):
        return False
    if not str(settings.live_mirror_base_url or "").strip():
        return False
    if request is not None and str(request.headers.get("x-shinobi-live-mirror-hop") or "").strip() == "1":
        return False
    return True


def _is_live_state_read_only(request: Optional[Request] = None) -> bool:
    # Explicit config switch takes precedence (useful when dev shares prod DB).
    if bool(getattr(settings, "live_state_read_only", False)):
        return True
    # Mirror mode is always read-only.
    return _is_live_mirror_mode(request)


def _live_mirror_headers() -> dict[str, str]:
    headers: dict[str, str] = {"x-shinobi-live-mirror-hop": "1"}
    token = str(settings.live_mirror_auth_token or "").strip()
    if token:
        hdr = str(settings.live_mirror_auth_header or "x-api-token").strip() or "x-api-token"
        headers[hdr] = token
    return headers


def _live_mirror_url(path: str) -> str:
    base = str(settings.live_mirror_base_url or "").strip().rstrip("/")
    p = str(path or "").strip()
    if not p.startswith("/"):
        p = f"/{p}"
    return f"{base}{p}"


def _live_mirror_request_json(
    method: str,
    path: str,
    *,
    request: Optional[Request] = None,
    payload: Optional[dict[str, Any]] = None,
) -> Any:
    if not _is_live_mirror_mode(request):
        raise HTTPException(status_code=500, detail="Live mirror mode is not configured.")
    url = _live_mirror_url(path)
    timeout_s = max(3, min(int(settings.live_mirror_timeout_s or 20), 120))
    try:
        with httpx.Client(timeout=timeout_s, headers=_live_mirror_headers()) as client:
            if str(method or "GET").upper() == "GET":
                resp = client.get(url)
            else:
                resp = client.request(str(method).upper(), url, json=(payload or {}))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Live mirror request failed: {e}") from e
    if resp.status_code >= 400:
        detail = resp.text
        try:
            parsed = resp.json()
            if isinstance(parsed, dict):
                detail = str(parsed.get("detail") or parsed.get("error") or detail)
        except Exception:
            pass
        raise HTTPException(status_code=resp.status_code, detail=f"Live mirror error: {detail}")
    try:
        return resp.json()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Live mirror returned invalid JSON: {e}") from e


def _norm_ci(value: Any) -> str:
    return str(value or "").strip().lower()


def _parse_iso_to_ms(value: Any) -> int:
    raw = str(value or "").strip()
    if not raw:
        return 0
    try:
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except Exception:
        return 0
    try:
        return int(dt.timestamp() * 1000)
    except Exception:
        return 0


def _find_latest_matching_webhook_event(
    *,
    after_ms: int,
    sales_agent: str,
    customer: str,
    call_id: str,
    limit_files: int = 300,
) -> Optional[dict[str, Any]]:
    try:
        if not _WEBHOOK_INBOX_DIR.exists():
            return None
        files = sorted(
            _WEBHOOK_INBOX_DIR.glob("*.json"),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )[: max(10, min(int(limit_files or 300), 2000))]
    except Exception:
        return None

    wanted_agent = _norm_ci(sales_agent)
    wanted_customer = _norm_ci(customer)
    wanted_call_id = _norm_ci(call_id)

    for fp in files:
        try:
            st = fp.stat()
            mtime_ms = int(float(st.st_mtime) * 1000.0)
            if after_ms > 0 and mtime_ms <= after_ms:
                # Files are newest-first; once below cursor, older files won't match either.
                break
            raw = json.loads(fp.read_text(encoding="utf-8", errors="replace"))
            payload = raw.get("payload") if isinstance(raw.get("payload"), dict) else {}
        except Exception:
            continue

        payload_agent = _norm_ci(payload.get("agent"))
        payload_customer = _norm_ci(payload.get("customer"))
        payload_call_id = _norm_ci(payload.get("call_id"))

        if wanted_agent and payload_agent and payload_agent != wanted_agent:
            continue
        if wanted_call_id and payload_call_id and payload_call_id != wanted_call_id:
            continue
        # Customer is optional in webhook payload; if present it must match.
        if wanted_customer and payload_customer and payload_customer != wanted_customer:
            continue

        received_at = str(raw.get("received_at") or "")
        received_ms = _parse_iso_to_ms(received_at) or mtime_ms
        if after_ms > 0 and received_ms <= after_ms:
            continue

        return {
            "event_id": str(raw.get("event_id") or ""),
            "webhook_type": str(raw.get("webhook_type") or ""),
            "compat_mode": str(raw.get("compat_mode") or ""),
            "received_at": received_at,
            "received_ms": received_ms,
            "file": str(fp),
            "payload": payload,
        }
    return None


def _safe_template_format(template: str, values: dict[str, Any]) -> str:
    class _SafeDict(dict):
        def __missing__(self, key: str) -> str:
            return "{" + key + "}"
    try:
        return str(template or "").format_map(_SafeDict(values))
    except Exception:
        return str(template or "")


def _default_live_webhook_config() -> dict[str, Any]:
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
        "max_live_running": 5,
        "agent_continuity_filter_enabled": True,
        "auto_retry_enabled": True,
        "retry_max_attempts": 2,
        "retry_delay_s": 45,
        "retry_on_server_error": True,
        "retry_on_rate_limit": True,
        "retry_on_timeout": True,
        "send_note_pipeline_ids": [],
        "run_payload": {
            "resume_partial": True,
        },
    }


def _normalize_live_webhook_config(raw: Any) -> dict[str, Any]:
    base = _default_live_webhook_config()
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
    send_note_ids = base.get("send_note_pipeline_ids")
    if isinstance(send_note_ids, list):
        dedup_send: list[str] = []
        seen_send: set[str] = set()
        for v in send_note_ids:
            pid = str(v or "").strip()
            if not pid or pid in seen_send:
                continue
            seen_send.add(pid)
            dedup_send.append(pid)
        base["send_note_pipeline_ids"] = dedup_send
    else:
        base["send_note_pipeline_ids"] = []
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
        base["max_live_running"] = max(1, min(int(base.get("max_live_running") or 5), 64))
    except Exception:
        base["max_live_running"] = 5
    base["agent_continuity_filter_enabled"] = bool(base.get("agent_continuity_filter_enabled", True))
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


def _load_live_webhook_config() -> dict[str, Any]:
    from ui.backend.routers.webhooks import _live_state_use_db, _load_state_blob_db, _save_state_blob_db
    if _live_state_use_db():
        ok, raw = _load_state_blob_db(_STATE_KEY_LIVE_CONFIG)
        if ok and isinstance(raw, dict):
            return _normalize_live_webhook_config(raw)
    _WEBHOOK_DIR.mkdir(parents=True, exist_ok=True)
    if not _WEBHOOK_CONFIG_FILE.exists():
        cfg = _default_live_webhook_config()
        _WEBHOOK_CONFIG_FILE.write_text(json.dumps(cfg, indent=2, ensure_ascii=False), encoding="utf-8")
        if _live_state_use_db():
            _save_state_blob_db(_STATE_KEY_LIVE_CONFIG, cfg)
        return cfg
    try:
        raw = json.loads(_WEBHOOK_CONFIG_FILE.read_text(encoding="utf-8"))
    except Exception:
        raw = {}
    cfg = _normalize_live_webhook_config(raw)
    # Promote local file into DB on first read so both VMs converge.
    if _live_state_use_db():
        _save_state_blob_db(_STATE_KEY_LIVE_CONFIG, cfg)
    return cfg


def _save_live_webhook_config(cfg: dict[str, Any]) -> dict[str, Any]:
    from ui.backend.routers.webhooks import _live_state_use_db, _save_state_blob_db
    norm = _normalize_live_webhook_config(cfg)
    if _live_state_use_db():
        _save_state_blob_db(_STATE_KEY_LIVE_CONFIG, norm)
    _WEBHOOK_DIR.mkdir(parents=True, exist_ok=True)
    _WEBHOOK_CONFIG_FILE.write_text(json.dumps(norm, indent=2, ensure_ascii=False), encoding="utf-8")
    return norm


def _default_live_webhook_stats() -> dict[str, Any]:
    return {
        "rejected_webhooks_total": 0,
        "rejected_by_reason": {},
        "updated_at": "",
    }


def _load_live_webhook_stats() -> dict[str, Any]:
    _WEBHOOK_DIR.mkdir(parents=True, exist_ok=True)
    if not _WEBHOOK_STATS_FILE.exists():
        return _default_live_webhook_stats()
    try:
        raw = json.loads(_WEBHOOK_STATS_FILE.read_text(encoding="utf-8"))
    except Exception:
        return _default_live_webhook_stats()
    if not isinstance(raw, dict):
        return _default_live_webhook_stats()
    out = _default_live_webhook_stats()
    try:
        out["rejected_webhooks_total"] = max(0, int(raw.get("rejected_webhooks_total") or 0))
    except Exception:
        out["rejected_webhooks_total"] = 0
    by_reason = raw.get("rejected_by_reason")
    if isinstance(by_reason, dict):
        norm_reason: dict[str, int] = {}
        for k, v in by_reason.items():
            kk = str(k or "").strip()
            if not kk:
                continue
            try:
                norm_reason[kk] = max(0, int(v or 0))
            except Exception:
                norm_reason[kk] = 0
        out["rejected_by_reason"] = norm_reason
    out["updated_at"] = str(raw.get("updated_at") or "").strip()
    return out


_CALL_ID_PRESERVATION_PERSONA = """
CALL ID PRESERVATION (MANDATORY)

- Preserve original call identifiers from input. Do NOT replace original CALL_ID values with generic labels.
- You may keep sequential order, but each included call section must carry the exact original CALL_ID.
- Required call heading format:
### Call <sequential_index> | CALL_ID: <exact_original_call_id>
- If exact call id is unavailable, use CALL_ID: UNKNOWN.
- Do NOT merge different CALL_IDs into one call section.
"""


_CALL_ID_PRESERVATION_NOTES = """
CALL-LEVEL OUTPUT INTEGRITY (MANDATORY)

- Output one System Note section for each call section provided by Stage 2.
- Do NOT merge multiple call IDs into one note block.
- Ensure each note block is explicitly tied to the exact CALL_ID.
- If exact call id is unavailable, use CALL_ID: UNKNOWN.
"""


def _append_once(base: str, block: str) -> str:
    _b = str(base or "")
    _blk = str(block or "").strip()
    if not _blk:
        return _b
    if _blk in _b:
        return _b
    if _b.strip():
        return _b.rstrip() + "\n\n" + _blk + "\n"
    return _blk + "\n"


def _apply_call_id_contract(
    system_prompt: str,
    user_template: str,
    agent_def: dict[str, Any],
    artifact_sub_type: str,
) -> tuple[str, str]:
    """Enforce stable call-id output contract for persona/notes style artifacts."""
    _sub = str(artifact_sub_type or "").strip().lower()
    _cls = str((agent_def or {}).get("agent_class") or "").strip().lower()
    _name = str((agent_def or {}).get("name") or "").strip().lower()
    _tags = " ".join([str(t or "").strip().lower() for t in ((agent_def or {}).get("tags") or [])])
    _hints = " ".join([_sub, _cls, _name, _tags])

    _is_persona = ("persona" in _hints) and ("score" not in _hints)
    _is_notes = ("notes" in _hints) and ("compliance" not in _hints or "notes" in _sub)

    _sys = str(system_prompt or "")
    _usr = str(user_template or "")

    if _is_persona:
        _usr = _append_once(_usr, _CALL_ID_PRESERVATION_PERSONA)
    if _is_notes:
        _sys = _append_once(_sys, _CALL_ID_PRESERVATION_NOTES)
    return _sys, _usr


_OUTPUT_CONTRACT_MODES = {"off", "soft", "strict"}
_OUTPUT_FIT_STRATEGIES = {"structured", "raw"}
_OUTPUT_RESPONSE_MODES = {"wrap", "transform", "custom_format"}
_OUTPUT_TARGET_TYPES = {"raw_text", "markdown", "json"}


def _normalize_output_contract_mode(value: Any) -> str:
    v = str(value or "").strip().lower() or "soft"
    return v if v in _OUTPUT_CONTRACT_MODES else "soft"


def _normalize_output_fit_strategy(value: Any) -> str:
    v = str(value or "").strip().lower() or "structured"
    return v if v in _OUTPUT_FIT_STRATEGIES else "structured"


def _normalize_output_response_mode(value: Any) -> str:
    v = str(value or "").strip().lower() or "wrap"
    return v if v in _OUTPUT_RESPONSE_MODES else "wrap"


def _normalize_output_target_type(value: Any) -> str:
    v = str(value or "").strip().lower() or "raw_text"
    return v if v in _OUTPUT_TARGET_TYPES else "raw_text"


def _normalize_placeholder_name(value: Any, default: str) -> str:
    raw = str(value or "").strip()
    if raw.startswith("{") and raw.endswith("}") and len(raw) > 2:
        raw = raw[1:-1].strip()
    raw = raw.replace(" ", "_")
    raw = _re.sub(r"[^a-zA-Z0-9_]", "_", raw).strip("_")
    return raw or default


def _normalize_output_contract_override(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    out: dict[str, Any] = {}
    artifact_type = str(value.get("artifact_type") or "").strip()
    artifact_class = str(value.get("artifact_class") or "").strip()
    artifact_name = str(value.get("artifact_name") or "").strip()
    output_format = str(value.get("output_format") or "").strip().lower()
    output_schema = str(value.get("output_schema") or "").strip()
    output_response_mode = _normalize_output_response_mode(value.get("output_response_mode"))
    output_target_type = _normalize_output_target_type(value.get("output_target_type"))
    output_template = str(value.get("output_template") or "")
    output_placeholder = _normalize_placeholder_name(value.get("output_placeholder"), "response")
    output_previous_placeholder = _normalize_placeholder_name(
        value.get("output_previous_placeholder"),
        "previous_response",
    )
    has_response_mode = "output_response_mode" in value
    has_target_type = "output_target_type" in value
    has_template = "output_template" in value
    has_placeholder = "output_placeholder" in value
    has_prev_placeholder = "output_previous_placeholder" in value
    has_mode = "output_contract_mode" in value
    has_fit = "output_fit_strategy" in value
    output_contract_mode = _normalize_output_contract_mode(value.get("output_contract_mode"))
    output_fit_strategy = _normalize_output_fit_strategy(value.get("output_fit_strategy"))
    raw_tax = value.get("output_taxonomy")
    output_taxonomy = [str(x or "").strip() for x in raw_tax] if isinstance(raw_tax, list) else []
    output_taxonomy = [x for x in output_taxonomy if x]

    if artifact_type:
        out["artifact_type"] = artifact_type
    if artifact_class:
        out["artifact_class"] = artifact_class
    if artifact_name:
        out["artifact_name"] = artifact_name
    if output_format in {"markdown", "json", "text"}:
        out["output_format"] = output_format
    if output_schema:
        out["output_schema"] = output_schema
    if output_taxonomy:
        out["output_taxonomy"] = output_taxonomy
    if has_response_mode:
        out["output_response_mode"] = output_response_mode
    if has_target_type:
        out["output_target_type"] = output_target_type
    if has_template:
        out["output_template"] = output_template
    if has_placeholder:
        out["output_placeholder"] = output_placeholder
    if has_prev_placeholder:
        out["output_previous_placeholder"] = output_previous_placeholder
    if has_mode:
        out["output_contract_mode"] = output_contract_mode
    if has_fit:
        out["output_fit_strategy"] = output_fit_strategy
    return out


def _apply_step_output_contract_override(agent_def: dict[str, Any], step_def: dict[str, Any]) -> dict[str, Any]:
    base = dict(agent_def or {})
    override = _normalize_output_contract_override((step_def or {}).get("output_contract_override"))
    if not override:
        return base
    base.update(override)
    return base


def _build_output_contract_block(agent_def: dict[str, Any]) -> str:
    schema = str(agent_def.get("output_schema") or "").strip()
    if not schema:
        return ""
    artifact_type = str(agent_def.get("artifact_type") or "").strip() or "artifact"
    artifact_class = str(agent_def.get("artifact_class") or "").strip() or "general"
    taxonomy = [str(x or "").strip() for x in (agent_def.get("output_taxonomy") or []) if str(x or "").strip()]
    fit_strategy = _normalize_output_fit_strategy(agent_def.get("output_fit_strategy"))
    lines = [
        "OUTPUT CONTRACT (MANDATORY)",
        f"- Artifact Type: {artifact_type}",
        f"- Artifact Class: {artifact_class}",
        f"- Fit Strategy: {fit_strategy}",
        "- Follow the required schema below exactly in structure and ordering.",
        "- Preserve factual content from inputs. If unknown, use UNKNOWN.",
    ]
    if taxonomy:
        lines.append("- Preferred taxonomy sections:")
        lines.extend([f"  - {t}" for t in taxonomy])
    lines.append("")
    lines.append("REQUIRED OUTPUT SCHEMA:")
    lines.append(schema)
    return "\n".join(lines).strip()


def _apply_output_contract_to_prompts(
    system_prompt: str,
    user_template: str,
    agent_def: dict[str, Any],
) -> tuple[str, str]:
    mode = _normalize_output_contract_mode(agent_def.get("output_contract_mode"))
    block = _build_output_contract_block(agent_def)
    sys = str(system_prompt or "")
    usr = str(user_template or "")
    if mode != "off" and block:
        sys = _append_once(sys, block)
        if mode == "strict":
            usr = _append_once(
                usr,
                "STRICT OUTPUT REQUIREMENT:\n- Follow the OUTPUT CONTRACT exactly.\n- Return only the final formatted output.",
            )
    return sys, usr


def _wrap_agent_output(raw_output: str, target_type: str) -> str:
    raw = str(raw_output or "")
    target = _normalize_output_target_type(target_type)
    if target == "raw_text":
        return raw
    if target == "markdown":
        body = raw.strip()
        if not body:
            return "## Response\n\n"
        return f"## Response\n\n{body}"
    # json
    return json.dumps({"response": raw}, ensure_ascii=False, indent=2)


def _apply_custom_output_template(
    *,
    template: str,
    response: str,
    previous_response: str,
    placeholder: str,
    previous_placeholder: str,
) -> str:
    raw_template = str(template or "")
    if not raw_template.strip():
        return str(response or "")
    response_name = _normalize_placeholder_name(placeholder, "response")
    prev_name = _normalize_placeholder_name(previous_placeholder, "previous_response")

    response_token = "{" + response_name + "}"
    previous_token = "{" + prev_name + "}"

    out = raw_template
    if response_token not in out and "{response}" in out:
        out = out.replace("{response}", str(response or ""))
    else:
        out = out.replace(response_token, str(response or ""))
    if previous_token not in out and "{previous_response}" in out:
        out = out.replace("{previous_response}", str(previous_response or ""))
    else:
        out = out.replace(previous_token, str(previous_response or ""))
    return out


def _default_internal_prompt_templates() -> dict[str, Any]:
    return {
        "analytics_rubric": {
            "system_prompt": (
                "You extract metric label rubrics from prompt templates.\n"
                "Return STRICT JSON only: {\"labels\": [\"...\"]}\n"
                "No markdown fences, no explanation."
            ),
            "user_prompt_template": (
                "Kind: {kind}\n"
                "Agent Name: {agent_name}\n"
                "Agent Class: {agent_class}\n\n"
                "SYSTEM PROMPT:\n{system_prompt}\n\n"
                "USER PROMPT:\n{user_prompt}\n\n"
                "Rules:\n"
                "- Return concise canonical labels.\n"
                "- Merge equivalent labels into one taxonomy.\n"
                "- Keep output deterministic."
            ),
        },
        "artifact_template": {
            "system_prompt": (
                "You infer expected artifact output schema from agent prompts.\n"
                "Return STRICT JSON only with keys:\n"
                "schema_template (string markdown), taxonomy (string[]), fields (object[]).\n"
                "Each field object: name (string), type (string), required (boolean), description (string).\n"
                "No markdown fences. No commentary."
            ),
            "user_prompt_template": (
                "Agent Name: {agent_name}\n"
                "Agent Class: {agent_class}\n"
                "Artifact Sub Type: {artifact_sub_type}\n\n"
                "SYSTEM PROMPT:\n{system_prompt}\n\n"
                "USER PROMPT:\n{user_prompt}\n\n"
                "Task:\n"
                "1) Derive concise expected output template from prompts.\n"
                "2) Extract taxonomy labels/sections.\n"
                "3) Infer structured fields where possible.\n"
                "4) Keep taxonomy canonical and deduplicated."
            ),
        },
    }


def _ensure_ai_registry_layout() -> None:
    try:
        _AI_REGISTRY_DIR.mkdir(parents=True, exist_ok=True)
        if not _AI_README_FILE.exists():
            _AI_README_FILE.write_text(
                (
                    "# AI Registry\n\n"
                    "This folder exposes app AI configurations in one place.\n\n"
                    "- `universal_agents_snapshot.json`: user-defined universal agents\n"
                    "- `pipelines_snapshot.json`: pipeline definitions\n"
                    "- `internal_prompt_templates.json`: internal LLM prompt templates used by analytics/artifact schema helpers\n"
                ),
                encoding="utf-8",
            )
    except Exception:
        pass


def _load_internal_prompt_templates() -> dict[str, Any]:
    defaults = _default_internal_prompt_templates()
    _ensure_ai_registry_layout()
    try:
        if _AI_INTERNAL_PROMPTS_FILE.exists():
            raw = json.loads(_AI_INTERNAL_PROMPTS_FILE.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                out = defaults.copy()
                for k, v in raw.items():
                    if isinstance(v, dict):
                        base = out.get(k, {}) if isinstance(out.get(k), dict) else {}
                        out[k] = {**base, **v}
                _AI_INTERNAL_PROMPTS_FILE.write_text(
                    json.dumps(out, ensure_ascii=False, indent=2),
                    encoding="utf-8",
                )
                return out
        _AI_INTERNAL_PROMPTS_FILE.write_text(
            json.dumps(defaults, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    except Exception:
        pass
    return defaults


def _sync_ai_registry_pipelines() -> None:
    try:
        _ensure_ai_registry_layout()
        rows = _load_all()
        payload = []
        for p in rows:
            payload.append({
                "id": str(p.get("id") or ""),
                "name": str(p.get("name") or ""),
                "folder": str(p.get("folder") or ""),
                "scope": str(p.get("scope") or ""),
                "step_count": len(p.get("steps") or []),
                "updated_at": str(p.get("updated_at") or p.get("created_at") or ""),
                "path": f"_pipelines/{str(p.get('id') or '')}.json",
            })
        payload.sort(key=lambda x: (x["name"].lower(), x["id"]))
        _AI_PIPELINES_FILE.write_text(
            json.dumps(
                {
                    "generated_at": datetime.utcnow().isoformat(),
                    "count": len(payload),
                    "source_directories": {
                        "universal_agents": "_universal_agents/",
                        "pipelines": "_pipelines/",
                        "notes_agents": "_notes_agents/",
                        "persona_agents": "_persona_agents/",
                        "fpa_analyzer_presets": "_fpa_analyzer_presets/",
                        "fpa_generator_presets": "_fpa_generator_presets/",
                        "fpa_scorer_presets": "_fpa_scorer_presets/",
                        "analytics_rubrics": "_analytics_rubrics/",
                        "artifact_prompt_schemas": "_artifact_prompt_schemas/",
                    },
                    "pipelines": payload,
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
    except Exception:
        pass


def _pair_key(pipeline_id: str, sales_agent: str, customer: str) -> str:
    """Deterministic filename key for a pipeline+pair state file.
    Uses an MD5 hash of the raw pair strings so the filename is stable and
    never affected by URL-encoding, case, or whitespace differences."""
    pair_hash = hashlib.md5(f"{sales_agent}::{customer}".encode("utf-8")).hexdigest()[:10]
    return f"{pipeline_id}_{pair_hash}"


def _run_slot_key(pipeline_id: str, sales_agent: str, customer: str, call_id: str) -> str:
    return f"{pipeline_id}::{sales_agent}::{customer}::{call_id or ''}"


def _save_state(
    pipeline_id: str,
    run_id: str,
    sales_agent: str,
    customer: str,
    status: str,
    steps: list,
    force: bool = False,
    start_datetime: str = "",
    node_states: Optional[dict] = None,
) -> None:
    """Write live run state to a JSON file keyed by pipeline+pair hash.
    Called from save_steps() (status='running') and on completion/error.
    For browser refresh/disconnect, keep the last snapshot as 'running'
    so the UI can restore without showing a false failure.

    force=True: always write (used for the initial claim by a new run).
    force=False: skip if a *different* run_id already owns the file (kill-and-restart guard —
                 prevents an orphaned old generator from overwriting the new run's state).

    State file schema:
      pipeline status: idle | running | pass | failed
      step state:      waiting | running | completed | failed
      step fields:     start_time, end_time, cached_locations"""
    try:
        _STATE_DIR.mkdir(parents=True, exist_ok=True)
        path = _STATE_DIR / f"{_pair_key(pipeline_id, sales_agent, customer)}.json"
        if not force:
            try:
                existing = json.loads(path.read_text(encoding="utf-8"))
                if existing.get("run_id") and existing.get("run_id") != run_id:
                    return  # a newer run has claimed this file — don't overwrite
            except Exception:
                pass
        sanitized_steps: list = []
        for step in (steps or []):
            if isinstance(step, dict):
                step_copy = dict(step)
                # State file is for execution status only; keep heavy model output out.
                step_copy["content"] = ""
                step_copy["thinking"] = ""
                sanitized_steps.append(step_copy)
            else:
                sanitized_steps.append(step)

        path.write_text(
            json.dumps({
                "pipeline_id":    pipeline_id,
                "run_id":         run_id,
                "sales_agent":    sales_agent,
                "customer":       customer,
                "status":         status,
                "start_datetime": start_datetime,
                "updated_at":     datetime.utcnow().isoformat(),
                "steps":          sanitized_steps,
                "node_states":    node_states or {"input": {}, "processing": {}, "output": {}},
            }, ensure_ascii=False),
            encoding="utf-8",
        )
    except Exception:
        pass


class PipelineStep(BaseModel):
    agent_id: str
    input_overrides: dict[str, str] = {}
    output_contract_override: dict[str, Any] = {}


class PipelineIn(BaseModel):
    name: str
    description: str = ""
    scope: str = "per_pair"
    steps: list[PipelineStep] = []
    canvas: dict = {}
    folder: str = ""


class FolderIn(BaseModel):
    name: str


class FolderDeleteIn(BaseModel):
    name: str


class FolderMoveIn(BaseModel):
    folder: str = ""


class PipelineBundleImportIn(BaseModel):
    bundle: dict[str, Any]
    target_folder: str = ""


# ── Helpers ───────────────────────────────────────────────────────────────────

def _hash_text(value: str) -> str:
    return hashlib.sha256((value or "").encode("utf-8")).hexdigest()


def _model_provider_name(model: str) -> str:
    m = str(model or "").strip().lower()
    if not m:
        return "unknown"
    if m.startswith("gpt") or m.startswith("o1") or m.startswith("o3") or m.startswith("o4"):
        return "openai"
    if m.startswith("claude-"):
        return "anthropic"
    if m.startswith("gemini"):
        return "google"
    if m.startswith("grok"):
        return "xai"
    return "unknown"


def _build_input_fingerprint(
    pipeline_id: str,
    step_idx: int,
    agent_id: str,
    model: str,
    temperature: float,
    system_prompt: str,
    user_template: str,
    overrides: dict[str, str],
    resolved_inputs: dict[str, str],
    output_profile: Optional[dict[str, Any]] = None,
) -> str:
    profile = output_profile or {}
    payload = {
        "pipeline_id": pipeline_id,
        "step_idx": step_idx,
        "agent_id": agent_id,
        "model": model,
        "temperature": temperature,
        "system_prompt_hash": _hash_text(system_prompt),
        "user_prompt_hash": _hash_text(user_template),
        "overrides": overrides,
        "resolved_hashes": {k: _hash_text(v) for k, v in sorted(resolved_inputs.items())},
        "output_profile": {
            "artifact_type": str(profile.get("artifact_type") or ""),
            "artifact_class": str(profile.get("artifact_class") or ""),
            "artifact_name": str(profile.get("artifact_name") or ""),
            "output_format": str(profile.get("output_format") or ""),
            "output_schema_hash": _hash_text(str(profile.get("output_schema") or "")),
            "output_taxonomy": [str(x or "").strip() for x in (profile.get("output_taxonomy") or []) if str(x or "").strip()],
            "output_contract_mode": _normalize_output_contract_mode(profile.get("output_contract_mode")),
            "output_fit_strategy": _normalize_output_fit_strategy(profile.get("output_fit_strategy")),
            "output_response_mode": _normalize_output_response_mode(profile.get("output_response_mode")),
            "output_target_type": _normalize_output_target_type(profile.get("output_target_type")),
            "output_template_hash": _hash_text(str(profile.get("output_template") or "")),
            "output_placeholder": _normalize_placeholder_name(profile.get("output_placeholder"), "response"),
            "output_previous_placeholder": _normalize_placeholder_name(
                profile.get("output_previous_placeholder"),
                "previous_response",
            ),
        },
    }
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    ).hexdigest()


def _validate_pipeline_payload(req: PipelineIn) -> None:
    for i, step in enumerate(req.steps):
        if not (step.agent_id or "").strip():
            raise HTTPException(400, f"Pipeline step {i + 1} is missing agent_id")

    canvas_nodes = (req.canvas or {}).get("nodes", []) if isinstance(req.canvas, dict) else []
    if not canvas_nodes:
        return

    proc_nodes = [n for n in canvas_nodes if n.get("type") == "processing"]
    unassigned = [n for n in proc_nodes if not (n.get("data", {}) or {}).get("agentId")]
    if unassigned:
        raise HTTPException(
            400,
            f"Canvas has {len(unassigned)} processing node(s) without an assigned agent. "
            "Assign an agent or remove those nodes before saving.",
        )

    proc_with_agent = [n for n in proc_nodes if (n.get("data", {}) or {}).get("agentId")]
    if proc_with_agent and len(proc_with_agent) < len(req.steps):
        raise HTTPException(
            400,
            "Canvas/step mismatch: fewer assigned processing nodes than pipeline steps.",
        )


def _extract_agent_output_subtypes(canvas_json: str) -> dict[str, str]:
    """Map processing agent_id -> output subType from canvas snapshot."""
    try:
        canvas = json.loads(canvas_json or "{}")
        nodes = canvas.get("nodes") or []
        edges = canvas.get("edges") or []
        if not isinstance(nodes, list) or not isinstance(edges, list):
            return {}

        node_by_id: dict[str, dict] = {}
        for n in nodes:
            if isinstance(n, dict):
                node_by_id[str(n.get("id") or "")] = n

        out_edges: dict[str, list[str]] = {}
        for e in edges:
            if not isinstance(e, dict):
                continue
            src = str(e.get("source") or "")
            dst = str(e.get("target") or "")
            if not src or not dst:
                continue
            out_edges.setdefault(src, []).append(dst)

        out: dict[str, str] = {}
        for n in nodes:
            if not isinstance(n, dict):
                continue
            if str(n.get("type") or "") != "processing":
                continue
            data = n.get("data") or {}
            if not isinstance(data, dict):
                continue
            agent_id = str(data.get("agentId") or "").strip()
            if not agent_id:
                continue
            for dst in out_edges.get(str(n.get("id") or ""), []):
                out_node = node_by_id.get(dst) or {}
                if str(out_node.get("type") or "") != "output":
                    continue
                out_data = out_node.get("data") or {}
                if not isinstance(out_data, dict):
                    continue
                sub_type = str(out_data.get("subType") or "").strip().lower()
                if sub_type:
                    out[agent_id] = sub_type
                    break
        return out
    except Exception:
        return {}


def _normalise_metric_name(name: str) -> str:
    return " ".join(str(name or "").strip().split())


def _is_summary_violation_metric(name: str) -> bool:
    low = _normalise_metric_name(name).lower()
    if not low:
        return False
    # Summary lines should not be counted as a violation type.
    return low.startswith("total violations")


def _canonical_score_taxonomy_label(name: str) -> str:
    n = _normalise_metric_name(name)
    if not n:
        return n
    n = _re.sub(r"^\d+\s*[\).\:-]\s*", "", n).strip()
    n = _re.sub(r"\s*[\-–:]?\s*score\s*$", "", n, flags=_re.IGNORECASE).strip()
    n = _re.sub(r"\s*/\s*100\s*$", "", n).strip()
    return _normalise_metric_name(n)


def _canonical_violation_taxonomy_label(name: str) -> str:
    n = _normalise_metric_name(name)
    if not n:
        return n
    slug = _slug_metric_name(n)
    if not slug:
        return n

    if "secret" in slug and "code" in slug:
        return "Secret Code Violations"
    if (
        "simpletruthaboutyourmoney" in slug
        or ("requiredemail" in slug and "money" in slug)
        or ("emailviolations" in slug and "simpletruth" in slug)
    ):
        return "Simple Truth About Your Money Email Violations"
    if "emailverification" in slug and (
        "missing" in slug or "receipt" in slug or "view" in slug or "read" in slug
    ):
        return "Email Verification Missing"
    if ("multiplatform" in slug or "successfee" in slug) and (
        "followup" in slug or "followupverification" in slug or "verification" in slug
    ):
        return "Multi-Platform Follow-Up Missing"
    if ("multiplatform" in slug or "successfee" in slug) and (
        "offer" in slug or "introduction" in slug or "introduced" in slug
    ):
        return "Multi-Platform Offer Missing"
    return n


def _canonical_taxonomy_label(kind: str, name: str) -> str:
    k = str(kind or "").strip().lower()
    if k == "score":
        return _canonical_score_taxonomy_label(name)
    if k == "violation":
        return _canonical_violation_taxonomy_label(name)
    return _normalise_metric_name(name)


def _parse_scores_from_text(content: str) -> dict[str, float]:
    """Extract section scores from JSON or markdown/text score blocks."""
    txt = (content or "").strip()
    if not txt:
        return {}

    def _from_obj(obj: Any) -> dict[str, float]:
        out: dict[str, float] = {}
        if not isinstance(obj, dict):
            return out
        for raw_k, raw_v in obj.items():
            key = _normalise_metric_name(str(raw_k or ""))
            if not key or key.startswith("_"):
                continue
            score: Optional[float] = None
            if isinstance(raw_v, (int, float)):
                score = float(raw_v)
            elif isinstance(raw_v, dict):
                sv = raw_v.get("score")
                if isinstance(sv, (int, float)):
                    score = float(sv)
            if score is None:
                continue
            out[key] = max(0.0, min(100.0, score))
        return out

    # Direct JSON first.
    try:
        parsed = json.loads(txt)
        got = _from_obj(parsed)
        if got:
            return got
    except Exception:
        pass

    # JSON embedded in text/codefence.
    try:
        m = _re.search(r"\{[\s\S]+\}", txt)
        if m:
            parsed = json.loads(m.group(0))
            got = _from_obj(parsed)
            if got:
                return got
    except Exception:
        pass

    out: dict[str, float] = {}

    # Pattern: "Category Name" line followed by "Score: 88/100".
    for sec, score in _re.findall(
        r"(?im)^\s*([^\n:][^\n]{1,120})\s*\n\s*Score:\s*([0-9]{1,3})(?:\s*/\s*100)?\s*$",
        txt,
    ):
        k = _normalise_metric_name(sec)
        if not k:
            continue
        out[k] = max(0.0, min(100.0, float(score)))

    # Pattern: "Category: 88/100".
    for sec, score in _re.findall(
        r"(?im)^\s*[•\-\*]?\s*([^:\n]{2,120})\s*:\s*([0-9]{1,3})\s*/\s*100\b",
        txt,
    ):
        k = _normalise_metric_name(sec)
        if not k:
            continue
        out[k] = max(0.0, min(100.0, float(score)))

    return out


def _parse_violations_from_text(content: str) -> dict[str, int]:
    """Extract violation totals by procedure from notes/compliance text."""
    txt = (content or "").strip()
    if not txt:
        return {}

    summary_counts: dict[str, int] = {}
    line_counts: dict[str, int] = {}
    current_proc = ""
    in_summary = False

    for raw in txt.splitlines():
        line = str(raw or "").strip()
        if not line:
            continue
        low = line.lower()

        if "total violations by procedure" in low:
            in_summary = True
            continue

        if in_summary:
            m = _re.match(r"^[•\-\*]\s*(.+?)\s*:\s*(\d+)\s*$", line)
            if m:
                k = _normalise_metric_name(m.group(1))
                if k:
                    summary_counts[k] = int(m.group(2))
                continue
            # Allow plain "Total Violations (All Procedures): X"
            m2 = _re.match(r"^total violations.*?:\s*(\d+)\s*$", low)
            if m2:
                # This is a summary row, not a violation type metric.
                continue

        # Track the current procedure title preceding status lines.
        proc_match = _re.match(r"^[•\-\*]\s*(.+?)\s*$", line)
        if proc_match:
            current_proc = _normalise_metric_name(proc_match.group(1))

        if "[violation]" in low:
            key = current_proc
            if not key:
                m = _re.search(r"\[violation\]\s*[–-]\s*(.+)$", line, _re.IGNORECASE)
                key = _normalise_metric_name(m.group(1)) if m else "Violation"
            line_counts[key] = line_counts.get(key, 0) + 1

    if summary_counts:
        for k in list(summary_counts.keys()):
            if _is_summary_violation_metric(k):
                summary_counts.pop(k, None)
        for k, v in line_counts.items():
            if k not in summary_counts:
                summary_counts[k] = v
        return summary_counts

    return {k: v for k, v in line_counts.items() if not _is_summary_violation_metric(k)}


def _unique_metric_list(items: list[str], kind: str = "") -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for raw in items:
        key = _canonical_taxonomy_label(kind, raw)
        if not key:
            continue
        if str(kind).strip().lower() == "violation" and _is_summary_violation_metric(key):
            continue
        low = key.lower()
        if low in seen:
            continue
        seen.add(low)
        out.append(key)
    return out


def _slug_metric_name(name: str) -> str:
    return _re.sub(r"[^a-z0-9]+", "", str(name or "").lower())


def _build_catalog_lookup(items: list[str], kind: str = "") -> dict[str, str]:
    out: dict[str, str] = {}
    for item in items:
        canonical = _canonical_taxonomy_label(kind, item)
        slug = _slug_metric_name(canonical)
        if slug and slug not in out:
            out[slug] = canonical
    return out


def _canonical_metric_name(name: str, lookup: dict[str, str], kind: str = "") -> str:
    normalized = _canonical_taxonomy_label(kind, name)
    if not lookup:
        return normalized
    slug = _slug_metric_name(normalized)
    if slug in lookup:
        return lookup[slug]
    if slug:
        for k, v in lookup.items():
            if slug in k or k in slug:
                return v
    return normalized


def _extract_json_obj_from_text(content: str) -> dict[str, Any]:
    txt = str(content or "").strip()
    if not txt:
        return {}
    for candidate in (
        txt,
        *_re.findall(r"```(?:json)?\s*([\s\S]*?)```", txt, flags=_re.IGNORECASE),
        *_re.findall(r"(\{[\s\S]*\})", txt),
    ):
        s = str(candidate or "").strip()
        if not s:
            continue
        try:
            parsed = json.loads(s)
            if isinstance(parsed, dict):
                return parsed
        except Exception:
            continue
    return {}


def _heuristic_extract_score_sections_from_prompt(system_prompt: str, user_prompt: str) -> list[str]:
    txt = f"{system_prompt or ''}\n\n{user_prompt or ''}"
    found: list[str] = []

    # JSON-style schemas: "Section Name": {"score": ...}
    for sec in _re.findall(
        r'["“]([^"\n]{2,120})["”]\s*:\s*\{[^{}]{0,200}["“]score["”]',
        txt,
        flags=_re.IGNORECASE,
    ):
        k = _normalise_metric_name(sec)
        if k and not k.startswith("_"):
            found.append(k)

    # Section heading followed by Score line.
    for sec in _re.findall(
        r"(?im)^\s*([A-Za-z][^\n:]{2,120})\s*\n\s*Score\s*[:\-]",
        txt,
    ):
        k = _normalise_metric_name(sec)
        if k:
            found.append(k)

    return _unique_metric_list(found, kind="score")


def _heuristic_extract_violation_types_from_prompt(system_prompt: str, user_prompt: str) -> list[str]:
    txt = f"{system_prompt or ''}\n\n{user_prompt or ''}"
    found: list[str] = []

    # Preferred: explicit "Total Violations by Procedure" bullet list.
    if "total violations by procedure" in txt.lower():
        for name in _re.findall(r"(?im)^[•\-\*]\s*(.+?)\s*:\s*[x0-9]+\s*$", txt):
            k = _normalise_metric_name(name)
            if k and "total violations" not in k.lower():
                found.append(k)

    # Fallback: explicit violation labels.
    if not found:
        for name in _re.findall(r"(?im)^[•\-\*]\s*(.+?violations?)\s*$", txt):
            k = _normalise_metric_name(name)
            if k:
                found.append(k)

    return _unique_metric_list(found, kind="violation")


def _infer_prompt_rubric_with_llm(
    kind: str,
    agent_name: str,
    agent_class: str,
    system_prompt: str,
    user_prompt: str,
    db: Session,
) -> tuple[list[str], str]:
    """Use an LLM once to extract stable metric labels from an agent prompt pair."""
    from ui.backend.routers.universal_agents import _llm_call_with_files

    templates = _load_internal_prompt_templates().get("analytics_rubric", {})
    model = os.environ.get("ANALYTICS_RUBRIC_MODEL", "gpt-5.4")
    key = "score_sections" if kind == "score" else "violation_types"
    task = (
        "Extract ONLY the canonical score section names that are intended to be scored."
        if kind == "score"
        else "Extract ONLY the canonical company procedure / violation type labels used for compliance totals."
    )

    sys = str(templates.get("system_prompt") or "").strip() or (
        "You extract metric label rubrics from prompt templates.\n"
        "Return STRICT JSON only, no markdown, no commentary."
    )
    user_template = str(templates.get("user_prompt_template") or "").strip() or (
        "Kind: {kind}\n"
        "Agent Name: {agent_name}\n"
        "Agent Class: {agent_class}\n\n"
        "SYSTEM PROMPT:\n{system_prompt}\n\n"
        "USER PROMPT:\n{user_prompt}\n\n"
        "TASK: {task}\n\n"
        'Return exactly: {{"{key}": ["label 1", "label 2"]}}\n'
        "Rules:\n"
        "- Keep labels short, canonical, and human-readable.\n"
        "- Normalize equivalent labels into a consistent taxonomy across agents.\n"
        "- Remove duplicates.\n"
        "- Exclude helper/meta keys (for example keys that start with _).\n"
        "{violation_hint}"
    )
    violation_hint = (
        "- For violation taxonomy, prefer these canonical labels when equivalent:\n"
        "  Secret Code Violations\n"
        "  Simple Truth About Your Money Email Violations\n"
        "  Email Verification Missing\n"
        "  Multi-Platform Offer Missing\n"
        "  Multi-Platform Follow-Up Missing\n"
        if kind == "violation"
        else ""
    )
    user = _safe_template_format(
        user_template,
        {
            "kind": kind,
            "agent_name": agent_name,
            "agent_class": agent_class,
            "system_prompt": system_prompt,
            "user_prompt": user_prompt,
            "task": task,
            "key": key,
            "violation_hint": violation_hint,
        },
    )

    raw, _ = _llm_call_with_files(sys, user, {}, {}, model, 0.0, db)
    parsed = _extract_json_obj_from_text(raw)
    vals = parsed.get(key, [])
    if not isinstance(vals, list):
        raise RuntimeError(f"invalid rubric payload key '{key}'")
    labels = _unique_metric_list([str(v or "") for v in vals], kind=kind)
    return labels, model


def _load_cached_prompt_rubric(agent_id: str, kind: str, prompt_hash: str) -> Optional[tuple[list[str], str]]:
    try:
        path = _RUBRIC_DIR / f"{kind}_{agent_id}.json"
        data = json.loads(path.read_text(encoding="utf-8"))
        if data.get("prompt_hash") != prompt_hash:
            return None
        labels = data.get("labels")
        if not isinstance(labels, list):
            return None
        return _unique_metric_list([str(x or "") for x in labels], kind=kind), str(data.get("model") or "")
    except Exception:
        return None


def _save_cached_prompt_rubric(
    agent_id: str,
    kind: str,
    prompt_hash: str,
    labels: list[str],
    method: str,
    model: str,
) -> None:
    try:
        _RUBRIC_DIR.mkdir(parents=True, exist_ok=True)
        path = _RUBRIC_DIR / f"{kind}_{agent_id}.json"
        payload = {
            "agent_id": agent_id,
            "kind": kind,
            "prompt_hash": prompt_hash,
            "labels": _unique_metric_list(labels, kind=kind),
            "method": method,
            "model": model,
            "updated_at": datetime.utcnow().isoformat(),
        }
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:
        pass


def _derive_agent_prompt_rubric(
    agent_def: dict,
    kind: str,
    db: Session,
) -> tuple[list[str], str, str]:
    """Return (labels, method, model). method: cache|llm|heuristic|none"""
    agent_id = str(agent_def.get("id") or "")
    agent_name = str(agent_def.get("name") or "")
    agent_class = str(agent_def.get("agent_class") or "")
    system_prompt = str(agent_def.get("system_prompt") or "")
    user_prompt = str(agent_def.get("user_prompt") or "")

    if not (system_prompt or user_prompt):
        return [], "none", ""

    prompt_hash = _hash_text(
        json.dumps(
            {
                "name": agent_name,
                "class": agent_class,
                "system_prompt": system_prompt,
                "user_prompt": user_prompt,
            },
            sort_keys=True,
            ensure_ascii=False,
        )
    )

    cached = _load_cached_prompt_rubric(agent_id, kind, prompt_hash)
    if cached is not None:
        return cached[0], "cache", cached[1]

    heuristic = (
        _heuristic_extract_score_sections_from_prompt(system_prompt, user_prompt)
        if kind == "score"
        else _heuristic_extract_violation_types_from_prompt(system_prompt, user_prompt)
    )
    labels = heuristic
    method = "heuristic" if heuristic else "none"
    model = ""

    try:
        llm_labels, llm_model = _infer_prompt_rubric_with_llm(
            kind=kind,
            agent_name=agent_name,
            agent_class=agent_class,
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            db=db,
        )
        if llm_labels:
            labels = llm_labels
            method = "llm"
            model = llm_model
    except Exception:
        pass

    labels = _unique_metric_list(labels, kind=kind)

    _save_cached_prompt_rubric(
        agent_id=agent_id,
        kind=kind,
        prompt_hash=prompt_hash,
        labels=labels,
        method=method,
        model=model,
    )
    return labels, method, model


def _artifact_template_key(agent_id: str, artifact_sub_type: str) -> str:
    aid = str(agent_id or "").strip()
    sub = str(artifact_sub_type or "").strip().lower() or "output"
    safe_sub = _re.sub(r"[^a-z0-9_\-]+", "_", sub)
    return f"{aid}_{safe_sub}.json"


def _load_cached_artifact_template(
    agent_id: str,
    artifact_sub_type: str,
    prompt_hash: str,
) -> Optional[dict[str, Any]]:
    try:
        path = _ARTIFACT_SCHEMA_DIR / _artifact_template_key(agent_id, artifact_sub_type)
        data = json.loads(path.read_text(encoding="utf-8"))
        if str(data.get("prompt_hash") or "") != str(prompt_hash or ""):
            return None
        payload = data.get("payload")
        if not isinstance(payload, dict):
            return None
        return {
            **payload,
            "method": str(data.get("method") or payload.get("method") or "cache"),
            "model": str(data.get("model") or payload.get("model") or ""),
            "updated_at": str(data.get("updated_at") or payload.get("updated_at") or ""),
        }
    except Exception:
        return None


def _save_cached_artifact_template(
    agent_id: str,
    artifact_sub_type: str,
    prompt_hash: str,
    payload: dict[str, Any],
    method: str,
    model: str,
) -> None:
    try:
        _ARTIFACT_SCHEMA_DIR.mkdir(parents=True, exist_ok=True)
        path = _ARTIFACT_SCHEMA_DIR / _artifact_template_key(agent_id, artifact_sub_type)
        path.write_text(
            json.dumps(
                {
                    "agent_id": str(agent_id or ""),
                    "artifact_sub_type": str(artifact_sub_type or ""),
                    "prompt_hash": str(prompt_hash or ""),
                    "method": str(method or ""),
                    "model": str(model or ""),
                    "updated_at": datetime.utcnow().isoformat(),
                    "payload": payload,
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
    except Exception:
        pass


def _infer_artifact_template_with_llm(
    *,
    agent_name: str,
    agent_class: str,
    artifact_sub_type: str,
    system_prompt: str,
    user_prompt: str,
    db: Session,
) -> tuple[dict[str, Any], str]:
    from ui.backend.routers.universal_agents import _llm_call_with_files

    templates = _load_internal_prompt_templates().get("artifact_template", {})
    model = os.environ.get("ARTIFACT_TEMPLATE_MODEL", "gpt-5.4")
    sys = str(templates.get("system_prompt") or "").strip() or (
        "You infer expected artifact output schema from agent prompts.\n"
        "Return STRICT JSON only with keys:\n"
        "schema_template (string markdown), taxonomy (string[]), fields (object[]).\n"
        "Each field object: name (string), type (string), required (boolean), description (string).\n"
        "No markdown fences. No commentary."
    )
    user_template = str(templates.get("user_prompt_template") or "").strip() or (
        "Agent Name: {agent_name}\n"
        "Agent Class: {agent_class}\n"
        "Artifact Sub Type: {artifact_sub_type}\n\n"
        "SYSTEM PROMPT:\n{system_prompt}\n\n"
        "USER PROMPT:\n{user_prompt}\n\n"
        "Task:\n"
        "1) Derive a concise expected output template from these prompts.\n"
        "2) Extract taxonomy labels/sections the output should contain.\n"
        "3) Infer structured fields where possible.\n"
        "4) Keep taxonomy canonical and deduplicated.\n"
        "5) If uncertain, provide best-effort placeholders."
    )
    user = _safe_template_format(
        user_template,
        {
            "agent_name": agent_name,
            "agent_class": agent_class,
            "artifact_sub_type": artifact_sub_type,
            "system_prompt": system_prompt,
            "user_prompt": user_prompt,
        },
    )
    raw, _ = _llm_call_with_files(sys, user, {}, {}, model, 0.0, db)
    parsed = _extract_json_obj_from_text(raw)
    if not isinstance(parsed, dict):
        raise RuntimeError("artifact template parse failed")
    schema_template = str(parsed.get("schema_template") or "").strip()
    if not schema_template:
        raise RuntimeError("artifact template missing schema_template")
    raw_tax = parsed.get("taxonomy")
    taxonomy = [str(x or "").strip() for x in raw_tax] if isinstance(raw_tax, list) else []
    taxonomy = [x for x in taxonomy if x]
    raw_fields = parsed.get("fields")
    fields: list[dict[str, Any]] = []
    if isinstance(raw_fields, list):
        for item in raw_fields:
            if not isinstance(item, dict):
                continue
            name = str(item.get("name") or "").strip()
            if not name:
                continue
            fields.append({
                "name": name,
                "type": str(item.get("type") or "string").strip() or "string",
                "required": bool(item.get("required", False)),
                "description": str(item.get("description") or "").strip(),
            })
    return {
        "schema_template": schema_template,
        "taxonomy": taxonomy,
        "fields": fields,
    }, model


def _heuristic_artifact_template(
    *,
    artifact_sub_type: str,
    system_prompt: str,
    user_prompt: str,
) -> dict[str, Any]:
    txt = f"{system_prompt or ''}\n\n{user_prompt or ''}"
    headers = [
        _normalise_metric_name(h)
        for h in _re.findall(r"(?im)^\s*##\s+(.+?)\s*$", txt)
    ]
    headers = [h for h in headers if h]

    taxonomy: list[str]
    sub = str(artifact_sub_type or "").strip().lower()
    if sub == "persona_score":
        taxonomy = _heuristic_extract_score_sections_from_prompt(system_prompt, user_prompt)
    elif sub == "notes_compliance":
        taxonomy = _heuristic_extract_violation_types_from_prompt(system_prompt, user_prompt)
    else:
        taxonomy = _unique_metric_list(headers, kind="")

    placeholders = [
        _normalise_metric_name(p)
        for p in _re.findall(r"\{([a-zA-Z0-9_]+)\}", txt)
    ]
    placeholders = [p for p in placeholders if p]

    fields = [
        {
            "name": p,
            "type": "string",
            "required": True,
            "description": f"Prompt placeholder: {p}",
        }
        for p in placeholders
    ]

    if taxonomy:
        lines = ["# Expected Artifact Output", ""]
        for label in taxonomy:
            lines.append(f"## {label}")
            lines.append("- <required content>")
            lines.append("")
        schema_template = "\n".join(lines).strip()
    else:
        schema_template = (
            "# Expected Artifact Output\n\n"
            "## Summary\n"
            "- <required content>\n\n"
            "## Details\n"
            "- <required content>"
        )

    return {
        "schema_template": schema_template,
        "taxonomy": taxonomy,
        "fields": fields,
    }


def _is_score_agent_def(agent_def: dict, sub_type: str) -> bool:
    st = str(sub_type or "").strip().lower()
    if st == "persona_score":
        return True
    cls = str(agent_def.get("agent_class") or "").lower()
    name = str(agent_def.get("name") or "").lower()
    tags = [str(t or "").lower() for t in (agent_def.get("tags") or [])]
    return (
        "scorer" in cls
        or "score" in cls
        or "scorer" in name
        or any(("scorer" in t or "score" in t) for t in tags)
    )


def _is_violation_agent_def(agent_def: dict, sub_type: str) -> bool:
    st = str(sub_type or "").strip().lower()
    if st == "notes_compliance":
        return True
    cls = str(agent_def.get("agent_class") or "").lower()
    name = str(agent_def.get("name") or "").lower()
    tags = [str(t or "").lower() for t in (agent_def.get("tags") or [])]
    return (
        "compliance" in cls
        or "notes" in cls
        or "compliance" in name
        or "notes" in name
        or any(("compliance" in t or "notes" in t or "violation" in t) for t in tags)
    )


def _collect_pipeline_rubric_catalog(
    pipeline_def: dict,
    agent_map: dict[str, dict],
    db: Session,
) -> dict[str, Any]:
    canvas_json = json.dumps(pipeline_def.get("canvas", {}), ensure_ascii=False)
    subtype_by_agent = _extract_agent_output_subtypes(canvas_json)

    score_sections: list[str] = []
    violation_types: list[str] = []
    score_sources: list[dict] = []
    violation_sources: list[dict] = []
    seen_score_agent: set[str] = set()
    seen_violation_agent: set[str] = set()

    for step in (pipeline_def.get("steps") or []):
        if not isinstance(step, dict):
            continue
        aid = str(step.get("agent_id") or "")
        if not aid:
            continue
        agent_def = agent_map.get(aid, {})
        sub_type = subtype_by_agent.get(aid, "")

        if _is_score_agent_def(agent_def, sub_type) and aid not in seen_score_agent:
            seen_score_agent.add(aid)
            labels, method, model = _derive_agent_prompt_rubric(agent_def, "score", db)
            score_sections.extend(labels)
            score_sources.append({
                "agent_id": aid,
                "agent_name": str(agent_def.get("name") or aid),
                "method": method,
                "model": model,
            })

        if _is_violation_agent_def(agent_def, sub_type) and aid not in seen_violation_agent:
            seen_violation_agent.add(aid)
            labels, method, model = _derive_agent_prompt_rubric(agent_def, "violation", db)
            violation_types.extend(labels)
            violation_sources.append({
                "agent_id": aid,
                "agent_name": str(agent_def.get("name") or aid),
                "method": method,
                "model": model,
            })

    return {
        "score_sections": _unique_metric_list(score_sections, kind="score"),
        "violation_types": _unique_metric_list(violation_types, kind="violation"),
        "score_sources": score_sources,
        "violation_sources": violation_sources,
    }


def _score_averages_from_values(score_values: dict[str, list[float]]) -> list[dict]:
    out = [
        {
            "section": section,
            "average": round(sum(vals) / len(vals), 2),
            "count": len(vals),
        }
        for section, vals in score_values.items()
        if vals
    ]
    out.sort(key=lambda x: str(x["section"]).lower())
    return out


def _violation_totals_to_rows(violation_totals: dict[str, int]) -> list[dict]:
    out = [{"type": k, "total": int(v or 0)} for k, v in violation_totals.items()]
    out.sort(key=lambda x: (-x["total"], str(x["type"]).lower()))
    return out


def _collect_metrics_for_runs(
    runs: list[Any],
    agent_map: dict[str, dict],
    score_catalog: list[str],
    violation_catalog: list[str],
) -> tuple[list[dict], dict[str, list[float]], dict[str, int], list[dict]]:
    parsed_rows: list[dict] = []
    score_values: dict[str, list[float]] = {}
    violation_totals: dict[str, int] = {}
    run_summaries: list[dict] = []

    score_lookup = _build_catalog_lookup(score_catalog, kind="score")
    violation_lookup = _build_catalog_lookup(violation_catalog, kind="violation")

    for run in runs:
        try:
            steps = json.loads(getattr(run, "steps_json", "") or "[]")
            if not isinstance(steps, list):
                steps = []
        except Exception:
            steps = []

        subtype_by_agent = _extract_agent_output_subtypes(getattr(run, "canvas_json", "") or "")
        run_started_at = run.started_at.isoformat() if getattr(run, "started_at", None) else ""
        run_finished_at = run.finished_at.isoformat() if getattr(run, "finished_at", None) else None

        per_run_scores: dict[str, list[float]] = {}
        per_run_violations: dict[str, int] = {}

        for idx, raw_step in enumerate(steps):
            step = raw_step if isinstance(raw_step, dict) else {}
            content = str(step.get("content") or "")
            if not content:
                continue

            agent_id = str(step.get("agent_id") or "")
            agent_def = agent_map.get(agent_id, {})
            agent_name = str(step.get("agent_name") or "") or str(agent_def.get("name") or "") or agent_id or f"Step {idx + 1}"
            model = str(step.get("model") or "")
            sub_type = str(subtype_by_agent.get(agent_id, "") or "").strip().lower()
            unknown_type = sub_type in {"", "unknown"}

            step_state = str(step.get("state") or step.get("status") or "").strip().lower()
            step_done = step_state in {"done", "completed", "pass", "success", "ok"}

            score_like = _is_score_agent_def(agent_def, sub_type)
            violation_like = _is_violation_agent_def(agent_def, sub_type)

            parse_scores = score_like or (unknown_type and not violation_like)
            parse_violations = violation_like or (unknown_type and not score_like)

            scores: dict[str, float] = {}
            if parse_scores:
                scores = _parse_scores_from_text(content)
                if not scores and unknown_type and "score" in content.lower() and "/100" in content:
                    scores = _parse_scores_from_text(content)

            for sec, val in scores.items():
                canonical_sec = _canonical_metric_name(sec, score_lookup, kind="score")
                score_values.setdefault(canonical_sec, []).append(float(val))
                per_run_scores.setdefault(canonical_sec, []).append(float(val))
                parsed_rows.append({
                    "metric_type": "score",
                    "metric_key": canonical_sec,
                    "metric_value": float(val),
                    "run_id": run.id,
                    "run_started_at": run_started_at,
                    "run_finished_at": run_finished_at,
                    "run_status": run.status,
                    "step_index": idx,
                    "step_done": step_done,
                    "step_state": step_state,
                    "step_agent_id": agent_id,
                    "step_agent_name": agent_name,
                    "step_model": model,
                    "step_sub_type": sub_type or "unknown",
                })

            violations: dict[str, int] = {}
            if parse_violations:
                violations = _parse_violations_from_text(content)
                if not violations and (
                    "[violation]" in content.lower()
                    or "total violations by procedure" in content.lower()
                ):
                    violations = _parse_violations_from_text(content)

            for proc, cnt in violations.items():
                if _is_summary_violation_metric(proc):
                    continue
                n = int(cnt or 0)
                canonical_proc = _canonical_metric_name(proc, violation_lookup, kind="violation")
                violation_totals[canonical_proc] = violation_totals.get(canonical_proc, 0) + n
                per_run_violations[canonical_proc] = per_run_violations.get(canonical_proc, 0) + n
                parsed_rows.append({
                    "metric_type": "violation",
                    "metric_key": canonical_proc,
                    "metric_value": n,
                    "run_id": run.id,
                    "run_started_at": run_started_at,
                    "run_finished_at": run_finished_at,
                    "run_status": run.status,
                    "step_index": idx,
                    "step_done": step_done,
                    "step_state": step_state,
                    "step_agent_id": agent_id,
                    "step_agent_name": agent_name,
                    "step_model": model,
                    "step_sub_type": sub_type or "unknown",
                })

        run_flat_scores = [v for vals in per_run_scores.values() for v in vals]
        run_summaries.append({
            "run_id": str(run.id or ""),
            "pipeline_id": str(getattr(run, "pipeline_id", "") or ""),
            "pipeline_name": str(getattr(run, "pipeline_name", "") or ""),
            "sales_agent": str(getattr(run, "sales_agent", "") or ""),
            "customer": str(getattr(run, "customer", "") or ""),
            "started_at": run_started_at,
            "finished_at": run_finished_at,
            "status": str(getattr(run, "status", "") or ""),
            "run_avg_score": (
                round(sum(run_flat_scores) / len(run_flat_scores), 2)
                if run_flat_scores else None
            ),
            "run_total_violations": int(sum(per_run_violations.values())),
            "score_by_section": {
                k: round(sum(vs) / len(vs), 2)
                for k, vs in per_run_scores.items()
                if vs
            },
            "violations_by_type": per_run_violations,
        })

    return parsed_rows, score_values, violation_totals, run_summaries


def _run_dedupe_source_key(run: Any) -> str:
    call_id = str(getattr(run, "call_id", "") or "").strip()
    low_call_id = call_id.lower()
    if call_id and low_call_id not in {"pair", "merged", "all", "none", "null"}:
        source = f"call:{low_call_id}"
    else:
        source = ""
        try:
            steps = json.loads(getattr(run, "steps_json", "") or "[]")
            if not isinstance(steps, list):
                steps = []
        except Exception:
            steps = []

        for step in steps:
            if not isinstance(step, dict):
                continue
            fp = str(step.get("input_fingerprint") or "").strip().lower()
            if fp:
                source = f"fingerprint:{fp}"
                break

        if not source:
            for step in steps:
                if not isinstance(step, dict):
                    continue
                srcs = step.get("input_sources")
                if not isinstance(srcs, list):
                    continue
                parts: list[str] = []
                for src in srcs:
                    if not isinstance(src, dict):
                        continue
                    k = str(src.get("key") or "").strip().lower()
                    v = str(src.get("source") or "").strip().lower()
                    if k or v:
                        parts.append(f"{k}={v}")
                if parts:
                    source = "sources:" + "|".join(sorted(parts))
                    break

    if not source:
        source = f"run:{str(getattr(run, 'id', '') or '').lower()}"

    sa = str(getattr(run, "sales_agent", "") or "").strip().lower()
    cu = str(getattr(run, "customer", "") or "").strip().lower()
    return f"{sa}::{cu}::{source}"


def _dedupe_runs_by_source(runs: list[Any]) -> list[Any]:
    """Keep the newest run per pair+call-source. Input runs are already newest-first."""
    out: list[Any] = []
    seen: set[str] = set()
    for run in runs:
        key = _run_dedupe_source_key(run)
        if key in seen:
            continue
        seen.add(key)
        out.append(run)
    return out


def _load_all() -> list[dict]:
    _DIR.mkdir(parents=True, exist_ok=True)
    out = []
    for f in sorted(_DIR.glob("*.json")):
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            if isinstance(data, dict) and data.get("id"):
                out.append(data)
        except Exception:
            pass
    return out


def _find_file(pipeline_id: str) -> tuple[Any, dict]:
    for f in _DIR.glob("*.json"):
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            if data.get("id") == pipeline_id:
                return f, data
        except Exception:
            pass
    raise HTTPException(404, f"Pipeline '{pipeline_id}' not found")


def _next_unique_name(base_name: str, existing_names: set[str]) -> str:
    base = str(base_name or "").strip() or "Untitled"
    if base.lower() not in existing_names:
        existing_names.add(base.lower())
        return base
    i = 2
    while True:
        candidate = f"{base} ({i})"
        if candidate.lower() not in existing_names:
            existing_names.add(candidate.lower())
            return candidate
        i += 1


def _bundle_folder_name(bundle: dict[str, Any], fallback_pipeline_name: str, target_folder: str = "") -> str:
    explicit = _normalise_folder(target_folder)
    if explicit:
        return explicit
    bundle_name = _normalise_folder(str(bundle.get("bundle_name") or ""))
    source = bundle.get("source") if isinstance(bundle.get("source"), dict) else {}
    source_name = _normalise_folder(str(source.get("pipeline_name") or ""))
    base = bundle_name or source_name or _normalise_folder(fallback_pipeline_name) or "Imported Bundle"
    return _normalise_folder(f"Imported Bundles / {base}")


def _collect_bundle_agents(step_agent_ids: list[str]) -> tuple[list[dict[str, Any]], list[str]]:
    from ui.backend.routers import universal_agents as _ua

    queue: list[str] = [str(x or "").strip() for x in step_agent_ids if str(x or "").strip()]
    seen: set[str] = set()
    agents: list[dict[str, Any]] = []
    missing: set[str] = set()
    while queue:
        aid = queue.pop(0)
        if not aid or aid in seen:
            continue
        seen.add(aid)
        try:
            _, data = _ua._find_file(aid)
        except Exception:
            missing.add(aid)
            continue
        if not isinstance(data, dict):
            missing.add(aid)
            continue
        agent = _ua._normalize_agent_record(data)
        agents.append(agent)
        for inp in (agent.get("inputs") or []):
            if not isinstance(inp, dict):
                continue
            src = str(inp.get("source") or "").strip().lower()
            dep = str(inp.get("agent_id") or "").strip()
            if src == "agent_output" and dep and dep not in seen:
                queue.append(dep)
    return agents, sorted(missing)


def _persist_bundle_snapshot(name_prefix: str, payload: dict[str, Any]) -> str:
    _BUNDLE_DIR.mkdir(parents=True, exist_ok=True)
    safe_prefix = _re.sub(r"[^a-zA-Z0-9._-]+", "_", str(name_prefix or "bundle")).strip("._-") or "bundle"
    stamp = datetime.utcnow().strftime("%Y%m%dT%H%M%S")
    file_name = f"{stamp}_{safe_prefix}_{uuid.uuid4().hex[:8]}.json"
    (_BUNDLE_DIR / file_name).write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return file_name


def _get_table_columns(db_or_bind: Any, table_name: str) -> set[str]:
    try:
        bind = db_or_bind.get_bind() if hasattr(db_or_bind, "get_bind") else db_or_bind
        return {c["name"] for c in _sa_inspect(bind).get_columns(table_name)}
    except Exception:
        return set()


def _agent_result_supports_pipeline_cache(db_or_bind: Any) -> bool:
    cols = _get_table_columns(db_or_bind, "agent_result")
    return {"pipeline_id", "pipeline_step_index", "input_fingerprint"}.issubset(cols)


def _normalise_folder(name: str) -> str:
    return " ".join(str(name or "").strip().split())


def _load_folders() -> list[str]:
    try:
        raw = json.loads(_FOLDERS_FILE.read_text(encoding="utf-8"))
        if isinstance(raw, list):
            out = []
            for x in raw:
                n = _normalise_folder(str(x or ""))
                if n:
                    out.append(n)
            return out
    except Exception:
        pass
    return []


def _save_folders(folders: list[str]) -> None:
    cleaned = []
    seen = set()
    for f in folders:
        n = _normalise_folder(f)
        if not n:
            continue
        k = n.lower()
        if k in seen:
            continue
        seen.add(k)
        cleaned.append(n)
    cleaned.sort(key=lambda x: x.lower())
    _FOLDERS_FILE.write_text(json.dumps(cleaned, ensure_ascii=False, indent=2), encoding="utf-8")


def _ensure_folder_exists(folder: str) -> None:
    n = _normalise_folder(folder)
    if not n:
        return
    folders = _load_folders()
    if n.lower() in {f.lower() for f in folders}:
        return
    folders.append(n)
    _save_folders(folders)


# ── Routes ────────────────────────────────────────────────────────────────────

@router.get("")
def list_pipelines(request: Request):
    profile = _require_can_view(request)
    _load_internal_prompt_templates()
    _sync_ai_registry_pipelines()
    rows = _load_all()
    return [r for r in rows if _can_access_pipeline_record(profile, r)]


@router.get("/folders")
def list_pipeline_folders(request: Request):
    profile = _require_can_view(request)
    visible = [p for p in _load_all() if _can_access_pipeline_record(profile, p)]
    from_pipelines = [
        _normalise_folder(str(p.get("folder", "") or ""))
        for p in visible
    ]
    global_folders = _load_folders()
    merged = [*from_pipelines, *global_folders]
    deduped = []
    seen = set()
    for folder in merged:
        if not folder:
            continue
        key = folder.lower()
        if key in seen:
            continue
        seen.add(key)
        deduped.append(folder)
    deduped.sort(key=lambda x: x.lower())
    return deduped


@router.post("/folders")
def create_pipeline_folder(req: FolderIn, request: Request):
    _require_can_create_pipeline(request)
    name = _normalise_folder(req.name)
    if not name:
        raise HTTPException(400, "Folder name is required")
    _ensure_folder_exists(name)
    return {"ok": True, "folder": name}


@router.delete("/folders")
def delete_pipeline_folder(req: FolderDeleteIn, request: Request):
    profile = _require_can_edit_pipeline(request)
    target = _normalise_folder(req.name)
    if not target:
        raise HTTPException(400, "Folder name is required")

    # Default/Unfiled is represented as empty folder and cannot be deleted.
    if target.lower() in {"unfiled", "default"}:
        raise HTTPException(400, "Default folder cannot be deleted")

    moved = 0
    for file in _DIR.glob("*.json"):
        data = json.loads(file.read_text(encoding="utf-8"))
        if not _can_access_pipeline_record(profile, data):
            continue
        _assert_can_modify_pipeline_record(request, profile, data)
        cur = _normalise_folder(str(data.get("folder", "") or ""))
        if cur.lower() != target.lower():
            continue
        data["folder"] = ""
        data["updated_at"] = datetime.utcnow().isoformat()
        file.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
        moved += 1

    folders = _load_folders()
    folders = [f for f in folders if _normalise_folder(f).lower() != target.lower()]
    _save_folders(folders)
    _sync_ai_registry_pipelines()
    return {"ok": True, "deleted_folder": target, "moved_to_default": moved}


@router.post("")
def create_pipeline(req: PipelineIn, request: Request):
    profile = _require_can_create_pipeline(request)
    _validate_pipeline_payload(req)
    _DIR.mkdir(parents=True, exist_ok=True)
    now = datetime.utcnow().isoformat()
    record = {"id": str(uuid.uuid4()), "created_at": now, "updated_at": now, **req.model_dump()}
    owner_email = _workspace_owner_for_new_pipeline(request, profile)
    if owner_email:
        record["workspace_user_email"] = owner_email
        record["workspace_user_name"] = str(profile.get("name") or "").strip()
    record["folder"] = _normalise_folder(record.get("folder", ""))
    if record["folder"]:
        _ensure_folder_exists(record["folder"])
    (_DIR / f"{record['id']}.json").write_text(
        json.dumps(record, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    _sync_ai_registry_pipelines()
    return record


@router.get("/artifact-template")
def get_artifact_template(
    agent_id: str = Query(...),
    artifact_sub_type: str = Query(...),
    db: Session = Depends(get_session),
):
    aid = str(agent_id or "").strip()
    sub_type = str(artifact_sub_type or "").strip().lower()
    if not aid:
        raise HTTPException(400, "agent_id is required")
    if not sub_type:
        raise HTTPException(400, "artifact_sub_type is required")

    from ui.backend.routers import universal_agents as _ua

    agent_def = next((a for a in _ua._load_all() if str(a.get("id") or "") == aid), None)
    if not agent_def:
        raise HTTPException(404, f"Agent '{aid}' not found")

    system_prompt = str(agent_def.get("system_prompt") or "")
    user_prompt = str(agent_def.get("user_prompt") or "")
    prompt_hash = _hash_text(
        json.dumps(
            {
                "agent_id": aid,
                "artifact_sub_type": sub_type,
                "system_prompt": system_prompt,
                "user_prompt": user_prompt,
            },
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
    )

    cached = _load_cached_artifact_template(aid, sub_type, prompt_hash)
    if cached:
        return cached

    payload = _heuristic_artifact_template(
        artifact_sub_type=sub_type,
        system_prompt=system_prompt,
        user_prompt=user_prompt,
    )
    method = "heuristic"
    model = ""
    try:
        llm_payload, llm_model = _infer_artifact_template_with_llm(
            agent_name=str(agent_def.get("name") or aid),
            agent_class=str(agent_def.get("agent_class") or ""),
            artifact_sub_type=sub_type,
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            db=db,
        )
        if isinstance(llm_payload, dict) and str(llm_payload.get("schema_template") or "").strip():
            payload = llm_payload
            method = "llm"
            model = llm_model
    except Exception:
        pass

    tax_kind = ""
    if sub_type == "persona_score":
        tax_kind = "score"
    elif sub_type == "notes_compliance":
        tax_kind = "violation"

    raw_taxonomy = payload.get("taxonomy")
    payload["taxonomy"] = _unique_metric_list(
        [str(x or "").strip() for x in raw_taxonomy] if isinstance(raw_taxonomy, list) else [],
        kind=tax_kind,
    )

    raw_fields = payload.get("fields")
    clean_fields: list[dict[str, Any]] = []
    if isinstance(raw_fields, list):
        for f in raw_fields:
            if not isinstance(f, dict):
                continue
            name = str(f.get("name") or "").strip()
            if not name:
                continue
            clean_fields.append({
                "name": name,
                "type": str(f.get("type") or "string").strip() or "string",
                "required": bool(f.get("required", False)),
                "description": str(f.get("description") or "").strip(),
            })
    payload["fields"] = clean_fields

    schema_template = str(payload.get("schema_template") or "").strip()
    if not schema_template:
        schema_template = "# Expected Artifact Output\n\n## Summary\n- <required content>"

    response_payload = {
        "agent_id": aid,
        "agent_name": str(agent_def.get("name") or aid),
        "artifact_sub_type": sub_type,
        "schema_template": schema_template,
        "taxonomy": payload.get("taxonomy") or [],
        "fields": payload.get("fields") or [],
    }

    _save_cached_artifact_template(
        agent_id=aid,
        artifact_sub_type=sub_type,
        prompt_hash=prompt_hash,
        payload=response_payload,
        method=method,
        model=model,
    )

    reloaded = _load_cached_artifact_template(aid, sub_type, prompt_hash)
    if reloaded:
        return reloaded

    return {
        **response_payload,
        "method": method,
        "model": model,
        "updated_at": datetime.utcnow().isoformat(),
    }


@router.get("/{pipeline_id}/bundle")
def export_pipeline_bundle(pipeline_id: str, request: Request):
    profile = _require_can_view(request)
    _, pipeline_def = _find_file(pipeline_id)
    if not _can_access_pipeline_record(profile, pipeline_def):
        raise HTTPException(status_code=404, detail="Pipeline not found.")
    step_agent_ids = [
        str((s or {}).get("agent_id") or "").strip()
        for s in (pipeline_def.get("steps") or [])
        if isinstance(s, dict)
    ]
    step_agent_ids = [x for x in step_agent_ids if x]
    agents, missing_agent_ids = _collect_bundle_agents(step_agent_ids)
    bundle_payload = {
        "bundle_version": 1,
        "bundle_id": str(uuid.uuid4()),
        "bundle_name": str(pipeline_def.get("name") or "Pipeline Bundle"),
        "created_at": datetime.utcnow().isoformat(),
        "source": {
            "pipeline_id": str(pipeline_def.get("id") or pipeline_id),
            "pipeline_name": str(pipeline_def.get("name") or ""),
        },
        "pipeline": pipeline_def,
        "agents": agents,
        "warnings": {
            "missing_agent_ids": missing_agent_ids,
        },
    }
    snapshot_name = _persist_bundle_snapshot(
        name_prefix=f"export_{pipeline_def.get('name') or pipeline_id}",
        payload=bundle_payload,
    )
    return {
        **bundle_payload,
        "snapshot_file": snapshot_name,
    }


@router.post("/bundles/import")
def import_pipeline_bundle(req: PipelineBundleImportIn, request: Request):
    profile = _require_can_create_pipeline(request)
    payload = req.bundle if isinstance(req.bundle, dict) else {}
    pipeline_raw = payload.get("pipeline")
    agents_raw = payload.get("agents")
    if not isinstance(pipeline_raw, dict):
        raise HTTPException(400, "Invalid bundle: missing 'pipeline' object")
    if not isinstance(agents_raw, list):
        raise HTTPException(400, "Invalid bundle: missing 'agents' array")

    now = datetime.utcnow().isoformat()
    pipeline_in = dict(pipeline_raw)
    pipeline_name = str(pipeline_in.get("name") or "Imported Pipeline").strip() or "Imported Pipeline"
    folder_name = _bundle_folder_name(payload, pipeline_name, req.target_folder)

    existing_pipeline_names = {
        str((p or {}).get("name") or "").strip().lower()
        for p in _load_all()
        if isinstance(p, dict)
    }
    unique_pipeline_name = _next_unique_name(pipeline_name, existing_pipeline_names)

    # Build id remap from bundled agents.
    agent_id_map: dict[str, str] = {}
    bundled_agents: list[dict[str, Any]] = []
    for item in agents_raw:
        if not isinstance(item, dict):
            continue
        old_id = str(item.get("id") or "").strip()
        if not old_id or old_id in agent_id_map:
            continue
        agent_id_map[old_id] = str(uuid.uuid4())
        bundled_agents.append(item)

    step_agent_ids = [
        str((s or {}).get("agent_id") or "").strip()
        for s in (pipeline_in.get("steps") or [])
        if isinstance(s, dict)
    ]
    missing_in_bundle = sorted({aid for aid in step_agent_ids if aid and aid not in agent_id_map})
    if missing_in_bundle:
        raise HTTPException(
            400,
            "Invalid bundle: missing agent definitions for pipeline step ids: "
            + ", ".join(missing_in_bundle),
        )

    from ui.backend.routers import universal_agents as _ua

    _UNIVERSAL_AGENTS_DIR.mkdir(parents=True, exist_ok=True)
    if folder_name:
        try:
            _ua._ensure_folder_exists(folder_name)
        except Exception:
            pass

    existing_agent_names = {
        str((a or {}).get("name") or "").strip().lower()
        for a in _ua._load_all()
        if isinstance(a, dict)
    }
    imported_agents: list[dict[str, Any]] = []
    for raw_agent in bundled_agents:
        old_id = str(raw_agent.get("id") or "").strip()
        if not old_id:
            continue
        new_id = agent_id_map[old_id]
        agent = _ua._normalize_agent_record(dict(raw_agent))
        agent["id"] = new_id
        agent["created_at"] = now
        agent["updated_at"] = now
        agent["is_default"] = False
        agent["folder"] = folder_name
        agent["name"] = _next_unique_name(str(agent.get("name") or "Imported Agent"), existing_agent_names)
        next_inputs: list[dict[str, Any]] = []
        for inp in (agent.get("inputs") or []):
            if not isinstance(inp, dict):
                continue
            c = dict(inp)
            src = str(c.get("source") or "").strip().lower()
            dep = str(c.get("agent_id") or "").strip()
            if src == "agent_output" and dep and dep in agent_id_map:
                c["agent_id"] = agent_id_map[dep]
            next_inputs.append(_ua._normalize_input_def(c))
        agent["inputs"] = next_inputs
        (_UNIVERSAL_AGENTS_DIR / f"{new_id}.json").write_text(
            json.dumps(agent, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        imported_agents.append(agent)

    pipeline_out = dict(pipeline_in)
    pipeline_out["id"] = str(uuid.uuid4())
    pipeline_out["created_at"] = now
    pipeline_out["updated_at"] = now
    pipeline_out["name"] = unique_pipeline_name
    pipeline_out["folder"] = folder_name
    owner_email = _workspace_owner_for_new_pipeline(request, profile)
    if owner_email:
        pipeline_out["workspace_user_email"] = owner_email
        pipeline_out["workspace_user_name"] = str(profile.get("name") or "").strip()

    # Remap pipeline step agent ids.
    remapped_steps: list[dict[str, Any]] = []
    for step in (pipeline_in.get("steps") or []):
        if not isinstance(step, dict):
            continue
        s = dict(step)
        aid = str(s.get("agent_id") or "").strip()
        if aid in agent_id_map:
            s["agent_id"] = agent_id_map[aid]
        remapped_steps.append(s)
    pipeline_out["steps"] = remapped_steps

    # Remap processing node agent ids in saved canvas.
    canvas = pipeline_in.get("canvas")
    if isinstance(canvas, dict):
        canvas_copy = dict(canvas)
        nodes = canvas_copy.get("nodes")
        if isinstance(nodes, list):
            next_nodes = []
            for n in nodes:
                if not isinstance(n, dict):
                    next_nodes.append(n)
                    continue
                c = dict(n)
                data = c.get("data")
                if isinstance(data, dict):
                    d = dict(data)
                    aid = str(d.get("agentId") or "").strip()
                    if aid in agent_id_map:
                        d["agentId"] = agent_id_map[aid]
                    c["data"] = d
                next_nodes.append(c)
            canvas_copy["nodes"] = next_nodes
        pipeline_out["canvas"] = canvas_copy

    _DIR.mkdir(parents=True, exist_ok=True)
    if folder_name:
        _ensure_folder_exists(folder_name)
    (_DIR / f"{pipeline_out['id']}.json").write_text(
        json.dumps(pipeline_out, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    import_snapshot = {
        "bundle_version": 1,
        "imported_at": now,
        "source_bundle": payload,
        "result": {
            "pipeline_id": pipeline_out["id"],
            "pipeline_name": pipeline_out["name"],
            "folder": folder_name,
            "agent_count": len(imported_agents),
            "agent_id_map": agent_id_map,
        },
    }
    snapshot_name = _persist_bundle_snapshot(
        name_prefix=f"import_{pipeline_out['name']}",
        payload=import_snapshot,
    )

    _sync_ai_registry_pipelines()
    try:
        _ua._sync_ai_registry_agents()
    except Exception:
        pass

    return {
        "ok": True,
        "folder": folder_name,
        "pipeline": pipeline_out,
        "agents_created": len(imported_agents),
        "snapshot_file": snapshot_name,
    }


@router.get("/{pipeline_id}")
def get_pipeline(pipeline_id: str, request: Request):
    profile = _require_can_view(request)
    _, data = _find_file(pipeline_id)
    if not _can_access_pipeline_record(profile, data):
        raise HTTPException(status_code=404, detail="Pipeline not found.")
    return data


@router.put("/{pipeline_id}")
def update_pipeline(pipeline_id: str, req: PipelineIn, request: Request):
    profile = _require_can_edit_pipeline(request)
    _validate_pipeline_payload(req)
    f, data = _find_file(pipeline_id)
    if not _can_access_pipeline_record(profile, data):
        raise HTTPException(status_code=404, detail="Pipeline not found.")
    _assert_can_modify_pipeline_record(request, profile, data)
    data.update({**req.model_dump(), "updated_at": datetime.utcnow().isoformat()})
    data["folder"] = _normalise_folder(data.get("folder", ""))
    if data["folder"]:
        _ensure_folder_exists(data["folder"])
    f.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    _sync_ai_registry_pipelines()
    return data


@router.patch("/{pipeline_id}/folder")
def move_pipeline_to_folder(pipeline_id: str, req: FolderMoveIn, request: Request):
    profile = _require_can_edit_pipeline(request)
    f, data = _find_file(pipeline_id)
    if not _can_access_pipeline_record(profile, data):
        raise HTTPException(status_code=404, detail="Pipeline not found.")
    _assert_can_modify_pipeline_record(request, profile, data)
    folder = _normalise_folder(req.folder)
    data["folder"] = folder
    data["updated_at"] = datetime.utcnow().isoformat()
    f.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    if folder:
        _ensure_folder_exists(folder)
    _sync_ai_registry_pipelines()
    return data


@router.delete("/{pipeline_id}")
def delete_pipeline(pipeline_id: str, request: Request):
    profile = _require_can_edit_pipeline(request)
    f, _ = _find_file(pipeline_id)
    try:
        data = json.loads(f.read_text(encoding="utf-8"))
    except Exception:
        data = {}
    if not _can_access_pipeline_record(profile, data):
        raise HTTPException(status_code=404, detail="Pipeline not found.")
    _assert_can_modify_pipeline_record(request, profile, data)
    f.unlink()
    _sync_ai_registry_pipelines()
    return {"ok": True}


class PipelineRunRequest(BaseModel):
    sales_agent: str = ""
    customer: str = ""
    call_id: str = ""
    context_call_id: str = ""  # optional input-resolution scope call id
    run_id: str = ""  # continue/append within an existing run id when provided
    force: bool = False
    force_step_indices: list[int] = []  # bypass cache for specific steps even when force=False
    resume_partial: bool = False  # allow per-step cache fallback when exact fingerprint miss
    execute_step_indices: list[int] = []  # run only these step indices (0-based); empty = run all
    prepare_input_only: bool = False  # resolve selected step inputs only; do not execute model
    run_origin: str = ""  # local | webhook (used for UI source separation)


class PipelineStopRequest(BaseModel):
    sales_agent: str = ""
    customer: str = ""
    call_id: str = ""


class LiveWebhookConfigIn(BaseModel):
    enabled: bool = True
    ingest_only: bool = True
    trigger_pipeline: bool = True
    agent_continuity_filter_enabled: bool = True
    agent_continuity_pair_tag_fallback_enabled: bool = True
    agent_continuity_reject_multi_agent_pair_tags: bool = True
    live_pipeline_ids: list[str] = []
    default_pipeline_id: str = ""
    pipeline_by_agent: dict[str, str] = {}
    backfill_historical_transcripts: bool = True
    backfill_timeout_s: int = 5400
    max_live_running: int = 5
    agent_continuity_filter_enabled: bool = True
    auto_retry_enabled: bool = True
    retry_max_attempts: int = 2
    retry_delay_s: int = 45
    retry_on_server_error: bool = True
    retry_on_rate_limit: bool = True
    retry_on_timeout: bool = True
    send_note_pipeline_ids: list[str] = []
    run_payload: dict[str, Any] = {}


class LiveWebhookQuickSetIn(BaseModel):
    pipeline_id: str = ""
    enabled: bool = True
    listen_all_webhooks: bool = True
    clear_agent_mappings: bool = True


class LiveWebhookRejectionEnqueueIn(BaseModel):
    pipeline_id: str = ""
    run_all: bool = False


class LiveWebhookRunEnqueueIn(BaseModel):
    pipeline_id: str = ""


class LiveWebhookRunCancelIn(BaseModel):
    reason: str = "Cancelled by user."


class LiveWebhookRunRetryIn(BaseModel):
    pipeline_id: str = ""


@router.get("/{pipeline_id}/results")
def get_pipeline_results(
    pipeline_id: str,
    sales_agent: str = "",
    customer: str = "",
    call_id: Optional[str] = Query(None),
    db: Session = Depends(get_session),
):
    """Return the latest cached AgentResult for each pipeline step."""
    from ui.backend.models.pipeline_run import PipelineRun as PR

    _, pipeline_def = _find_file(pipeline_id)
    steps = pipeline_def.get("steps", [])
    call_id_norm = (call_id or "").strip().lower()
    filter_by_call_id = call_id is not None and call_id_norm != ""
    has_pipeline_cols = _agent_result_supports_pipeline_cache(db)

    def _to_iso(v: Any) -> Optional[str]:
        if v is None:
            return None
        if hasattr(v, "isoformat"):
            return v.isoformat()
        return str(v)

    def _row_to_result(row: Any) -> Optional[dict]:
        if not row:
            return None
        m = getattr(row, "_mapping", row)
        if hasattr(m, "get"):
            _id = m.get("id")
            _content = m.get("content", "")
            _agent_name = m.get("agent_name", "")
            _created = m.get("created_at")
        else:
            _id = row[0] if len(row) > 0 else ""
            _content = row[1] if len(row) > 1 else ""
            _agent_name = row[2] if len(row) > 2 else ""
            _created = row[3] if len(row) > 3 else None
        created_iso = _to_iso(_created)
        return {
            "id": _id,
            "content": _content,
            "agent_name": _agent_name,
            "created_at": created_iso,
        }

    fallback_by_step: dict[int, dict] = {}
    try:
        run_stmt = select(PR).where(
            PR.pipeline_id == pipeline_id,
            _sql_func.lower(PR.sales_agent) == (sales_agent or "").lower(),
            _sql_func.lower(PR.customer) == (customer or "").lower(),
        )
        # For pipeline_run fallback, respect explicit call_id including empty string.
        if call_id is not None:
            if filter_by_call_id:
                run_stmt = run_stmt.where(_sql_func.lower(_sql_func.trim(PR.call_id)) == call_id_norm)
            else:
                run_stmt = run_stmt.where(PR.call_id == "")
        run_stmt = run_stmt.order_by(PR.started_at.desc()).limit(40)
        run_rows = db.exec(run_stmt).all()
        for run_row in run_rows:
            raw_steps = run_row.steps_json
            if not (isinstance(raw_steps, str) and raw_steps.strip()):
                continue
            parsed = json.loads(raw_steps)
            if not isinstance(parsed, list):
                continue
            run_id = str(run_row.id or "")
            created_at = _to_iso(run_row.finished_at) or _to_iso(run_row.started_at)
            for i, raw_step in enumerate(parsed):
                if i in fallback_by_step:
                    continue
                s = raw_step if isinstance(raw_step, dict) else {}
                content = (s.get("content") or "") if isinstance(s, dict) else ""
                if not content:
                    continue
                fallback_by_step[i] = {
                    "id": f"pipeline_run:{run_id}:{i}",
                    "content": content,
                    "agent_name": (s.get("agent_name") or "") if isinstance(s, dict) else "",
                    "created_at": created_at,
                }
    except Exception:
        fallback_by_step = {}

    out = []
    for idx, step in enumerate(steps):
        agent_id = step.get("agent_id", "")
        cached_row = None
        if has_pipeline_cols:
            sql = (
                "SELECT id, content, agent_name, created_at "
                "FROM agent_result "
                "WHERE agent_id = :agent_id "
                "AND LOWER(sales_agent) = LOWER(:sales_agent) "
                "AND LOWER(customer) = LOWER(:customer) "
                "AND pipeline_id = :pipeline_id "
                "AND pipeline_step_index = :step_idx "
            )
            params = {
                "agent_id": agent_id,
                "sales_agent": sales_agent,
                "customer": customer,
                "pipeline_id": pipeline_id,
                "step_idx": idx,
            }
            if filter_by_call_id:
                sql += "AND LOWER(TRIM(call_id)) = :call_id_norm "
                params["call_id_norm"] = call_id_norm
            sql += "ORDER BY created_at DESC LIMIT 1"
            try:
                cached_row = db.execute(_sql_text(sql), params).first()
            except Exception:
                cached_row = None

        if not cached_row:
            sql2 = (
                "SELECT id, content, agent_name, created_at "
                "FROM agent_result "
                "WHERE agent_id = :agent_id "
                "AND LOWER(sales_agent) = LOWER(:sales_agent) "
                "AND LOWER(customer) = LOWER(:customer) "
            )
            params2 = {
                "agent_id": agent_id,
                "sales_agent": sales_agent,
                "customer": customer,
            }
            if filter_by_call_id:
                sql2 += "AND LOWER(TRIM(call_id)) = :call_id_norm "
                params2["call_id_norm"] = call_id_norm
            sql2 += "ORDER BY created_at DESC LIMIT 1"
            try:
                cached_row = db.execute(_sql_text(sql2), params2).first()
            except Exception:
                cached_row = None

        cached = _row_to_result(cached_row)
        if not cached:
            fb = fallback_by_step.get(idx)
            if fb and fb.get("content"):
                cached = {
                    "id": fb.get("id"),
                    "content": fb.get("content"),
                    "agent_name": fb.get("agent_name") or agent_id,
                    "created_at": fb.get("created_at"),
                }
        out.append({
            "agent_id": agent_id,
            "result": cached,
        })
    return out


def _split_text_sections(raw: str) -> list[dict[str, str]]:
    text = str(raw or "")
    if not text.strip():
        return []

    sections: list[dict[str, str]] = []
    current_title = "Full Output"
    buf: list[str] = []
    for line in text.splitlines():
        md_h = _re.match(r"^\s*#{1,6}\s+(.+?)\s*$", line)
        num_h = _re.match(r"^\s*\d+\.\s+(.+?)\s*$", line)
        total_h = _re.match(r"^\s*Total\s+Violations.*:\s*$", line, _re.IGNORECASE)
        if md_h or num_h or total_h:
            body = "\n".join(buf).strip()
            if body:
                sections.append({"title": current_title.strip(), "content": body})
            current_title = (
                (md_h.group(1) if md_h else (num_h.group(1) if num_h else line))
                .strip()
            )
            buf = []
        else:
            buf.append(line)
    body = "\n".join(buf).strip()
    if body:
        sections.append({"title": current_title.strip(), "content": body})

    if not sections:
        return [{"title": "Full Output", "content": text.strip()}]
    return sections


def _split_merged_calls(merged_text: str) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    current_call_id = ""
    buf: list[str] = []
    for line in str(merged_text or "").splitlines():
        m = _re.match(r"^\s*CALL\s+([^\s|]+)", line.strip(), _re.IGNORECASE)
        if m:
            if current_call_id and buf:
                out.append((current_call_id, "\n".join(buf).strip()))
            current_call_id = str(m.group(1) or "").strip()
            buf = []
            continue
        if current_call_id:
            buf.append(line)
    if current_call_id and buf:
        out.append((current_call_id, "\n".join(buf).strip()))
    return out


def _parse_call_anchor_metadata(meta_text: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for line in str(meta_text or "").splitlines():
        m = _re.match(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*?)\s*$", line)
        if not m:
            continue
        k = str(m.group(1) or "").strip().lower()
        v = str(m.group(2) or "").strip()
        if k:
            out[k] = v
    return out


def _extract_call_anchor_segments(raw: str) -> list[dict[str, Any]]:
    text = str(raw or "")
    if not text.strip():
        return []
    pat = _re.compile(
        r"\[\s*CALL_ANCHOR_START\s*\](.*?)\[\s*CALL_ANCHOR_END\s*\]",
        _re.IGNORECASE | _re.DOTALL,
    )
    matches = list(pat.finditer(text))
    if not matches:
        return []

    out: list[dict[str, Any]] = []
    for i, m in enumerate(matches):
        meta = _parse_call_anchor_metadata(m.group(1) or "")
        call_id = str(meta.get("call_id") or "").strip()
        next_start = matches[i + 1].start() if (i + 1) < len(matches) else len(text)
        content = text[m.end() : next_start].strip()
        if not (call_id or content):
            continue
        out.append({
            "call_id": call_id,
            "meta": meta,
            "content": content,
        })
    return out


def _extract_call_id_tagged_segments(raw: str) -> list[dict[str, Any]]:
    """Extract call-scoped segments from outputs that include CALL_ID-tagged headings."""
    text = str(raw or "")
    if not text.strip():
        return []

    out: list[dict[str, Any]] = []
    current_call_id = ""
    current_title = ""
    buf: list[str] = []

    def _flush() -> None:
        nonlocal current_call_id, current_title, buf
        if not current_call_id:
            return
        content = "\n".join(buf).strip()
        if content:
            out.append({
                "call_id": current_call_id,
                "meta": {"title": current_title or f"CALL_ID {current_call_id}"},
                "content": content,
            })
        buf = []

    for line in text.splitlines():
        s = str(line or "").strip()
        call_id = ""
        title = ""

        m = _re.match(
            r"^\s*#{1,6}\s*Call\s+\d+\s*\|\s*CALL_ID\s*:\s*([^\s|)\]]+)\s*$",
            line,
            _re.IGNORECASE,
        )
        if m:
            call_id = str(m.group(1) or "").strip()
            title = _re.sub(r"^\s*#{1,6}\s*", "", s).strip()
        else:
            m = _re.match(
                r"^\s*\*{0,2}\s*System\s+Note\s*[–-]\s*Call\s+[^()]*\(\s*CALL\s+([^\s)]+)\s*\)\s*\*{0,2}\s*$",
                line,
                _re.IGNORECASE,
            )
            if m:
                call_id = str(m.group(1) or "").strip()
                title = s.strip("* ").strip()
            else:
                m = _re.match(r"^\s*CALL_ID\s*:\s*([^\s|)\]]+)\s*$", line, _re.IGNORECASE)
                if m:
                    call_id = str(m.group(1) or "").strip()
                    title = f"CALL_ID {call_id}"

        if call_id:
            _flush()
            current_call_id = call_id
            current_title = title or f"CALL_ID {call_id}"
            buf = []
            continue

        if current_call_id:
            buf.append(line)

    _flush()
    return out


def _tokenize_match_text(text: str) -> list[str]:
    stop = {
        "the", "and", "for", "with", "that", "this", "from", "have", "has", "had", "was", "were", "are", "is",
        "you", "your", "they", "their", "them", "our", "ours", "his", "her", "she", "him", "its", "who", "what",
        "when", "where", "why", "how", "into", "over", "under", "about", "after", "before", "than", "then", "also",
        "call", "calls", "summary", "process", "flow", "stage", "steps", "actions", "company", "procedures",
        "compliant", "violation", "violations", "total", "score", "scores", "customer", "agent",
    }
    toks = _re.findall(r"[a-z0-9]{3,}", str(text or "").lower())
    return [t for t in toks if t not in stop and not t.isdigit()]


def _is_global_section_title(title: str) -> bool:
    low = str(title or "").strip().lower()
    return (
        low.startswith("total violations")
        or low.startswith("global compliance")
        or low.startswith("overall")
        or low.startswith("global")
    )


def _get_cached_call_artifacts(
    key: tuple[str, str, str, str, int],
) -> Optional[dict[str, Any]]:
    now = time.time()
    with _CALL_ARTIFACTS_CACHE_LOCK:
        hit = _CALL_ARTIFACTS_CACHE.get(key)
        if not hit:
            return None
        expires_at, payload = hit
        if expires_at <= now:
            _CALL_ARTIFACTS_CACHE.pop(key, None)
            return None
        return payload


def _set_cached_call_artifacts(
    key: tuple[str, str, str, str, int],
    payload: dict[str, Any],
) -> None:
    now = time.time()
    with _CALL_ARTIFACTS_CACHE_LOCK:
        _CALL_ARTIFACTS_CACHE[key] = (now + _CALL_ARTIFACTS_CACHE_TTL_S, payload)
        if len(_CALL_ARTIFACTS_CACHE) > _CALL_ARTIFACTS_CACHE_MAX:
            oldest = sorted(
                _CALL_ARTIFACTS_CACHE.items(),
                key=lambda item: float(item[1][0]),
            )[: max(1, len(_CALL_ARTIFACTS_CACHE) - _CALL_ARTIFACTS_CACHE_MAX)]
            for old_key, _ in oldest:
                _CALL_ARTIFACTS_CACHE.pop(old_key, None)


def _get_merged_call_index(
    merged_path: os.PathLike[str] | str,
) -> tuple[list[tuple[str, str]], dict[str, list[str]], dict[str, float]]:
    path_str = str(merged_path)
    try:
        st = os.stat(path_str)
        mtime_ns = int(getattr(st, "st_mtime_ns", int(st.st_mtime * 1_000_000_000)))
    except Exception:
        return [], {}, {}

    with _MERGED_CALL_INDEX_CACHE_LOCK:
        cached = _MERGED_CALL_INDEX_CACHE.get(path_str)
        if cached and int(cached[0]) == mtime_ns:
            return cached[1], cached[2], cached[3]

    try:
        with open(path_str, "r", encoding="utf-8", errors="replace") as fh:
            merged_text = fh.read()
    except Exception:
        return [], {}, {}

    merged_calls = _split_merged_calls(merged_text)
    merged_call_tokens = {
        str(cid).strip().lower(): _tokenize_match_text(txt)
        for cid, txt in merged_calls
        if str(cid).strip()
    }
    idf: dict[str, float] = {}
    if merged_call_tokens:
        df: dict[str, int] = {}
        n_docs = len(merged_call_tokens)
        for toks in merged_call_tokens.values():
            for t in set(toks):
                df[t] = df.get(t, 0) + 1
        idf = {t: math.log((n_docs + 1) / (v + 1)) + 1.0 for t, v in df.items()}

    with _MERGED_CALL_INDEX_CACHE_LOCK:
        _MERGED_CALL_INDEX_CACHE[path_str] = (mtime_ns, merged_calls, merged_call_tokens, idf)
        if len(_MERGED_CALL_INDEX_CACHE) > 120:
            oldest_paths = list(_MERGED_CALL_INDEX_CACHE.keys())[:30]
            for p in oldest_paths:
                _MERGED_CALL_INDEX_CACHE.pop(p, None)

    return merged_calls, merged_call_tokens, idf


@router.get("/{pipeline_id}/call-artifacts")
def get_pipeline_call_artifacts(
    pipeline_id: str,
    sales_agent: str = "",
    customer: str = "",
    call_id: str = Query(""),
    min_confidence: float = Query(0.28),
    db: Session = Depends(get_session),
):
    """Return call-scoped artifacts.

    - per_call pipelines: exact call_id results
    - per_pair (merged) pipelines: best-effort section isolation against merged transcript call blocks
    """
    call_id_raw = str(call_id or "").strip()
    call_id_norm = call_id_raw.lower()
    if not call_id_norm:
        raise HTTPException(400, "call_id is required")
    cache_key = (
        str(pipeline_id or "").strip(),
        str(sales_agent or "").strip().lower(),
        str(customer or "").strip().lower(),
        call_id_norm,
        int(round(float(min_confidence) * 1000.0)),
    )
    cached_payload = _get_cached_call_artifacts(cache_key)
    if cached_payload is not None:
        return cached_payload

    _, pipeline_def = _find_file(pipeline_id)
    pipeline_scope = str(pipeline_def.get("scope") or "per_pair")
    steps = pipeline_def.get("steps") or []
    has_pipeline_cols = _agent_result_supports_pipeline_cache(db)

    # Step → output artifact meta from canvas wiring.
    def _step_artifact_meta() -> dict[int, dict[str, str]]:
        out: dict[int, dict[str, str]] = {}
        canvas = pipeline_def.get("canvas") or {}
        nodes = canvas.get("nodes") or []
        edges = canvas.get("edges") or []
        if not isinstance(nodes, list) or not isinstance(edges, list):
            return out

        proc_nodes_all = sorted(
            [n for n in nodes if isinstance(n, dict) and n.get("type") == "processing"],
            key=lambda n: (
                (n.get("data", {}) or {}).get("stageIndex", 0),
                (n.get("position", {}) or {}).get("x", 0),
            ),
        )
        proc_nodes_with_agent = [n for n in proc_nodes_all if ((n.get("data", {}) or {}).get("agentId"))]
        proc_nodes = proc_nodes_with_agent if len(proc_nodes_with_agent) >= len(steps) else proc_nodes_all
        proc_node_to_step: dict[str, int] = {}
        for i, n in enumerate(proc_nodes):
            if i >= len(steps):
                break
            nid = str(n.get("id") or "")
            if nid:
                proc_node_to_step[nid] = i

        output_data_by_id: dict[str, dict[str, Any]] = {}
        for n in nodes:
            if not isinstance(n, dict) or n.get("type") != "output":
                continue
            nid = str(n.get("id") or "")
            if not nid:
                continue
            output_data_by_id[nid] = dict(n.get("data", {}) or {})

        for e in edges:
            if not isinstance(e, dict):
                continue
            src = str(e.get("source") or "")
            tgt = str(e.get("target") or "")
            step_idx = proc_node_to_step.get(src)
            od = output_data_by_id.get(tgt)
            if step_idx is None or od is None:
                continue
            sub = str(od.get("subType") or "").strip().lower()
            if not sub:
                sub = str(od.get("label") or "").strip().lower().replace(" ", "_")
            if not sub:
                sub = "unknown"
            out.setdefault(step_idx, {"sub_type": sub, "label": str(od.get("label") or sub)})
        return out

    step_meta = _step_artifact_meta()

    def _fetch_latest_result(step_idx: int, agent_id: str, target_call_id: str) -> Optional[dict[str, Any]]:
        params: dict[str, Any] = {
            "agent_id": agent_id,
            "sales_agent": sales_agent,
            "customer": customer,
        }
        if has_pipeline_cols:
            sql = (
                "SELECT id, content, model, agent_name, created_at "
                "FROM agent_result "
                "WHERE agent_id = :agent_id "
                "AND LOWER(sales_agent) = LOWER(:sales_agent) "
                "AND LOWER(customer) = LOWER(:customer) "
                "AND pipeline_id = :pipeline_id "
                "AND pipeline_step_index = :step_idx "
            )
            params.update({"pipeline_id": pipeline_id, "step_idx": step_idx})
        else:
            sql = (
                "SELECT id, content, model, agent_name, created_at "
                "FROM agent_result "
                "WHERE agent_id = :agent_id "
                "AND LOWER(sales_agent) = LOWER(:sales_agent) "
                "AND LOWER(customer) = LOWER(:customer) "
            )

        if target_call_id:
            sql += "AND LOWER(TRIM(call_id)) = :call_id_norm "
            params["call_id_norm"] = target_call_id.strip().lower()
        else:
            sql += "AND TRIM(call_id) = '' "

        sql += "ORDER BY created_at DESC LIMIT 1"
        try:
            row = db.execute(_sql_text(sql), params).first()
        except Exception:
            return None
        if not row:
            return None
        m = getattr(row, "_mapping", row)
        if not hasattr(m, "get"):
            return None
        created = m.get("created_at")
        created_at = created.isoformat() if hasattr(created, "isoformat") else (str(created) if created else "")
        return {
            "id": str(m.get("id") or ""),
            "content": str(m.get("content") or ""),
            "model": str(m.get("model") or ""),
            "agent_name": str(m.get("agent_name") or ""),
            "created_at": created_at,
        }

    merged_calls: list[tuple[str, str]] = []
    merged_call_tokens: dict[str, list[str]] = {}
    idf: dict[str, float] = {}

    if pipeline_scope != "per_call":
        merged_path = settings.agents_dir / sales_agent / customer / "merged_transcript.txt"
        if not merged_path.exists():
            try:
                from ui.backend.routers.agent_comparison import _build_and_save_merged_transcript
                _build_and_save_merged_transcript(sales_agent, customer, force=True)
            except Exception:
                pass
        if merged_path.exists():
            merged_calls, merged_call_tokens, idf = _get_merged_call_index(merged_path)

    artifacts_out: list[dict[str, Any]] = []
    unassigned_out: list[dict[str, Any]] = []

    for step_idx, step in enumerate(steps):
        if not isinstance(step, dict):
            continue
        agent_id = str(step.get("agent_id") or "")
        if not agent_id:
            continue

        m = step_meta.get(step_idx, {})
        artifact_type = str(m.get("sub_type") or "unknown")
        artifact_label = str(m.get("label") or artifact_type)

        exact = _fetch_latest_result(step_idx, agent_id, call_id_raw)
        if exact:
            artifacts_out.append({
                "step_index": step_idx,
                "agent_id": agent_id,
                "agent_name": exact.get("agent_name") or agent_id,
                "artifact_type": artifact_type,
                "artifact_label": artifact_label,
                "scope": "call",
                "association": "exact",
                "confidence": 1.0,
                "result_id": exact.get("id") or "",
                "created_at": exact.get("created_at") or "",
                "model": exact.get("model") or "",
                "content": exact.get("content") or "",
                "sections": [],
            })
            continue

        if pipeline_scope == "per_call":
            unassigned_out.append({
                "step_index": step_idx,
                "agent_id": agent_id,
                "artifact_type": artifact_type,
                "reason": "no exact call artifact cached",
            })
            continue

        pair_row = _fetch_latest_result(step_idx, agent_id, "")
        if not pair_row:
            unassigned_out.append({
                "step_index": step_idx,
                "agent_id": agent_id,
                "artifact_type": artifact_type,
                "reason": "no pair artifact cached",
            })
            continue

        anchored_segments = _extract_call_anchor_segments(pair_row.get("content") or "")
        if anchored_segments:
            matched_segments = [
                s for s in anchored_segments
                if str(s.get("call_id") or "").strip().lower() == call_id_norm
            ]
            if matched_segments:
                selected_sections: list[dict[str, Any]] = []
                for idx, seg in enumerate(matched_segments):
                    seg_content = str(seg.get("content") or "").strip()
                    if not seg_content:
                        continue
                    meta = seg.get("meta") or {}
                    seg_title = (
                        str(meta.get("section") or "").strip()
                        or str(meta.get("title") or "").strip()
                        or f"CALL_ID {call_id_raw} Section {idx + 1}"
                    )
                    selected_sections.append({
                        "title": seg_title,
                        "content": seg_content,
                        "score": 1.0,
                        "top_call_id": call_id_norm,
                        "top_score": 1.0,
                        "second_score": 0.0,
                        "relative": 1.0,
                    })
                if selected_sections:
                    merged_content = "\n\n".join(
                        [f"## {s['title']}\n\n{s['content']}" for s in selected_sections]
                    )
                    artifacts_out.append({
                        "step_index": step_idx,
                        "agent_id": agent_id,
                        "agent_name": pair_row.get("agent_name") or agent_id,
                        "artifact_type": artifact_type,
                        "artifact_label": artifact_label,
                        "scope": "pair",
                        "association": "exact_anchor",
                        "confidence": 1.0,
                        "result_id": pair_row.get("id") or "",
                        "created_at": pair_row.get("created_at") or "",
                        "model": pair_row.get("model") or "",
                        "content": merged_content,
                        "sections": selected_sections,
                    })
                    continue

        tagged_segments = _extract_call_id_tagged_segments(pair_row.get("content") or "")
        if tagged_segments:
            matched_tagged = [
                s for s in tagged_segments
                if str(s.get("call_id") or "").strip().lower() == call_id_norm
            ]
            if matched_tagged:
                selected_sections: list[dict[str, Any]] = []
                for idx, seg in enumerate(matched_tagged):
                    seg_content = str(seg.get("content") or "").strip()
                    if not seg_content:
                        continue
                    meta = seg.get("meta") or {}
                    seg_title = (
                        str(meta.get("section") or "").strip()
                        or str(meta.get("title") or "").strip()
                        or f"CALL_ID {call_id_raw} Section {idx + 1}"
                    )
                    selected_sections.append({
                        "title": seg_title,
                        "content": seg_content,
                        "score": 1.0,
                        "top_call_id": call_id_norm,
                        "top_score": 1.0,
                        "second_score": 0.0,
                        "relative": 1.0,
                    })
                if selected_sections:
                    merged_content = "\n\n".join(
                        [f"## {s['title']}\n\n{s['content']}" for s in selected_sections]
                    )
                    artifacts_out.append({
                        "step_index": step_idx,
                        "agent_id": agent_id,
                        "agent_name": pair_row.get("agent_name") or agent_id,
                        "artifact_type": artifact_type,
                        "artifact_label": artifact_label,
                        "scope": "pair",
                        "association": "exact_call_id_tag",
                        "confidence": 1.0,
                        "result_id": pair_row.get("id") or "",
                        "created_at": pair_row.get("created_at") or "",
                        "model": pair_row.get("model") or "",
                        "content": merged_content,
                        "sections": selected_sections,
                    })
                    continue

        if call_id_norm not in merged_call_tokens:
            unassigned_out.append({
                "step_index": step_idx,
                "agent_id": agent_id,
                "artifact_type": artifact_type,
                "reason": "selected call not found in merged transcript",
            })
            continue

        sections = _split_text_sections(pair_row.get("content") or "")
        selected_sections: list[dict[str, Any]] = []

        for sec in sections:
            title = str(sec.get("title") or "").strip() or "Section"
            content = str(sec.get("content") or "")
            if _is_global_section_title(title):
                continue
            if len(content.strip()) < 120:
                continue

            sec_tokens = _tokenize_match_text(content)
            if not sec_tokens:
                continue
            sec_ctr = Counter(sec_tokens)
            denom = sum(sec_ctr[t] * idf.get(t, 1.0) for t in sec_ctr) or 1.0

            ranked: list[tuple[float, str]] = []
            for cid_norm, call_toks in merged_call_tokens.items():
                token_set = set(call_toks)
                score = sum(sec_ctr[t] * idf.get(t, 1.0) for t in sec_ctr if t in token_set) / denom
                ranked.append((score, cid_norm))
            ranked.sort(reverse=True)
            if not ranked:
                continue

            top_score, top_call = ranked[0]
            second_score = ranked[1][0] if len(ranked) > 1 else 0.0
            selected_score = 0.0
            for sc, cid_norm in ranked:
                if cid_norm == call_id_norm:
                    selected_score = sc
                    break
            relative = selected_score / top_score if top_score > 0 else 0.0
            gap = top_score - selected_score
            accepted = (
                selected_score >= float(min_confidence)
                and relative >= 0.72
                and gap <= 0.18
            )
            if not accepted:
                continue

            selected_sections.append({
                "title": title,
                "content": content,
                "score": round(float(selected_score), 4),
                "top_call_id": top_call,
                "top_score": round(float(top_score), 4),
                "second_score": round(float(second_score), 4),
                "relative": round(float(relative), 4),
            })

        if not selected_sections:
            unassigned_out.append({
                "step_index": step_idx,
                "agent_id": agent_id,
                "artifact_type": artifact_type,
                "reason": "no section passed merged-call isolation thresholds",
            })
            continue

        merged_content = "\n\n".join(
            [f"## {s['title']}\n\n{s['content']}" for s in selected_sections]
        )
        conf = max(float(s.get("score") or 0.0) for s in selected_sections)
        artifacts_out.append({
            "step_index": step_idx,
            "agent_id": agent_id,
            "agent_name": pair_row.get("agent_name") or agent_id,
            "artifact_type": artifact_type,
            "artifact_label": artifact_label,
            "scope": "pair",
            "association": "isolated_merged",
            "confidence": round(conf, 4),
            "result_id": pair_row.get("id") or "",
            "created_at": pair_row.get("created_at") or "",
            "model": pair_row.get("model") or "",
            "content": merged_content,
            "sections": selected_sections,
        })

    artifacts_out.sort(key=lambda x: int(x.get("step_index", 0)))
    unassigned_out.sort(key=lambda x: int(x.get("step_index", 0)))
    payload = {
        "pipeline_id": pipeline_id,
        "sales_agent": sales_agent,
        "customer": customer,
        "call_id": call_id_raw,
        "pipeline_scope": pipeline_scope,
        "mode": "exact" if pipeline_scope == "per_call" else "exact_or_isolated_merged",
        "artifacts": artifacts_out,
        "unassigned": unassigned_out,
        "generated_at": datetime.utcnow().isoformat(),
    }
    _set_cached_call_artifacts(cache_key, payload)
    return payload


@router.get("/{pipeline_id}/artifact-status")
def get_pipeline_artifact_status(
    pipeline_id: str,
    sales_agent: str = "",
    customer: str = "",
    call_ids: str = Query(""),
    db: Session = Depends(get_session),
):
    """Pipeline artifact coverage by call/pair for badge rendering in Calls UI."""
    _, pipeline_def = _find_file(pipeline_id)
    total_steps = len(pipeline_def.get("steps", []) or [])

    def _norm_call_id(v: Any) -> str:
        s = str(v or "").strip()
        if not s:
            return ""
        return s.lower()

    requested_call_ids = [c.strip() for c in (call_ids or "").split(",") if c.strip()]
    requested_norm_to_raw: dict[str, str] = {}
    for cid in requested_call_ids:
        n = _norm_call_id(cid)
        if n and n not in requested_norm_to_raw:
            requested_norm_to_raw[n] = cid
    requested_set = set(requested_norm_to_raw.keys())

    def _extract_artifact_types_by_step() -> dict[int, set[str]]:
        out: dict[int, set[str]] = {}
        canvas = pipeline_def.get("canvas") or {}
        nodes = canvas.get("nodes") or []
        edges = canvas.get("edges") or []
        if not isinstance(nodes, list) or not isinstance(edges, list):
            return out

        proc_nodes_all = sorted(
            [n for n in nodes if isinstance(n, dict) and n.get("type") == "processing"],
            key=lambda n: (
                (n.get("data", {}) or {}).get("stageIndex", 0),
                (n.get("position", {}) or {}).get("x", 0),
            ),
        )
        proc_nodes_with_agent = [n for n in proc_nodes_all if ((n.get("data", {}) or {}).get("agentId"))]
        proc_nodes = proc_nodes_with_agent if len(proc_nodes_with_agent) >= total_steps else proc_nodes_all
        proc_node_to_step: dict[str, int] = {}
        for i, n in enumerate(proc_nodes):
            if i >= total_steps:
                break
            nid = str(n.get("id") or "")
            if nid:
                proc_node_to_step[nid] = i

        output_data_by_id: dict[str, dict[str, Any]] = {}
        for n in nodes:
            if not isinstance(n, dict) or n.get("type") != "output":
                continue
            nid = str(n.get("id") or "")
            if not nid:
                continue
            output_data_by_id[nid] = dict(n.get("data", {}) or {})

        for e in edges:
            if not isinstance(e, dict):
                continue
            src = str(e.get("source") or "")
            tgt = str(e.get("target") or "")
            step_idx = proc_node_to_step.get(src)
            od = output_data_by_id.get(tgt)
            if step_idx is None or not od:
                continue
            raw = str(od.get("subType") or "").strip().lower() or str(od.get("label") or "").strip().lower()
            if not raw:
                continue
            clean = raw.replace("artifact_", "").replace(" ", "_")
            out.setdefault(step_idx, set()).add(clean)
        return out

    def _to_iso(v: Any) -> Optional[str]:
        if v is None:
            return None
        if hasattr(v, "isoformat"):
            return v.isoformat()
        return str(v)

    def _max_iso(a: Optional[str], b: Optional[str]) -> Optional[str]:
        if not a:
            return b
        if not b:
            return a
        return b if b > a else a

    artifact_types_by_step = _extract_artifact_types_by_step()
    artifact_step_ids = set(artifact_types_by_step.keys())
    artifact_total = len(artifact_step_ids)

    def _state(
        step_ids: set[int],
        last_at: Optional[str],
        note_sent: bool = False,
        note_sent_at: Optional[str] = None,
    ) -> dict[str, Any]:
        valid_step_ids = {s for s in step_ids if 0 <= s < total_steps}
        step_count = len(valid_step_ids)
        agent_step_count = step_count
        processed = step_count > 0
        complete = bool(total_steps > 0 and step_count >= total_steps)
        artifact_step_count = len([s for s in valid_step_ids if s in artifact_step_ids])
        artifact_types = sorted({
            t
            for s in valid_step_ids
            for t in artifact_types_by_step.get(s, set())
        })
        artifact_complete = bool(artifact_total > 0 and artifact_step_count >= artifact_total)
        return {
            "processed": processed,
            "complete": complete,
            "step_count": step_count,
            "agent_step_count": agent_step_count,
            "total_steps": total_steps,
            "artifact_count": artifact_step_count,
            "artifact_total": artifact_total,
            "artifact_complete": artifact_complete,
            "artifact_types": artifact_types,
            "last_at": last_at,
            "note_sent": bool(note_sent),
            "note_sent_at": note_sent_at,
        }

    grouped_step_ids: dict[str, set[int]] = {}
    grouped_last_at: dict[str, Optional[str]] = {}
    grouped_raw_call_id: dict[str, str] = {}
    grouped_note_sent: dict[str, bool] = {}
    grouped_note_sent_at: dict[str, Optional[str]] = {}

    def _mark_note_sent(norm_call_id: str, ts: Optional[str]) -> None:
        grouped_note_sent[norm_call_id] = True
        grouped_note_sent_at[norm_call_id] = _max_iso(grouped_note_sent_at.get(norm_call_id), ts)

    def _merge_grouped_rows(rows: list[Any], call_key: str, step_key: str, last_key: str) -> None:
        for r in rows:
            m = getattr(r, "_mapping", r)
            cid_raw = str(m.get(call_key, "") if hasattr(m, "get") else (r[0] if len(r) > 0 else ""))
            cid = _norm_call_id(cid_raw)
            step_idx = int(m.get(step_key, -1) if hasattr(m, "get") else (r[1] if len(r) > 1 else -1))
            last_at = _to_iso(m.get(last_key) if hasattr(m, "get") else (r[2] if len(r) > 2 else None))
            grouped_step_ids.setdefault(cid, set()).add(step_idx)
            grouped_last_at[cid] = _max_iso(grouped_last_at.get(cid), last_at)
            cid_clean = str(cid_raw).strip()
            if cid and cid_clean and cid not in grouped_raw_call_id:
                grouped_raw_call_id[cid] = cid_clean

    has_artifact_cols = {"id", "pipeline_id", "sales_agent", "customer", "call_id", "pipeline_step_index"}.issubset(
        _get_table_columns(db, "pipeline_artifact")
    )
    if has_artifact_cols:
        try:
            rows = db.execute(
                _sql_text(
                    "SELECT call_id, pipeline_step_index, MAX(updated_at) AS last_at "
                    "FROM pipeline_artifact "
                    "WHERE pipeline_id = :pipeline_id "
                    "AND LOWER(sales_agent) = LOWER(:sales_agent) "
                    "AND LOWER(customer) = LOWER(:customer) "
                    "GROUP BY call_id, pipeline_step_index"
                ),
                {
                    "pipeline_id": pipeline_id,
                    "sales_agent": sales_agent,
                    "customer": customer,
                },
            ).all()
            _merge_grouped_rows(rows, "call_id", "pipeline_step_index", "last_at")
        except Exception:
            pass

    # Compatibility merge for older cache rows and any contexts where pipeline_artifact
    # was not backfilled for previously completed steps.
    supports_pipeline_cache = _agent_result_supports_pipeline_cache(db)
    if supports_pipeline_cache:
        try:
            rows = db.execute(
                _sql_text(
                    "SELECT call_id, pipeline_step_index, MAX(created_at) AS last_at "
                    "FROM agent_result "
                    "WHERE pipeline_id = :pipeline_id "
                    "AND LOWER(sales_agent) = LOWER(:sales_agent) "
                    "AND LOWER(customer) = LOWER(:customer) "
                    "GROUP BY call_id, pipeline_step_index"
                ),
                {
                    "pipeline_id": pipeline_id,
                    "sales_agent": sales_agent,
                    "customer": customer,
                },
            ).all()
            _merge_grouped_rows(rows, "call_id", "pipeline_step_index", "last_at")
        except Exception:
            pass
    else:
        # Legacy schema (no pipeline_id / pipeline_step_index in agent_result):
        # infer cached step coverage by matching pipeline step agent_ids to per-call
        # agent_result rows for this pair. This mirrors /results fallback behavior.
        step_idxs_by_agent: dict[str, list[int]] = {}
        for i, step in enumerate(pipeline_def.get("steps") or []):
            if not isinstance(step, dict):
                continue
            aid = str(step.get("agent_id") or "").strip()
            if not aid:
                continue
            step_idxs_by_agent.setdefault(aid, []).append(i)
        if step_idxs_by_agent:
            try:
                rows = db.execute(
                    _sql_text(
                        "SELECT call_id, agent_id, MAX(created_at) AS last_at "
                        "FROM agent_result "
                        "WHERE LOWER(sales_agent) = LOWER(:sales_agent) "
                        "AND LOWER(customer) = LOWER(:customer) "
                        "GROUP BY call_id, agent_id"
                    ),
                    {
                        "sales_agent": sales_agent,
                        "customer": customer,
                    },
                ).all()
                for r in rows:
                    m = getattr(r, "_mapping", r)
                    cid_raw = str(m.get("call_id", "") if hasattr(m, "get") else (r[0] if len(r) > 0 else ""))
                    cid = _norm_call_id(cid_raw)
                    aid = str(m.get("agent_id", "") if hasattr(m, "get") else (r[1] if len(r) > 1 else ""))
                    last_at = _to_iso(m.get("last_at") if hasattr(m, "get") else (r[2] if len(r) > 2 else None))
                    step_idxs = step_idxs_by_agent.get(aid, [])
                    if not step_idxs:
                        continue
                    for step_idx in step_idxs:
                        grouped_step_ids.setdefault(cid, set()).add(step_idx)
                    grouped_last_at[cid] = _max_iso(grouped_last_at.get(cid), last_at)
                    cid_clean = str(cid_raw).strip()
                    if cid and cid_clean and cid not in grouped_raw_call_id:
                        grouped_raw_call_id[cid] = cid_clean
            except Exception:
                pass

    # Optional note-push status by call, inferred from successful CRM push entries
    # in pipeline_run.log_json. Keep this best-effort and fully backward compatible.
    has_pipeline_run_cols = {
        "id",
        "pipeline_id",
        "sales_agent",
        "customer",
        "call_id",
        "status",
        "started_at",
        "finished_at",
        "log_json",
    }.issubset(_get_table_columns(db, "pipeline_run"))
    if has_pipeline_run_cols:
        try:
            rows = db.execute(
                _sql_text(
                    "SELECT call_id, COALESCE(finished_at, started_at) AS last_at, log_json "
                    "FROM pipeline_run "
                    "WHERE pipeline_id = :pipeline_id "
                    "AND LOWER(sales_agent) = LOWER(:sales_agent) "
                    "AND LOWER(customer) = LOWER(:customer) "
                    "AND status = 'done' "
                    "ORDER BY COALESCE(finished_at, started_at) DESC "
                    "LIMIT 1000"
                ),
                {
                    "pipeline_id": pipeline_id,
                    "sales_agent": sales_agent,
                    "customer": customer,
                },
            ).all()
            for r in rows:
                m = getattr(r, "_mapping", r)
                cid_raw = str(m.get("call_id", "") if hasattr(m, "get") else (r[0] if len(r) > 0 else ""))
                cid = _norm_call_id(cid_raw)
                if requested_set and cid and cid not in requested_set:
                    continue
                last_at = _to_iso(m.get("last_at") if hasattr(m, "get") else (r[1] if len(r) > 1 else None))
                log_blob = str(m.get("log_json", "") if hasattr(m, "get") else (r[2] if len(r) > 2 else ""))
                if "[CRM-PUSH] ✓ Sent note " not in log_blob:
                    continue
                _mark_note_sent(cid, last_at)
        except Exception:
            pass

    # Fallback (file-backed execution logs), for deployments where pipeline_run table
    # does not exist or is not populated. Reads recent pipeline_run sessions and checks
    # report.log_lines_tail for CRM push success markers.
    if not grouped_note_sent:
        try:
            recent_sessions = execution_logs.list_recent(limit=2500, action="pipeline_run")
            for row in recent_sessions:
                ctx = row.get("context") if isinstance(row.get("context"), dict) else {}
                if str(ctx.get("pipeline_id") or "").strip() != pipeline_id:
                    continue
                if str(ctx.get("sales_agent") or "").strip().lower() != str(sales_agent or "").strip().lower():
                    continue
                if str(ctx.get("customer") or "").strip().lower() != str(customer or "").strip().lower():
                    continue
                sid = str(row.get("session_id") or "").strip()
                if not sid:
                    continue

                full = execution_logs.get_session(sid)
                if not isinstance(full, dict):
                    continue
                report = full.get("report") if isinstance(full.get("report"), dict) else {}
                tail = report.get("log_lines_tail") if isinstance(report, dict) else []
                if not isinstance(tail, list):
                    continue
                sent_ok = False
                for item in tail:
                    if not isinstance(item, dict):
                        continue
                    txt = str(item.get("text") or item.get("message") or "")
                    if "[CRM-PUSH] ✓ Sent note " in txt:
                        sent_ok = True
                        break
                if not sent_ok:
                    continue

                cid = _norm_call_id(ctx.get("call_id"))
                if requested_set and cid and cid not in requested_set:
                    continue
                ts = (
                    _to_iso(full.get("finished_at_utc"))
                    or _to_iso(full.get("updated_at_utc"))
                    or _to_iso(row.get("updated_at_utc"))
                )
                _mark_note_sent(cid, ts)
        except Exception:
            pass

    calls_out: dict[str, dict[str, Any]] = {}
    source_call_ids = sorted(list(requested_set)) if requested_set else sorted([cid for cid in grouped_step_ids.keys() if cid])
    for norm_cid in source_call_ids:
        out_key = requested_norm_to_raw.get(norm_cid) or grouped_raw_call_id.get(norm_cid) or norm_cid
        calls_out[out_key] = _state(
            grouped_step_ids.get(norm_cid, set()),
            grouped_last_at.get(norm_cid),
            grouped_note_sent.get(norm_cid, False),
            grouped_note_sent_at.get(norm_cid),
        )

    # Include discovered calls too when caller did not pass explicit call_ids.
    if not requested_set:
        for norm_cid in grouped_step_ids.keys():
            if not norm_cid:
                continue
            out_key = grouped_raw_call_id.get(norm_cid) or norm_cid
            if out_key in calls_out:
                continue
            calls_out[out_key] = _state(
                grouped_step_ids.get(norm_cid, set()),
                grouped_last_at.get(norm_cid),
                grouped_note_sent.get(norm_cid, False),
                grouped_note_sent_at.get(norm_cid),
            )

    return {
        "pipeline_id": pipeline_id,
        "sales_agent": sales_agent,
        "customer": customer,
        "pair": _state(
            grouped_step_ids.get("", set()),
            grouped_last_at.get(""),
            grouped_note_sent.get("", False),
            grouped_note_sent_at.get(""),
        ),
        "calls": calls_out,
        "generated_at": datetime.utcnow().isoformat(),
    }


@router.post("/{pipeline_id}/stop")
async def stop_pipeline(
    pipeline_id: str,
    req: PipelineStopRequest,
    request: Request,
):
    """Request cancellation of an active pipeline run for this context."""
    _require_can_run_pipeline(request)
    _find_file(pipeline_id)
    client_local_time = request.headers.get("x-client-local-time", "")
    client_timezone = request.headers.get("x-client-timezone", "")
    execution_session_id = execution_logs.start_session(
        action="pipeline_stop",
        source="backend",
        context={
            "pipeline_id": pipeline_id,
            "sales_agent": req.sales_agent,
            "customer": req.customer,
            "call_id": req.call_id,
        },
        client_local_time=client_local_time,
        client_timezone=client_timezone,
        status="running",
    )
    slot = _run_slot_key(pipeline_id, req.sales_agent, req.customer, req.call_id)
    task: Optional[asyncio.Task] = None
    with _ACTIVE_RUN_LOCK:
        ev = _STOP_REQUESTED.get(slot)
        if ev:
            ev.set()
        task = _ACTIVE_RUN_TASKS.get(slot)

    cancelled = False
    if task and not task.done():
        task.cancel()
        cancelled = True

    # Proactively mark state file as cancelled for per-pair UI so canvas unblocks quickly.
    # If the run coroutine is still alive, it will keep the same run_id and reconcile.
    try:
        path = _STATE_DIR / f"{_pair_key(pipeline_id, req.sales_agent, req.customer)}.json"
        if path.exists():
            data = json.loads(path.read_text(encoding="utf-8"))
            if data.get("status") == "running":
                now_iso = datetime.utcnow().isoformat()
                for s in data.get("steps", []):
                    st = str(s.get("state") or s.get("status") or "").strip().lower()
                    if st in ("running", "loading", "started"):
                        s["state"] = "cancelled"
                        s["status"] = "cancelled"  # explicit status for UI mapping
                        s["end_time"] = now_iso
                        s["error_msg"] = "stopped by user"
                node_states = data.get("node_states")
                if isinstance(node_states, dict):
                    for bucket in ("input", "processing", "output"):
                        b = node_states.get(bucket)
                        if not isinstance(b, dict):
                            continue
                        for node_id, raw_st in list(b.items()):
                            st = str(raw_st or "").lower()
                            if st in ("running", "loading", "started"):
                                b[node_id] = "cancelled"
                data["status"] = "cancelled"
                data["updated_at"] = now_iso
                path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    except Exception:
        pass

    execution_logs.append_event(
        execution_session_id,
        "Pipeline stop requested",
        level="stage",
        status="success" if cancelled else "running",
        data={"slot": slot, "cancelled": cancelled},
        client_local_time=client_local_time,
    )
    execution_logs.finish_session(
        execution_session_id,
        status="success" if cancelled else "completed_with_no_active_task",
        report={"slot": slot, "cancelled": cancelled},
    )
    return {"ok": True, "cancelled": cancelled, "slot": slot, "execution_session_id": execution_session_id}


@router.get("/{pipeline_id}/runs")
def list_pipeline_runs(
    pipeline_id: str,
    request: Request,
    sales_agent: str = Query(""),
    customer: str = Query(""),
    call_id: Optional[str] = Query(None),
    limit: int = Query(30),
    db: Session = Depends(get_session),
):
    """Return recent runs for a specific pipeline."""
    profile = _require_can_view(request)
    _, pdef = _find_file(pipeline_id)
    if not _can_access_pipeline_record(profile, pdef):
        raise HTTPException(status_code=404, detail="Pipeline not found.")
    from ui.backend.models.pipeline_run import PipelineRun as PR

    stmt = select(PR).where(PR.pipeline_id == pipeline_id)
    if sales_agent:          stmt = stmt.where(PR.sales_agent == sales_agent)
    if customer:             stmt = stmt.where(PR.customer == customer)
    if call_id is not None:  stmt = stmt.where(PR.call_id == call_id)
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


@router.get("/{pipeline_id}/analytics")
def get_pipeline_analytics(
    pipeline_id: str,
    request: Request,
    sales_agent: str = Query(""),
    customer: str = Query(""),
    call_id: Optional[str] = Query(None),
    run_id: str = Query(""),
    limit: int = Query(50),
    db: Session = Depends(get_session),
):
    """Return parsed score + violation metrics from pipeline run outputs."""
    profile = _require_can_view(request)
    try:
        _, pdef_access = _find_file(pipeline_id)
        if not _can_access_pipeline_record(profile, pdef_access):
            raise HTTPException(status_code=404, detail="Pipeline not found.")
    except HTTPException:
        raise
    except Exception:
        pass
    from ui.backend.models.pipeline_run import PipelineRun as PR
    try:
        from ui.backend.routers.universal_agents import _load_all as _load_agents
        agent_map = {str(a.get("id") or ""): a for a in _load_agents()}
    except Exception:
        agent_map = {}

    try:
        _, pipeline_def = _find_file(pipeline_id)
    except Exception:
        pipeline_def = {"id": pipeline_id, "steps": [], "canvas": {}}

    rubric = _collect_pipeline_rubric_catalog(pipeline_def, agent_map, db)
    score_catalog = rubric.get("score_sections") or []
    violation_catalog = rubric.get("violation_types") or []

    safe_limit = max(1, min(limit, 300))
    stmt = select(PR).where(PR.pipeline_id == pipeline_id)
    if sales_agent:
        stmt = stmt.where(PR.sales_agent == sales_agent)
    if customer:
        stmt = stmt.where(PR.customer == customer)
    if call_id is not None:
        stmt = stmt.where(PR.call_id == call_id)
    stmt = stmt.order_by(PR.started_at.desc()).limit(safe_limit)
    rows = db.exec(stmt).all()

    scoped_rows = _dedupe_runs_by_source(rows) if not run_id else rows

    run_items: list[dict] = []
    for r in scoped_rows:
        run_items.append({
            "id": r.id,
            "pipeline_id": r.pipeline_id,
            "pipeline_name": r.pipeline_name,
            "sales_agent": r.sales_agent,
            "customer": r.customer,
            "call_id": r.call_id,
            "started_at": r.started_at.isoformat() if r.started_at else None,
            "finished_at": r.finished_at.isoformat() if r.finished_at else None,
            "status": r.status,
        })

    selected_runs = scoped_rows
    if run_id:
        selected_runs = [r for r in rows if str(r.id) == run_id]
        if not selected_runs:
            single = db.get(PR, run_id)
            if single and single.pipeline_id == pipeline_id:
                if (not sales_agent or single.sales_agent == sales_agent) and (not customer or single.customer == customer):
                    if call_id is None or single.call_id == call_id:
                        selected_runs = [single]
                        run_items = [ri for ri in run_items if ri["id"] == run_id] or [{
                            "id": single.id,
                            "pipeline_id": single.pipeline_id,
                            "pipeline_name": single.pipeline_name,
                            "sales_agent": single.sales_agent,
                            "customer": single.customer,
                            "call_id": single.call_id,
                            "started_at": single.started_at.isoformat() if single.started_at else None,
                            "finished_at": single.finished_at.isoformat() if single.finished_at else None,
                            "status": single.status,
                        }]

    parsed_rows, score_values, violation_totals, selected_run_summaries = _collect_metrics_for_runs(
        runs=selected_runs,
        agent_map=agent_map,
        score_catalog=score_catalog,
        violation_catalog=violation_catalog,
    )
    score_by_section = _score_averages_from_values(score_values)
    violation_by_type = _violation_totals_to_rows(violation_totals)

    # Ensure rubric-defined labels appear even when current rows are empty.
    existing_scores = {str(r["section"]).lower() for r in score_by_section}
    for sec in score_catalog:
        if str(sec).lower() in existing_scores:
            continue
        score_by_section.append({"section": sec, "average": 0.0, "count": 0})
    score_by_section.sort(key=lambda x: str(x["section"]).lower())

    existing_violations = {str(r["type"]).lower() for r in violation_by_type}
    for vtype in violation_catalog:
        if str(vtype).lower() in existing_violations:
            continue
        violation_by_type.append({"type": vtype, "total": 0})
    violation_by_type.sort(key=lambda x: (-int(x["total"]), str(x["type"]).lower()))

    pair_flat_scores = [v for vals in score_values.values() for v in vals]
    pair_total_violations = int(sum(violation_totals.values()))
    pair_run_count = len(selected_runs)
    pair_summary = {
        "run_count": pair_run_count,
        "avg_score_all_sections": (
            round(sum(pair_flat_scores) / len(pair_flat_scores), 2)
            if pair_flat_scores else None
        ),
        "total_violations": pair_total_violations,
        "avg_violations_per_run": (
            round(pair_total_violations / pair_run_count, 2)
            if pair_run_count else None
        ),
    }

    agent_aggregate: dict[str, Any] = {}
    if sales_agent:
        agent_limit = max(500, safe_limit * 8)
        stmt_agent = select(PR).where(PR.pipeline_id == pipeline_id, PR.sales_agent == sales_agent)
        if call_id is not None:
            stmt_agent = stmt_agent.where(PR.call_id == call_id)
        stmt_agent = stmt_agent.order_by(PR.started_at.desc()).limit(agent_limit)
        agent_runs = db.exec(stmt_agent).all()
        agent_runs = _dedupe_runs_by_source(agent_runs)

        (
            _agent_rows_unused,
            agent_score_values,
            agent_violation_totals,
            agent_run_summaries,
        ) = _collect_metrics_for_runs(
            runs=agent_runs,
            agent_map=agent_map,
            score_catalog=score_catalog,
            violation_catalog=violation_catalog,
        )
        agent_score_by_section = _score_averages_from_values(agent_score_values)
        agent_violation_by_type = _violation_totals_to_rows(agent_violation_totals)

        existing_agent_scores = {str(r["section"]).lower() for r in agent_score_by_section}
        for sec in score_catalog:
            if str(sec).lower() not in existing_agent_scores:
                agent_score_by_section.append({"section": sec, "average": 0.0, "count": 0})
        agent_score_by_section.sort(key=lambda x: str(x["section"]).lower())

        existing_agent_viol = {str(r["type"]).lower() for r in agent_violation_by_type}
        for vtype in violation_catalog:
            if str(vtype).lower() not in existing_agent_viol:
                agent_violation_by_type.append({"type": vtype, "total": 0})
        agent_violation_by_type.sort(key=lambda x: (-int(x["total"]), str(x["type"]).lower()))

        agent_flat_scores = [v for vals in agent_score_values.values() for v in vals]
        agent_total_violations = int(sum(agent_violation_totals.values()))
        agent_run_count = len(agent_runs)
        agent_customers = sorted({str(r.customer or "") for r in agent_runs if str(r.customer or "").strip()})

        agent_aggregate = {
            "sales_agent": sales_agent,
            "run_count": agent_run_count,
            "customer_count": len(agent_customers),
            "customers": agent_customers,
            "avg_score_all_sections": (
                round(sum(agent_flat_scores) / len(agent_flat_scores), 2)
                if agent_flat_scores else None
            ),
            "total_violations": agent_total_violations,
            "avg_violations_per_run": (
                round(agent_total_violations / agent_run_count, 2)
                if agent_run_count else None
            ),
            "avg_violations_per_customer": (
                round(agent_total_violations / len(agent_customers), 2)
                if agent_customers else None
            ),
            "score_by_section": agent_score_by_section,
            "violation_by_type": agent_violation_by_type,
            "run_summaries": agent_run_summaries,
        }

    return {
        "pipeline_id": pipeline_id,
        "pipeline_name": run_items[0]["pipeline_name"] if run_items else "",
        "sales_agent": sales_agent,
        "customer": customer,
        "call_id": call_id or "",
        "selected_run_id": run_id or "",
        "runs": run_items,
        "rows": parsed_rows,
        "score_by_section": score_by_section,
        "violation_by_type": violation_by_type,
        "rubric": rubric,
        "pair_summary": pair_summary,
        "run_summaries": selected_run_summaries,
        "agent_aggregate": agent_aggregate,
    }


@router.get("/{pipeline_id}/metrics-index")
def get_pipeline_metrics_index(
    pipeline_id: str,
    sales_agent: str = Query(""),
    customer: str = Query(""),
    call_id: Optional[str] = Query(None),
    run_from: str = Query(""),
    run_to: str = Query(""),
    event_from: str = Query(""),
    event_to: str = Query(""),
    limit: int = Query(1200),
    db: Session = Depends(get_session),
):
    """Compact pair/agent artifact metrics for CRM filtering/sorting."""
    from ui.backend.models.pipeline_run import PipelineRun as PR

    try:
        from ui.backend.routers.universal_agents import _load_all as _load_agents
        agent_map = {str(a.get("id") or ""): a for a in _load_agents()}
    except Exception:
        agent_map = {}

    try:
        _, pipeline_def = _find_file(pipeline_id)
    except Exception:
        pipeline_def = {"id": pipeline_id, "steps": [], "canvas": {}}

    rubric = _collect_pipeline_rubric_catalog(pipeline_def, agent_map, db)
    score_catalog = rubric.get("score_sections") or []
    violation_catalog = rubric.get("violation_types") or []

    safe_limit = max(100, min(limit, 20000))
    effective_from = str(event_from or run_from or "").strip()
    effective_to = str(event_to or run_to or "").strip()
    from_dt = None
    to_dt_exclusive = None
    if effective_from:
        try:
            from_dt = datetime.fromisoformat(effective_from[:10] + "T00:00:00")
        except Exception:
            raise HTTPException(400, "Invalid event_from date. Use YYYY-MM-DD.")
    if effective_to:
        try:
            to_dt_exclusive = datetime.fromisoformat(effective_to[:10] + "T00:00:00") + timedelta(days=1)
        except Exception:
            raise HTTPException(400, "Invalid event_to date. Use YYYY-MM-DD.")

    def _parse_dt(value: Any) -> Optional[datetime]:
        if value is None:
            return None
        if isinstance(value, datetime):
            dt = value
        else:
            s = str(value).strip()
            if not s:
                return None
            if s.endswith("Z"):
                s = s[:-1] + "+00:00"
            try:
                dt = datetime.fromisoformat(s)
            except Exception:
                try:
                    dt = datetime.fromisoformat(s[:10] + "T00:00:00")
                except Exception:
                    return None
        if dt.tzinfo is not None:
            dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
        return dt

    def _has_specific_call_id(v: Any) -> bool:
        s = str(v or "").strip().lower()
        if not s:
            return False
        if s in {"pair", "merged", "all", "none", "null"}:
            return False
        if s.startswith("pipeline:"):
            return False
        return True

    stmt = select(PR).where(PR.pipeline_id == pipeline_id)
    if sales_agent:
        stmt = stmt.where(PR.sales_agent == sales_agent)
    if customer:
        stmt = stmt.where(PR.customer == customer)
    if call_id is not None:
        stmt = stmt.where(PR.call_id == call_id)
    # Date filtering is applied after call-date resolution (event time), so we
    # fetch a larger window when date filters are active.
    fetch_limit = min(50000, safe_limit * (5 if (from_dt is not None or to_dt_exclusive is not None) else 1))
    stmt = stmt.order_by(PR.started_at.desc()).limit(fetch_limit)
    runs = db.exec(stmt).all()
    run_event_meta: dict[str, dict[str, Any]] = {}

    # Resolve per-call event timestamps from CRM call dates when available.
    call_date_by_key: dict[str, datetime] = {}
    call_ids = sorted({
        str(getattr(r, "call_id", "") or "").strip().lower()
        for r in runs
        if _has_specific_call_id(getattr(r, "call_id", ""))
    })
    if call_ids:
        try:
            from ui.backend.models.crm import CRMCall
            call_stmt = select(CRMCall.agent, CRMCall.customer, CRMCall.call_id, CRMCall.started_at).where(
                _sql_func.lower(CRMCall.call_id).in_(call_ids)
            )
            if sales_agent:
                call_stmt = call_stmt.where(_sql_func.lower(CRMCall.agent) == sales_agent.strip().lower())
            if customer:
                call_stmt = call_stmt.where(_sql_func.lower(CRMCall.customer) == customer.strip().lower())
            for row in db.exec(call_stmt).all():
                try:
                    agent_v, customer_v, call_id_v, started_v = row[0], row[1], row[2], row[3]
                except Exception:
                    continue
                cdt = _parse_dt(started_v)
                if cdt is None:
                    continue
                key = (
                    f"{str(agent_v or '').strip().lower()}::"
                    f"{str(customer_v or '').strip().lower()}::"
                    f"{str(call_id_v or '').strip().lower()}"
                )
                prev = call_date_by_key.get(key)
                if prev is None or cdt > prev:
                    call_date_by_key[key] = cdt
        except Exception:
            # Fallback silently to run started_at when CRM call dates are unavailable.
            call_date_by_key = {}

    filtered_runs: list[Any] = []
    for run in runs:
        rid = str(getattr(run, "id", "") or "")
        run_started_dt = _parse_dt(getattr(run, "started_at", None))
        call_id_raw = str(getattr(run, "call_id", "") or "").strip()
        event_dt = run_started_dt
        event_source = "run_started_at"
        if _has_specific_call_id(call_id_raw):
            key = (
                f"{str(getattr(run, 'sales_agent', '') or '').strip().lower()}::"
                f"{str(getattr(run, 'customer', '') or '').strip().lower()}::"
                f"{call_id_raw.lower()}"
            )
            call_dt = call_date_by_key.get(key)
            if call_dt is not None:
                event_dt = call_dt
                event_source = "crm_call.started_at"
        if event_dt is None:
            continue
        if from_dt is not None and event_dt < from_dt:
            continue
        if to_dt_exclusive is not None and event_dt >= to_dt_exclusive:
            continue
        filtered_runs.append(run)
        run_event_meta[rid] = {
            "event_dt": event_dt,
            "event_at": event_dt.isoformat(),
            "event_source": event_source,
            "call_id": call_id_raw,
        }

    filtered_runs.sort(
        key=lambda r: run_event_meta.get(str(getattr(r, "id", "") or ""), {}).get("event_dt", datetime.min),
        reverse=True,
    )
    if len(filtered_runs) > safe_limit:
        filtered_runs = filtered_runs[:safe_limit]
        run_event_meta = {
            str(getattr(r, "id", "") or ""): run_event_meta.get(str(getattr(r, "id", "") or ""), {})
            for r in filtered_runs
        }
    # Deep-dive metrics should aggregate across all matching runs in the date range.
    # Do not dedupe by source/call here.

    _rows_unused, _score_unused, _viol_unused, run_summaries = _collect_metrics_for_runs(
        runs=filtered_runs,
        agent_map=agent_map,
        score_catalog=score_catalog,
        violation_catalog=violation_catalog,
    )
    for rs in run_summaries:
        meta = run_event_meta.get(str(rs.get("run_id") or ""), {})
        rs["event_at"] = str(meta.get("event_at") or rs.get("started_at") or "")
        rs["event_source"] = str(meta.get("event_source") or "run_started_at")
        rs["call_id"] = str(meta.get("call_id") or "")

    pair_buckets: dict[str, dict[str, Any]] = {}
    for rs in run_summaries:
        sa = str(rs.get("sales_agent") or "")
        cu = str(rs.get("customer") or "")
        if not (sa and cu):
            continue
        key = f"{sa}::{cu}"
        bucket = pair_buckets.setdefault(key, {
            "sales_agent": sa,
            "customer": cu,
            "run_count": 0,
            "run_avg_scores": [],
            "total_violations": 0,
            "score_by_section_values": {},
            "violation_by_type": {},
            "latest_run_at": "",
        })
        bucket["run_count"] += 1
        if isinstance(rs.get("run_avg_score"), (int, float)):
            bucket["run_avg_scores"].append(float(rs["run_avg_score"]))
        bucket["total_violations"] += int(rs.get("run_total_violations") or 0)
        event_at = str(rs.get("event_at") or rs.get("started_at") or "")
        if event_at > bucket["latest_run_at"]:
            bucket["latest_run_at"] = event_at

        score_map = rs.get("score_by_section") if isinstance(rs.get("score_by_section"), dict) else {}
        for sec, val in score_map.items():
            sec_key = _canonical_metric_name(
                str(sec),
                _build_catalog_lookup(score_catalog, kind="score"),
                kind="score",
            )
            bucket["score_by_section_values"].setdefault(sec_key, []).append(float(val))

        viol_map = rs.get("violations_by_type") if isinstance(rs.get("violations_by_type"), dict) else {}
        for vtype, cnt in viol_map.items():
            v_key = _canonical_metric_name(
                str(vtype),
                _build_catalog_lookup(violation_catalog, kind="violation"),
                kind="violation",
            )
            bucket["violation_by_type"][v_key] = bucket["violation_by_type"].get(v_key, 0) + int(cnt or 0)

    pairs_out: list[dict] = []
    for pb in pair_buckets.values():
        score_by_section = {
            sec: (round(sum(vals) / len(vals), 2) if vals else 0.0)
            for sec, vals in pb["score_by_section_values"].items()
        }
        for sec in score_catalog:
            score_by_section.setdefault(sec, 0.0)

        violations_by_type = {str(k): int(v or 0) for k, v in pb["violation_by_type"].items()}
        for vtype in violation_catalog:
            violations_by_type.setdefault(vtype, 0)

        run_count = int(pb["run_count"] or 0)
        total_violations = int(pb["total_violations"] or 0)
        avg_score_all_sections = (
            round(sum(pb["run_avg_scores"]) / len(pb["run_avg_scores"]), 2)
            if pb["run_avg_scores"] else None
        )
        pairs_out.append({
            "sales_agent": pb["sales_agent"],
            "customer": pb["customer"],
            "run_count": run_count,
            "avg_score_all_sections": avg_score_all_sections,
            "total_violations": total_violations,
            "avg_violations_per_run": (
                round(total_violations / run_count, 2)
                if run_count else None
            ),
            "score_by_section": score_by_section,
            "violations_by_type": violations_by_type,
            "latest_run_at": pb["latest_run_at"] or None,
        })
    pairs_out.sort(key=lambda x: (str(x["sales_agent"]).lower(), str(x["customer"]).lower()))

    agent_buckets: dict[str, dict[str, Any]] = {}
    for pair in pairs_out:
        sa = str(pair.get("sales_agent") or "")
        if not sa:
            continue
        ab = agent_buckets.setdefault(sa, {
            "sales_agent": sa,
            "customer_set": set(),
            "run_count": 0,
            "run_avg_scores": [],
            "total_violations": 0,
            "score_by_section_values": {},
            "violation_by_type": {},
        })
        ab["customer_set"].add(str(pair.get("customer") or ""))
        ab["run_count"] += int(pair.get("run_count") or 0)
        if isinstance(pair.get("avg_score_all_sections"), (int, float)):
            for _ in range(int(pair.get("run_count") or 0)):
                ab["run_avg_scores"].append(float(pair["avg_score_all_sections"]))
        ab["total_violations"] += int(pair.get("total_violations") or 0)

        score_map = pair.get("score_by_section") if isinstance(pair.get("score_by_section"), dict) else {}
        for sec, val in score_map.items():
            ab["score_by_section_values"].setdefault(str(sec), []).append(float(val))

        viol_map = pair.get("violations_by_type") if isinstance(pair.get("violations_by_type"), dict) else {}
        for vtype, cnt in viol_map.items():
            ab["violation_by_type"][str(vtype)] = ab["violation_by_type"].get(str(vtype), 0) + int(cnt or 0)

    agents_out: list[dict] = []
    for ab in agent_buckets.values():
        customers = sorted([c for c in ab["customer_set"] if c])
        score_by_section = {
            sec: (round(sum(vals) / len(vals), 2) if vals else 0.0)
            for sec, vals in ab["score_by_section_values"].items()
        }
        for sec in score_catalog:
            score_by_section.setdefault(sec, 0.0)

        violations_by_type = {str(k): int(v or 0) for k, v in ab["violation_by_type"].items()}
        for vtype in violation_catalog:
            violations_by_type.setdefault(vtype, 0)

        run_count = int(ab["run_count"] or 0)
        total_violations = int(ab["total_violations"] or 0)
        agents_out.append({
            "sales_agent": ab["sales_agent"],
            "customer_count": len(customers),
            "customers": customers,
            "run_count": run_count,
            "avg_score_all_sections": (
                round(sum(ab["run_avg_scores"]) / len(ab["run_avg_scores"]), 2)
                if ab["run_avg_scores"] else None
            ),
            "total_violations": total_violations,
            "avg_violations_per_run": (
                round(total_violations / run_count, 2)
                if run_count else None
            ),
            "avg_violations_per_customer": (
                round(total_violations / len(customers), 2)
                if customers else None
            ),
            "score_by_section": score_by_section,
            "violations_by_type": violations_by_type,
        })
    agents_out.sort(key=lambda x: str(x["sales_agent"]).lower())

    return {
        "pipeline_id": pipeline_id,
        "pipeline_name": filtered_runs[0].pipeline_name if filtered_runs else "",
        "run_count": len(filtered_runs),
        "run_from": effective_from,
        "run_to": effective_to,
        "event_from": effective_from,
        "event_to": effective_to,
        "score_sections": score_catalog,
        "violation_types": violation_catalog,
        "pairs": pairs_out,
        "agents": agents_out,
        "rubric": rubric,
    }


@router.get("/{pipeline_id}/state")
def get_pipeline_state(
    pipeline_id: str,
    sales_agent: str = Query(""),
    customer: str = Query(""),
):
    """Return the live run state for a pipeline+pair from the state file.
    The file is keyed by a hash of (pipeline_id, sales_agent, customer) so
    no string comparison filter is needed — the path IS the filter."""
    path = _STATE_DIR / f"{_pair_key(pipeline_id, sales_agent, customer)}.json"
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        steps = data.get("steps")
        if isinstance(steps, list):
            dirty = False
            for step in steps:
                if not isinstance(step, dict):
                    continue
                if step.get("content") or step.get("thinking"):
                    step["content"] = ""
                    step["thinking"] = ""
                    dirty = True
                sources = step.get("input_sources")
                if isinstance(sources, list):
                    for src in sources:
                        if isinstance(src, dict) and src.get("source") == "chain_previous":
                            src["source"] = "artifact_output"
                            dirty = True
            if dirty:
                path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        return data
    except Exception:
        return None


@router.get("/live-webhook/config")
def get_live_webhook_config(request: Request):
    profile = _require_can_view(request)
    can_manage_live = bool((profile.get("permissions") or {}).get("can_manage_live_jobs"))
    if _is_live_mirror_mode(request):
        mirrored = _live_mirror_request_json("GET", "/api/pipelines/live-webhook/config", request=request)
        if isinstance(mirrored, dict):
            mirrored["read_only"] = True
            mirrored["mirror_source"] = str(settings.live_mirror_base_url or "").strip()
            mirrored["effective_read_only"] = True
            mirrored["state_source"] = "live-mirror-api"
            mirrored["user_permissions"] = profile.get("permissions") or {}
        return mirrored
    cfg = _load_live_webhook_config()
    try:
        from ui.backend.routers import webhooks as _wh

        stats = _wh._get_rejected_webhook_stats()
    except Exception:
        stats = _load_live_webhook_stats()
    return {
        "enabled": bool(cfg.get("enabled", True)),
        "ingest_only": bool(cfg.get("ingest_only", True)),
        "trigger_pipeline": bool(cfg.get("trigger_pipeline", True)),
        "agent_continuity_filter_enabled": bool(cfg.get("agent_continuity_filter_enabled", True)),
        "agent_continuity_pair_tag_fallback_enabled": bool(
            cfg.get("agent_continuity_pair_tag_fallback_enabled", True)
        ),
        "agent_continuity_reject_multi_agent_pair_tags": bool(
            cfg.get("agent_continuity_reject_multi_agent_pair_tags", True)
        ),
        "live_pipeline_ids": cfg.get("live_pipeline_ids") if isinstance(cfg.get("live_pipeline_ids"), list) else [],
        "send_note_pipeline_ids": (
            cfg.get("send_note_pipeline_ids") if isinstance(cfg.get("send_note_pipeline_ids"), list) else []
        ),
        "default_pipeline_id": str(cfg.get("default_pipeline_id") or "").strip(),
        "pipeline_by_agent": cfg.get("pipeline_by_agent") if isinstance(cfg.get("pipeline_by_agent"), dict) else {},
        "run_payload": cfg.get("run_payload") if isinstance(cfg.get("run_payload"), dict) else {},
        "transcription_model": str(cfg.get("transcription_model") or "gpt-5.4"),
        "transcription_timeout_s": int(cfg.get("transcription_timeout_s") or 900),
        "transcription_poll_interval_s": float(cfg.get("transcription_poll_interval_s") or 2.0),
        "backfill_historical_transcripts": bool(cfg.get("backfill_historical_transcripts", True)),
        "backfill_timeout_s": int(cfg.get("backfill_timeout_s") or 5400),
        "max_live_running": int(cfg.get("max_live_running") or 5),
        "agent_continuity_filter_enabled": bool(cfg.get("agent_continuity_filter_enabled", True)),
        "auto_retry_enabled": bool(cfg.get("auto_retry_enabled", True)),
        "retry_max_attempts": int(cfg.get("retry_max_attempts") or 2),
        "retry_delay_s": int(cfg.get("retry_delay_s") or 45),
        "retry_on_server_error": bool(cfg.get("retry_on_server_error", True)),
        "retry_on_rate_limit": bool(cfg.get("retry_on_rate_limit", True)),
        "retry_on_timeout": bool(cfg.get("retry_on_timeout", True)),
        "rejected_webhooks_total": int(stats.get("rejected_webhooks_total") or 0),
        "rejected_by_reason": (
            stats.get("rejected_by_reason") if isinstance(stats.get("rejected_by_reason"), dict) else {}
        ),
        "rejected_updated_at": str(stats.get("updated_at") or ""),
        "read_only": bool((not can_manage_live) or _is_live_state_read_only(request)),
        "effective_read_only": bool((not can_manage_live) or _is_live_state_read_only(request)),
        "state_source": "shared-db" if bool(getattr(settings, "live_state_use_db", True)) else "local-file",
        "user_permissions": profile.get("permissions") or {},
    }


@router.get("/live-webhook/rejections")
def get_live_webhook_rejections(
    request: Request,
    limit: int = Query(20000, ge=1, le=20000),
    status: str = Query("all"),
    include_payload: int = Query(0),
):
    _require_can_view(request)
    status_norm = str(status or "all").strip().lower() or "all"
    include_payload_flag = bool(include_payload)
    if _is_live_mirror_mode(request):
        path = (
            f"/api/pipelines/live-webhook/rejections"
            f"?limit={int(limit)}&status={status_norm}&include_payload={1 if include_payload_flag else 0}"
        )
        return _live_mirror_request_json("GET", path, request=request)
    from ui.backend.routers import webhooks as _wh

    include_non_rejected = status_norm == "all"
    all_items = _wh._list_rejected_webhooks(
        limit=20000,
        include_non_rejected=include_non_rejected,
        include_archive=True,
    )
    if status_norm != "all":
        all_items = [
            it for it in all_items
            if str((it or {}).get("status") or "").strip().lower() == status_norm
        ]
    if not include_payload_flag:
        compact_items: list[dict[str, Any]] = []
        for row in all_items:
            if not isinstance(row, dict):
                continue
            out = dict(row)
            payload = out.get("payload")
            out["payload_present"] = isinstance(payload, dict)
            out.pop("payload", None)
            compact_items.append(out)
        all_items = compact_items
    total_count = len(all_items)
    items = all_items[: int(limit)]
    return {
        "ok": True,
        "count": total_count,
        "returned_count": len(items),
        "total_count": total_count,
        "items": items,
    }


@router.get("/live-webhook/rejections/{rejection_id}")
def get_live_webhook_rejection(
    rejection_id: str,
    request: Request,
    include_payload: int = Query(1),
):
    _require_can_view(request)
    rid = str(rejection_id or "").strip()
    if not rid:
        raise HTTPException(status_code=400, detail="Missing rejection id.")
    include_payload_flag = bool(include_payload)
    if _is_live_mirror_mode(request):
        path = (
            f"/api/pipelines/live-webhook/rejections/{rid}"
            f"?include_payload={1 if include_payload_flag else 0}"
        )
        return _live_mirror_request_json("GET", path, request=request)

    from ui.backend.routers import webhooks as _wh

    row, _row_source = _wh._find_rejected_webhook(rid, include_archive=True)
    if row is None:
        raise HTTPException(status_code=404, detail=f"Rejected webhook not found: {rid}")
    out = dict(row)
    payload = out.get("payload")
    out["payload_present"] = isinstance(payload, dict)
    if not include_payload_flag:
        out.pop("payload", None)
    return {"ok": True, "item": out}


@router.post("/live-webhook/rejections/{rejection_id}/enqueue")
async def enqueue_live_webhook_rejection(
    rejection_id: str,
    req: LiveWebhookRejectionEnqueueIn,
    request: Request,
):
    _require_can_manage_live(request)
    if _is_live_state_read_only(request):
        raise HTTPException(status_code=403, detail="Live webhook rejections are read-only in this environment.")

    rid = str(rejection_id or "").strip()
    if not rid:
        raise HTTPException(status_code=400, detail="Missing rejection id.")

    from ui.backend.routers import webhooks as _wh

    row, _row_source = _wh._find_rejected_webhook(rid, include_archive=True)
    if row is None:
        raise HTTPException(status_code=404, detail="Rejected webhook record not found.")

    cfg = _wh._load_call_ended_config()
    payload = row.get("payload") if isinstance(row.get("payload"), dict) else {}
    sales_agent = str(row.get("sales_agent") or payload.get("agent") or payload.get("sales_agent") or "").strip()
    customer = str(row.get("customer") or payload.get("customer") or "").strip()
    call_id = str(row.get("call_id") or payload.get("call_id") or "").strip()
    account_id = str(row.get("account_id") or payload.get("account_id") or "").strip()
    crm_url = str(row.get("crm_url") or payload.get("crm_url") or "").strip()
    if not (sales_agent and customer and call_id):
        raise HTTPException(status_code=400, detail="Rejected record is missing agent/customer/call context.")

    requested_pipeline_id = str(req.pipeline_id or "").strip()
    pipeline_ids: list[str] = []
    if requested_pipeline_id:
        pipeline_ids = [requested_pipeline_id]
    else:
        stored_pipeline_ids = row.get("pipeline_ids") if isinstance(row.get("pipeline_ids"), list) else []
        clean_stored = [str(x or "").strip() for x in stored_pipeline_ids if str(x or "").strip()]
        if clean_stored:
            pipeline_ids = clean_stored if bool(req.run_all) else [clean_stored[0]]
        else:
            live_ids = _resolve_live_pipeline_ids(cfg)
            if live_ids:
                pipeline_ids = live_ids if bool(req.run_all) else [live_ids[0]]
            else:
                mapped = _wh._resolve_pipeline_id(cfg, sales_agent, sales_agent)
                if mapped:
                    pipeline_ids = [mapped]
    if not pipeline_ids:
        raise HTTPException(status_code=400, detail="No pipeline resolved for rejected webhook replay.")

    now_iso = datetime.now(timezone.utc).isoformat()
    cfg_run_payload = cfg.get("run_payload") if isinstance(cfg.get("run_payload"), dict) else {}
    run_ids: list[str] = []
    results: list[dict[str, Any]] = []
    for pipeline_id in pipeline_ids:
        _wh._assert_pipeline_exists(pipeline_id)
        _, pdef = _find_file(pipeline_id)
        pipeline_name = str(pdef.get("name") or pipeline_id)
        run_id = str(uuid.uuid4())
        run_payload: dict[str, Any] = {
            "sales_agent": sales_agent,
            "customer": customer,
            "call_id": call_id,
            "resume_partial": True,
            "run_origin": "webhook",
            "run_id": run_id,
        }
        for k, v in cfg_run_payload.items():
            run_payload[str(k)] = v
        queue_item = {
            "id": str(uuid.uuid4()),
            "event_id": str(row.get("event_id") or ""),
            "event_file": str(row.get("event_file") or ""),
            "webhook_type": "rejected-replay",
            "created_at": now_iso,
            "updated_at": now_iso,
            "state": "queued",
            "attempts": 0,
            "max_attempts": int(cfg.get("retry_max_attempts") or 2),
            "next_attempt_at": now_iso,
            "last_error": "",
            "request_base_url": str(request.base_url or ""),
            "pipeline_id": pipeline_id,
            "pipeline_name": pipeline_name,
            "run_id": run_id,
            "sales_agent": sales_agent,
            "customer": customer,
            "call_id": call_id,
            "pair": {
                "crm_url": crm_url,
                "account_id": account_id,
                "agent": sales_agent,
                "customer": customer,
            },
            "payload": run_payload,
            "record_path": str(payload.get("record_path") or ""),
            "manual_replay": True,
            "rejection_id": rid,
        }
        created, meta = await _wh._enqueue_live_item(queue_item)
        if created:
            _wh._upsert_pipeline_run_stub(
                run_id=run_id,
                pipeline_id=pipeline_id,
                pipeline_name=pipeline_name,
                sales_agent=sales_agent,
                customer=customer,
                call_id=call_id,
                status="queued",
                log_line=f"Queued manually from rejected webhook ({rid[:8]})",
            )
            run_ids.append(run_id)
        meta_run_id = str(meta.get("run_id") or run_id)
        if meta_run_id and meta_run_id not in run_ids:
            run_ids.append(meta_run_id)
        results.append(
            {
                "pipeline_id": pipeline_id,
                "pipeline_name": pipeline_name,
                "run_id": meta_run_id,
                "state": str(meta.get("state") or ("queued" if created else "queued")),
                "message": str(meta.get("message") or ""),
                "created": bool(created),
            }
        )

    _wh._mark_rejection_queued_manual(rid, run_ids, pipeline_ids)
    # Keep a single long-lived dispatcher loop. Spawning a one-shot dispatch
    # task per manual action can saturate workers during bulk operations.
    _wh.ensure_live_dispatcher_started()

    return {
        "ok": True,
        "rejection_id": rid,
        "run_ids": run_ids,
        "pipelines": results,
    }


@router.post("/live-webhook/runs/{run_id}/enqueue")
async def enqueue_live_webhook_run(
    run_id: str,
    req: LiveWebhookRunEnqueueIn,
    request: Request,
    db: Session = Depends(get_session),
):
    _require_can_manage_live(request)
    if _is_live_state_read_only(request):
        raise HTTPException(status_code=403, detail="Live webhook queue is read-only in this environment.")

    source_run_id = str(run_id or "").strip()
    if not source_run_id:
        raise HTTPException(status_code=400, detail="Missing run id.")

    from ui.backend.models.pipeline_run import PipelineRun as PR
    from ui.backend.routers import webhooks as _wh

    src = db.get(PR, source_run_id)
    if not src:
        raise HTTPException(status_code=404, detail="Run not found.")

    pipeline_id = str(req.pipeline_id or src.pipeline_id or "").strip()
    if not pipeline_id:
        raise HTTPException(status_code=400, detail="No pipeline id resolved from source run.")
    _, pdef = _find_file(pipeline_id)
    pipeline_name = str(pdef.get("name") or src.pipeline_name or pipeline_id)

    sales_agent = str(src.sales_agent or "").strip()
    customer = str(src.customer or "").strip()
    call_id = str(src.call_id or "").strip()
    if not (sales_agent and customer):
        raise HTTPException(status_code=400, detail="Source run missing agent/customer context.")

    cfg = _load_live_webhook_config()
    queued_at = datetime.now(timezone.utc).isoformat()
    new_run_id = str(uuid.uuid4())
    run_payload: dict[str, Any] = {
        "sales_agent": sales_agent,
        "customer": customer,
        "call_id": call_id,
        "resume_partial": True,
        "run_origin": "webhook",
        "run_id": new_run_id,
        "manual_replay": True,
        "source_run_id": source_run_id,
    }
    cfg_run_payload = cfg.get("run_payload")
    if isinstance(cfg_run_payload, dict):
        for k, v in cfg_run_payload.items():
            run_payload[str(k)] = v

    queue_item = {
        "id": str(uuid.uuid4()),
        "event_id": "",
        "event_file": "",
        "webhook_type": "failed-replay",
        "created_at": queued_at,
        "updated_at": queued_at,
        "state": "queued",
        "attempts": 0,
        "max_attempts": int(cfg.get("retry_max_attempts") or 2),
        "next_attempt_at": queued_at,
        "last_error": "",
        "request_base_url": str(request.base_url or ""),
        "pipeline_id": pipeline_id,
        "pipeline_name": pipeline_name,
        "run_id": new_run_id,
        "sales_agent": sales_agent,
        "customer": customer,
        "call_id": call_id,
        "pair": _wh._pair_from_names(sales_agent, customer),
        "payload": run_payload,
        "manual_replay": True,
        "source_run_id": source_run_id,
    }

    created, meta = await _wh._enqueue_live_item(queue_item)
    effective_run_id = str(meta.get("run_id") or new_run_id)
    if created:
        _wh._upsert_pipeline_run_stub(
            run_id=effective_run_id,
            pipeline_id=pipeline_id,
            pipeline_name=pipeline_name,
            sales_agent=sales_agent,
            customer=customer,
            call_id=call_id,
            status="queued",
            log_line=f"Queued manually from failed run replay ({source_run_id[:8]})",
        )

    # Keep a single long-lived dispatcher loop. Spawning a one-shot dispatch
    # task per manual action can saturate workers during bulk operations.
    _wh.ensure_live_dispatcher_started()

    return {
        "ok": True,
        "source_run_id": source_run_id,
        "run_id": effective_run_id,
        "pipeline_id": pipeline_id,
        "pipeline_name": pipeline_name,
        "state": str(meta.get("state") or ("queued" if created else "")),
        "deduplicated": (not created),
        "message": str(meta.get("message") or ""),
    }


@router.post("/live-webhook/runs/{run_id}/cancel")
async def cancel_live_webhook_run(
    run_id: str,
    req: LiveWebhookRunCancelIn,
    request: Request,
    db: Session = Depends(get_session),
):
    _require_can_manage_live(request)
    if _is_live_state_read_only(request):
        raise HTTPException(status_code=403, detail="Live webhook queue is read-only in this environment.")

    rid = str(run_id or "").strip()
    if not rid:
        raise HTTPException(status_code=400, detail="Missing run id.")

    from ui.backend.models.pipeline_run import PipelineRun as PR
    from ui.backend.routers import webhooks as _wh

    reason = str(req.reason or "Cancelled by user.").strip() or "Cancelled by user."
    row = db.get(PR, rid)

    now_iso = datetime.now(timezone.utc).isoformat()
    queue_found = False
    queue_prev_state = ""
    queue_changed = False
    async with _wh._LIVE_QUEUE_LOCK:
        queue = _wh._load_live_queue()
        for item in queue:
            if not isinstance(item, dict):
                continue
            if str(item.get("run_id") or "").strip() != rid:
                continue
            queue_found = True
            queue_prev_state = str(item.get("state") or "").strip().lower()
            if queue_prev_state != "cancelled":
                item["state"] = "cancelled"
                item["updated_at"] = now_iso
                item["next_attempt_at"] = now_iso
                item["last_error"] = reason
                queue_changed = True
            break
        if queue_changed:
            _wh._save_live_queue(queue)

    cancelled_task = False
    slot = ""
    if row is not None:
        slot = _run_slot_key(
            str(row.pipeline_id or ""),
            str(row.sales_agent or ""),
            str(row.customer or ""),
            str(row.call_id or ""),
        )
        with _ACTIVE_RUN_LOCK:
            ev = _STOP_REQUESTED.get(slot)
            if ev:
                ev.set()
            task = _ACTIVE_RUN_TASKS.get(slot)
        if task and not task.done():
            task.cancel()
            cancelled_task = True

        _wh._upsert_pipeline_run_stub(
            run_id=rid,
            pipeline_id=str(row.pipeline_id or ""),
            pipeline_name=str(row.pipeline_name or row.pipeline_id or ""),
            sales_agent=str(row.sales_agent or ""),
            customer=str(row.customer or ""),
            call_id=str(row.call_id or ""),
            status="cancelled",
            log_line=f"Cancelled by user: {reason[:300]}",
        )
    elif queue_found:
        # Keep a visible history row even when DB row was not created yet.
        _wh._upsert_pipeline_run_stub(
            run_id=rid,
            pipeline_id="",
            pipeline_name="",
            sales_agent="",
            customer="",
            call_id="",
            status="cancelled",
            log_line=f"Cancelled from queue by user: {reason[:300]}",
        )

    # Keep a single long-lived dispatcher loop. Spawning a one-shot dispatch
    # task per manual action can saturate workers during bulk operations.
    _wh.ensure_live_dispatcher_started()

    return {
        "ok": True,
        "run_id": rid,
        "queue_found": queue_found,
        "queue_prev_state": queue_prev_state,
        "queue_updated": queue_changed,
        "cancelled_task": cancelled_task,
        "slot": slot,
        "reason": reason,
    }


@router.post("/live-webhook/runs/{run_id}/retry")
async def retry_live_webhook_run(
    run_id: str,
    req: LiveWebhookRunRetryIn,
    request: Request,
    db: Session = Depends(get_session),
):
    _require_can_manage_live(request)
    if _is_live_state_read_only(request):
        raise HTTPException(status_code=403, detail="Live webhook queue is read-only in this environment.")

    rid = str(run_id or "").strip()
    if not rid:
        raise HTTPException(status_code=400, detail="Missing run id.")

    from ui.backend.models.pipeline_run import PipelineRun as PR
    from ui.backend.routers import webhooks as _wh

    row = db.get(PR, rid)
    if row is None:
        raise HTTPException(status_code=404, detail="Run not found.")

    now_iso = datetime.now(timezone.utc).isoformat()
    queue_found = False
    queue_changed = False
    queue_prev_state = ""
    async with _wh._LIVE_QUEUE_LOCK:
        queue = _wh._load_live_queue()
        for item in queue:
            if not isinstance(item, dict):
                continue
            if str(item.get("run_id") or "").strip() != rid:
                continue
            queue_found = True
            queue_prev_state = str(item.get("state") or "").strip().lower()
            if queue_prev_state in {"running", "preparing"}:
                raise HTTPException(
                    status_code=409,
                    detail=f"Run is currently {queue_prev_state}; cancel it first before retrying.",
                )
            if queue_prev_state != "queued":
                item["state"] = "queued"
                item["updated_at"] = now_iso
                item["next_attempt_at"] = now_iso
                if not str(item.get("last_error") or "").strip():
                    item["last_error"] = "Manual retry requested."
                queue_changed = True
            break
        if queue_changed:
            _wh._save_live_queue(queue)

    pipeline_id = str(req.pipeline_id or row.pipeline_id or "").strip()
    if not pipeline_id:
        raise HTTPException(status_code=400, detail="No pipeline id resolved for retry.")
    _, pdef = _find_file(pipeline_id)
    pipeline_name = str(pdef.get("name") or row.pipeline_name or pipeline_id)
    sales_agent = str(row.sales_agent or "").strip()
    customer = str(row.customer or "").strip()
    call_id = str(row.call_id or "").strip()

    cfg = _load_live_webhook_config()
    created = False
    meta: dict[str, Any] = {}
    if not queue_found:
        run_payload: dict[str, Any] = {
            "sales_agent": sales_agent,
            "customer": customer,
            "call_id": call_id,
            "resume_partial": True,
            "run_origin": "webhook",
            "run_id": rid,
            "manual_replay": True,
            "source_run_id": rid,
        }
        cfg_run_payload = cfg.get("run_payload")
        if isinstance(cfg_run_payload, dict):
            for k, v in cfg_run_payload.items():
                run_payload[str(k)] = v

        queue_item = {
            "id": str(uuid.uuid4()),
            "event_id": "",
            "event_file": "",
            "webhook_type": "failed-retry",
            "created_at": now_iso,
            "updated_at": now_iso,
            "state": "queued",
            "attempts": 0,
            "max_attempts": int(cfg.get("retry_max_attempts") or 2),
            "next_attempt_at": now_iso,
            "last_error": "Manual retry requested.",
            "request_base_url": str(request.base_url or ""),
            "pipeline_id": pipeline_id,
            "pipeline_name": pipeline_name,
            "run_id": rid,
            "sales_agent": sales_agent,
            "customer": customer,
            "call_id": call_id,
            "pair": _wh._pair_from_names(sales_agent, customer),
            "payload": run_payload,
            "manual_replay": True,
            "source_run_id": rid,
        }
        created, meta = await _wh._enqueue_live_item(queue_item)
    else:
        meta = {
            "run_id": rid,
            "state": "queued",
            "message": "Moved to run queue.",
        }

    _wh._upsert_pipeline_run_stub(
        run_id=rid,
        pipeline_id=pipeline_id,
        pipeline_name=pipeline_name,
        sales_agent=sales_agent,
        customer=customer,
        call_id=call_id,
        status="queued",
        log_line=(
            "Manual retry requested; moved to run queue."
            if queue_found
            else "Manual retry requested; queued for dispatch."
        ),
    )

    # Keep a single long-lived dispatcher loop. Spawning a one-shot dispatch
    # task per manual action can saturate workers during bulk operations.
    _wh.ensure_live_dispatcher_started()

    return {
        "ok": True,
        "run_id": str(meta.get("run_id") or rid),
        "pipeline_id": pipeline_id,
        "pipeline_name": pipeline_name,
        "queue_found": queue_found,
        "queue_prev_state": queue_prev_state,
        "queue_updated": queue_changed,
        "created_queue_item": bool(created),
        "state": str(meta.get("state") or ("queued" if (queue_found or created) else "")),
        "deduplicated": (not created and not queue_found),
        "message": str(meta.get("message") or ""),
    }


@router.put("/live-webhook/config")
def set_live_webhook_config(req: LiveWebhookConfigIn, request: Request):
    _require_can_manage_live(request)
    if _is_live_state_read_only(request):
        raise HTTPException(status_code=403, detail="Live webhook config is read-only in this environment.")
    incoming = req.model_dump()
    incoming["default_pipeline_id"] = str(incoming.get("default_pipeline_id") or "").strip()
    raw_live_ids = incoming.get("live_pipeline_ids")
    live_ids = [str(v or "").strip() for v in raw_live_ids] if isinstance(raw_live_ids, list) else []
    incoming["live_pipeline_ids"] = [pid for pid in live_ids if pid]
    raw_send_note_ids = incoming.get("send_note_pipeline_ids")
    send_note_ids = [str(v or "").strip() for v in raw_send_note_ids] if isinstance(raw_send_note_ids, list) else []
    incoming["send_note_pipeline_ids"] = [pid for pid in send_note_ids if pid]

    default_pid = str(incoming.get("default_pipeline_id") or "").strip()
    if default_pid:
        _find_file(default_pid)
    for pid in incoming.get("live_pipeline_ids", []):
        _find_file(pid)
    for pid in incoming.get("send_note_pipeline_ids", []):
        _find_file(pid)

    mapping = incoming.get("pipeline_by_agent")
    if isinstance(mapping, dict):
        for _agent, pid in list(mapping.items()):
            pid_s = str(pid or "").strip()
            if not pid_s:
                continue
            _find_file(pid_s)

    cfg = _load_live_webhook_config()
    cfg.update(incoming)
    saved = _save_live_webhook_config(cfg)
    return {
        "ok": True,
        "config": {
            "enabled": bool(saved.get("enabled", True)),
            "ingest_only": bool(saved.get("ingest_only", True)),
            "trigger_pipeline": bool(saved.get("trigger_pipeline", True)),
            "agent_continuity_filter_enabled": bool(saved.get("agent_continuity_filter_enabled", True)),
            "agent_continuity_pair_tag_fallback_enabled": bool(
                saved.get("agent_continuity_pair_tag_fallback_enabled", True)
            ),
            "agent_continuity_reject_multi_agent_pair_tags": bool(
                saved.get("agent_continuity_reject_multi_agent_pair_tags", True)
            ),
            "live_pipeline_ids": saved.get("live_pipeline_ids") if isinstance(saved.get("live_pipeline_ids"), list) else [],
            "send_note_pipeline_ids": (
                saved.get("send_note_pipeline_ids") if isinstance(saved.get("send_note_pipeline_ids"), list) else []
            ),
            "default_pipeline_id": str(saved.get("default_pipeline_id") or "").strip(),
            "pipeline_by_agent": (
                saved.get("pipeline_by_agent") if isinstance(saved.get("pipeline_by_agent"), dict) else {}
            ),
            "run_payload": saved.get("run_payload") if isinstance(saved.get("run_payload"), dict) else {},
            "transcription_model": str(saved.get("transcription_model") or "gpt-5.4"),
            "transcription_timeout_s": int(saved.get("transcription_timeout_s") or 900),
            "transcription_poll_interval_s": float(saved.get("transcription_poll_interval_s") or 2.0),
            "backfill_historical_transcripts": bool(saved.get("backfill_historical_transcripts", True)),
            "backfill_timeout_s": int(saved.get("backfill_timeout_s") or 5400),
            "max_live_running": int(saved.get("max_live_running") or 5),
            "agent_continuity_filter_enabled": bool(saved.get("agent_continuity_filter_enabled", True)),
            "auto_retry_enabled": bool(saved.get("auto_retry_enabled", True)),
            "retry_max_attempts": int(saved.get("retry_max_attempts") or 2),
            "retry_delay_s": int(saved.get("retry_delay_s") or 45),
            "retry_on_server_error": bool(saved.get("retry_on_server_error", True)),
            "retry_on_rate_limit": bool(saved.get("retry_on_rate_limit", True)),
            "retry_on_timeout": bool(saved.get("retry_on_timeout", True)),
        },
    }


@router.put("/live-webhook/quick-set")
def quick_set_live_webhook(req: LiveWebhookQuickSetIn, request: Request):
    _require_can_manage_live(request)
    if _is_live_state_read_only(request):
        raise HTTPException(status_code=403, detail="Live webhook config is read-only in this environment.")
    pipeline_id = str(req.pipeline_id or "").strip()
    if req.enabled and not pipeline_id:
        raise HTTPException(status_code=400, detail="pipeline_id is required when enabling live webhook execution.")
    if pipeline_id:
        _find_file(pipeline_id)

    cfg = _load_live_webhook_config()
    cfg["enabled"] = bool(req.enabled)
    cfg["trigger_pipeline"] = True
    cfg["ingest_only"] = not bool(req.enabled)
    cfg["default_pipeline_id"] = pipeline_id if req.enabled else ""
    cfg["live_pipeline_ids"] = [pipeline_id] if (req.enabled and pipeline_id) else []

    if bool(req.listen_all_webhooks) and bool(req.clear_agent_mappings):
        cfg["pipeline_by_agent"] = {}

    run_payload = cfg.get("run_payload")
    if not isinstance(run_payload, dict):
        run_payload = {}
    run_payload.setdefault("resume_partial", True)
    cfg["run_payload"] = run_payload

    saved = _save_live_webhook_config(cfg)
    return {
        "ok": True,
        "message": (
            f"Live webhook enabled for all calls using pipeline {pipeline_id}"
            if req.enabled
            else "Live webhook disabled (ingest-only mode)."
        ),
        "config": {
            "enabled": bool(saved.get("enabled", True)),
            "ingest_only": bool(saved.get("ingest_only", True)),
            "trigger_pipeline": bool(saved.get("trigger_pipeline", True)),
            "agent_continuity_filter_enabled": bool(saved.get("agent_continuity_filter_enabled", True)),
            "agent_continuity_pair_tag_fallback_enabled": bool(
                saved.get("agent_continuity_pair_tag_fallback_enabled", True)
            ),
            "agent_continuity_reject_multi_agent_pair_tags": bool(
                saved.get("agent_continuity_reject_multi_agent_pair_tags", True)
            ),
            "live_pipeline_ids": saved.get("live_pipeline_ids") if isinstance(saved.get("live_pipeline_ids"), list) else [],
            "send_note_pipeline_ids": (
                saved.get("send_note_pipeline_ids") if isinstance(saved.get("send_note_pipeline_ids"), list) else []
            ),
            "default_pipeline_id": str(saved.get("default_pipeline_id") or "").strip(),
            "pipeline_by_agent": (
                saved.get("pipeline_by_agent") if isinstance(saved.get("pipeline_by_agent"), dict) else {}
            ),
            "run_payload": saved.get("run_payload") if isinstance(saved.get("run_payload"), dict) else {},
            "transcription_model": str(saved.get("transcription_model") or "gpt-5.4"),
            "transcription_timeout_s": int(saved.get("transcription_timeout_s") or 900),
            "transcription_poll_interval_s": float(saved.get("transcription_poll_interval_s") or 2.0),
            "backfill_historical_transcripts": bool(saved.get("backfill_historical_transcripts", True)),
            "backfill_timeout_s": int(saved.get("backfill_timeout_s") or 5400),
            "max_live_running": int(saved.get("max_live_running") or 5),
            "auto_retry_enabled": bool(saved.get("auto_retry_enabled", True)),
            "retry_max_attempts": int(saved.get("retry_max_attempts") or 2),
            "retry_delay_s": int(saved.get("retry_delay_s") or 45),
            "retry_on_server_error": bool(saved.get("retry_on_server_error", True)),
            "retry_on_rate_limit": bool(saved.get("retry_on_rate_limit", True)),
            "retry_on_timeout": bool(saved.get("retry_on_timeout", True)),
        },
    }


@router.get("/live-webhook/rejections")
def list_live_webhook_rejections(
    request: Request,
    limit: int = Query(20000, ge=1, le=20000),
    status: str = Query("all"),
    include_payload: int = Query(0),
):
    _require_can_view(request)
    status_norm = str(status or "all").strip().lower() or "all"
    include_payload_flag = bool(include_payload)
    if _is_live_mirror_mode(request):
        path = (
            f"/api/pipelines/live-webhook/rejections"
            f"?limit={int(limit)}&status={status_norm}&include_payload={1 if include_payload_flag else 0}"
        )
        return _live_mirror_request_json("GET", path, request=request)

    from ui.backend.routers import webhooks as _wh

    wanted_status = status_norm
    include_non_rejected = wanted_status == "all"
    all_items = _wh._list_rejected_webhooks(
        limit=20000,
        include_non_rejected=include_non_rejected,
        include_archive=True,
    )
    if not include_non_rejected:
        all_items = [
            row for row in all_items
            if str((row or {}).get("status") or "rejected").strip().lower() == wanted_status
        ]
    if not include_payload_flag:
        compact_items: list[dict[str, Any]] = []
        for row in all_items:
            if not isinstance(row, dict):
                continue
            out = dict(row)
            payload = out.get("payload")
            out["payload_present"] = isinstance(payload, dict)
            out.pop("payload", None)
            compact_items.append(out)
        all_items = compact_items
    total_count = len(all_items)
    items = all_items[: int(limit)]
    return {
        "ok": True,
        "count": total_count,
        "returned_count": len(items),
        "total_count": total_count,
        "items": items,
    }


@router.post("/live-webhook/rejections/{rejection_id}/enqueue")
async def enqueue_live_webhook_rejection(
    rejection_id: str,
    req: LiveWebhookRejectionEnqueueIn,
    request: Request,
):
    _require_can_manage_live(request)
    if _is_live_state_read_only(request):
        raise HTTPException(status_code=403, detail="Live webhook requeue is read-only in this environment.")

    from ui.backend.routers import webhooks as _wh

    rid = str(rejection_id or "").strip()
    if not rid:
        raise HTTPException(status_code=400, detail="Missing rejection_id.")

    row, _row_source = _wh._find_rejected_webhook(rid, include_archive=True)
    if not row:
        raise HTTPException(status_code=404, detail=f"Rejected webhook not found: {rid}")

    target_pipeline_ids: list[str] = []
    if bool(req.run_all):
        raw = row.get("pipeline_ids")
        if isinstance(raw, list):
            target_pipeline_ids.extend([str(x or "").strip() for x in raw if str(x or "").strip()])
    requested_pipeline_id = str(req.pipeline_id or "").strip()
    if requested_pipeline_id:
        target_pipeline_ids.append(requested_pipeline_id)
    if not target_pipeline_ids:
        raw = row.get("pipeline_ids")
        if isinstance(raw, list):
            target_pipeline_ids.extend([str(x or "").strip() for x in raw if str(x or "").strip()])
    if not target_pipeline_ids:
        cfg = _load_live_webhook_config()
        live_ids = cfg.get("live_pipeline_ids")
        if isinstance(live_ids, list):
            target_pipeline_ids.extend([str(x or "").strip() for x in live_ids if str(x or "").strip()])
        default_pid = str(cfg.get("default_pipeline_id") or "").strip()
        if default_pid:
            target_pipeline_ids.append(default_pid)

    dedup_ids: list[str] = []
    seen: set[str] = set()
    for pid in target_pipeline_ids:
        p = str(pid or "").strip()
        if not p or p in seen:
            continue
        _find_file(p)
        seen.add(p)
        dedup_ids.append(p)
    target_pipeline_ids = dedup_ids
    if not target_pipeline_ids:
        raise HTTPException(status_code=400, detail="No target pipeline id was resolved for this rejection.")

    pair = row.get("pair") if isinstance(row.get("pair"), dict) else {}
    raw_payload = row.get("payload") if isinstance(row.get("payload"), dict) else {}
    sales_agent = str(row.get("sales_agent") or pair.get("agent") or raw_payload.get("agent") or "").strip()
    customer = str(row.get("customer") or pair.get("customer") or raw_payload.get("customer") or "").strip()
    call_id = str(row.get("call_id") or raw_payload.get("call_id") or "").strip()
    pair_data = {
        "crm_url": str(pair.get("crm_url") or raw_payload.get("crm_url") or ""),
        "account_id": str(pair.get("account_id") or raw_payload.get("account_id") or ""),
        "agent": sales_agent,
        "customer": customer,
    }

    cfg = _load_live_webhook_config()
    max_attempts = int(cfg.get("retry_max_attempts") or 2)
    queued_at = datetime.now(timezone.utc).isoformat()
    pipelines_out: list[dict[str, Any]] = []
    run_ids: list[str] = []
    request_base_url = str(request.base_url or "")

    for pipeline_id in target_pipeline_ids:
        _, pdef = _find_file(pipeline_id)
        pipeline_name = str(pdef.get("name") or pipeline_id)
        run_id = str(uuid.uuid4())
        run_payload = {
            "sales_agent": sales_agent,
            "customer": customer,
            "call_id": call_id,
            "resume_partial": True,
            "run_origin": "webhook",
            "run_id": run_id,
            "manual_replay": True,
            "rejection_id": rid,
        }
        queue_item = {
            "id": str(uuid.uuid4()),
            "webhook_type": "rejected-replay",
            "created_at": queued_at,
            "updated_at": queued_at,
            "state": "queued",
            "attempts": 0,
            "max_attempts": max_attempts,
            "next_attempt_at": queued_at,
            "last_error": "",
            "request_base_url": request_base_url,
            "pipeline_id": pipeline_id,
            "pipeline_name": pipeline_name,
            "run_id": run_id,
            "sales_agent": sales_agent,
            "customer": customer,
            "call_id": call_id,
            "pair": pair_data,
            "payload": run_payload,
            "event_id": str(row.get("event_id") or ""),
            "event_file": str(row.get("event_file") or ""),
            "manual_replay": True,
            "rejection_id": rid,
        }
        created, meta = await _wh._enqueue_live_item(queue_item)
        effective_run_id = str(meta.get("run_id") or run_id)
        if created:
            _wh._upsert_pipeline_run_stub(
                run_id=effective_run_id,
                pipeline_id=pipeline_id,
                pipeline_name=pipeline_name,
                sales_agent=sales_agent,
                customer=customer,
                call_id=call_id,
                status="queued",
                log_line="Queued from rejected webhook replay.",
            )
        pipelines_out.append(
            {
                "pipeline_id": pipeline_id,
                "pipeline_name": pipeline_name,
                "run_id": effective_run_id,
                "state": str(meta.get("state") or ("queued" if created else "")),
                "message": str(meta.get("message") or ""),
                "deduplicated": (not created),
            }
        )
        if effective_run_id:
            run_ids.append(effective_run_id)

    _wh._mark_rejection_queued_manual(rid, run_ids, target_pipeline_ids)
    # Keep a single long-lived dispatcher loop. Spawning a one-shot dispatch
    # task per manual action can saturate workers during bulk operations.
    _wh.ensure_live_dispatcher_started()

    return {
        "ok": True,
        "rejection_id": rid,
        "pipeline_count": len(pipelines_out),
        "run_ids": run_ids,
        "pipelines": pipelines_out,
    }


@router.get("/{pipeline_id}/live-webhook/wait")
async def wait_for_live_webhook(
    pipeline_id: str,
    request: Request,
    sales_agent: str = Query(""),
    customer: str = Query(""),
    call_id: str = Query(""),
    after_ms: int = Query(0, ge=0),
    timeout_s: float = Query(45.0, ge=1.0, le=90.0),
):
    """Long-poll for next webhook payload matching the current pipeline context."""
    profile = _require_can_view(request)
    _, pdef = _find_file(pipeline_id)  # validate pipeline exists
    if not _can_access_pipeline_record(profile, pdef):
        raise HTTPException(status_code=404, detail="Pipeline not found.")

    wanted_agent = str(sales_agent or "").strip()
    wanted_customer = str(customer or "").strip()
    wanted_call_id = str(call_id or "").strip()

    cursor_ms = int(after_ms or 0)
    deadline = time.time() + float(timeout_s)
    poll_interval_s = 0.75

    while True:
        evt = _find_latest_matching_webhook_event(
            after_ms=cursor_ms,
            sales_agent=wanted_agent,
            customer=wanted_customer,
            call_id=wanted_call_id,
        )
        if evt:
            evt_ms = int(evt.get("received_ms") or 0)
            return {
                "ok": True,
                "triggered": True,
                "pipeline_id": pipeline_id,
                "cursor_ms": evt_ms or cursor_ms,
                "event": evt,
            }

        if time.time() >= deadline:
            return {
                "ok": True,
                "triggered": False,
                "pipeline_id": pipeline_id,
                "cursor_ms": cursor_ms,
                "timeout": True,
            }
        await asyncio.sleep(poll_interval_s)


@router.post("/{pipeline_id}/run")
async def run_pipeline(
    pipeline_id: str,
    req: PipelineRunRequest,
    request: Request,
    db: Session = Depends(get_session),
):
    """Execute a pipeline step-by-step, streaming SSE events."""
    profile = _require_can_run_pipeline(request)
    _, pdef = _find_file(pipeline_id)
    if not _can_access_pipeline_record(profile, pdef):
        raise HTTPException(status_code=404, detail="Pipeline not found.")
    from ui.backend.models.agent_result import AgentResult as AR
    from ui.backend.models.note import Note
    from ui.backend.models.pipeline_artifact import PipelineArtifact as PA
    from ui.backend.models.pipeline_run import PipelineRun as PR
    from ui.backend.models.persona import Persona
    from ui.backend.routers.universal_agents import (
        _sse, _is_file_source, _resolve_input,
        _llm_call_with_files, _llm_call_anthropic_files_streaming,
        _resolve_provider_file_refs,
        _load_all as _load_agents,
    )

    _, pipeline_def = _find_file(pipeline_id)
    steps = pipeline_def.get("steps", [])
    agent_map: dict[str, dict] = {a["id"]: a for a in _load_agents()}

    requested_call_id = str(req.call_id or "").strip()
    effective_call_id = str(req.context_call_id or "").strip() or requested_call_id
    run_slot = _run_slot_key(pipeline_id, req.sales_agent, req.customer, effective_call_id)
    client_local_time = request.headers.get("x-client-local-time", "")
    client_timezone = request.headers.get("x-client-timezone", "")

    def _apply_output_postprocess(
        *,
        raw_output: str,
        agent_def: dict[str, Any],
        step_model: str,
        previous_content: str,
        db_session: Optional[Session] = None,
    ) -> str:
        content = str(raw_output or "")
        mode = _normalize_output_response_mode(agent_def.get("output_response_mode"))
        target = _normalize_output_target_type(agent_def.get("output_target_type"))
        if mode == "wrap":
            return _wrap_agent_output(content, target)
        if mode == "custom_format":
            return _apply_custom_output_template(
                template=str(agent_def.get("output_template") or ""),
                response=content,
                previous_response=str(previous_content or ""),
                placeholder=str(agent_def.get("output_placeholder") or "response"),
                previous_placeholder=str(agent_def.get("output_previous_placeholder") or "previous_response"),
            )
        if mode != "transform" or target == "raw_text":
            return content

        transform_system = (
            "You convert raw AI output into a requested final format.\n"
            "Rules:\n"
            "- Preserve meaning and facts.\n"
            "- Do not invent data.\n"
            "- Return only the final transformed output.\n"
        )
        target_rule = {
            "json": "Return valid JSON only.",
            "markdown": "Return clean Markdown with clear headings and sections.",
        }.get(target, "Return plain text.")
        transform_user = (
            "TARGET_TYPE: {target_type}\n"
            "RULE: {target_rule}\n\n"
            "RAW_OUTPUT:\n{raw_output}\n\n"
            "Transform now."
        )

        own_session = False
        _db = db_session
        if _db is None:
            _db = Session(_db_engine)
            own_session = True
        try:
            transformed, _ = _llm_call_with_files(
                transform_system,
                transform_user,
                {},
                {
                    "target_type": target,
                    "target_rule": target_rule,
                    "raw_output": content,
                },
                step_model or "gpt-5.4",
                0.0,
                _db,
            )
            out = str(transformed or "").strip()
            if not out:
                return _wrap_agent_output(content, target)
            if target == "json":
                try:
                    parsed = json.loads(out)
                    return json.dumps(parsed, ensure_ascii=False, indent=2)
                except Exception:
                    return _wrap_agent_output(content, "json")
            return out
        except Exception:
            return _wrap_agent_output(content, target)
        finally:
            if own_session and _db is not None:
                _db.close()

    async def stream():
        pipeline_name = pipeline_def.get("name", "pipeline")
        input_scope_call_id = effective_call_id
        cid_short = f"…{input_scope_call_id[-8:]}" if input_scope_call_id else "pair"
        _requested_origin = str(req.run_origin or "").strip().lower()
        if _requested_origin in {"webhook", "production"}:
            run_origin = "webhook"
        elif _requested_origin in {"local", "test"}:
            run_origin = "local"
        else:
            run_origin = "local"

        # ── Create history run record ────────────────────────────────────────
        recent = log_buffer.get_recent(1)
        start_seq = recent[-1].seq if recent else 0

        requested_run_id = str(req.run_id or "").strip()
        run_id = requested_run_id or str(uuid.uuid4())
        run_start_dt = datetime.utcnow().isoformat()
        existing_run_row = None
        if requested_run_id:
            try:
                with Session(_db_engine) as _s:
                    existing_run_row = _s.get(PR, requested_run_id)
            except Exception:
                existing_run_row = None
        execution_session_id = execution_logs.start_session(
            action="pipeline_run",
            source="backend",
            context={
                "pipeline_id": pipeline_id,
                "pipeline_name": pipeline_name,
                "run_slot": run_slot,
                "sales_agent": req.sales_agent,
                "customer": req.customer,
                "call_id": input_scope_call_id,
                "requested_run_id": requested_run_id,
                "force": bool(req.force),
                "force_step_indices": [int(i) for i in (req.force_step_indices or [])],
                "resume_partial": bool(req.resume_partial),
                "execute_step_indices": [int(i) for i in (req.execute_step_indices or [])],
                "prepare_input_only": bool(req.prepare_input_only),
            },
            client_local_time=client_local_time,
            client_timezone=client_timezone,
            status="running",
        )
        execution_logs.append_event(
            execution_session_id,
            f"Pipeline run started: {pipeline_name}",
            level="stage",
            status="running",
            data={
                "run_id": run_id,
                "steps_total": len(steps),
                "input_scope_call_id": input_scope_call_id,
            },
            client_local_time=client_local_time,
        )
        execution_logs.append_event(
            execution_session_id,
            f"Run origin: {run_origin}",
            level="info",
            status="running",
            data={"run_origin": run_origin},
            client_local_time=client_local_time,
        )
        if input_scope_call_id and input_scope_call_id != requested_call_id:
            log_buffer.emit(f"[PIPELINE] ℹ Input scope call context: {input_scope_call_id} · {cid_short}")
        _default_run_steps = [
            {
                "agent_id":         s.get("agent_id", ""),
                "agent_name":       "",
                "model":            "",
                "state":            "waiting",
                "start_time":       None,
                "end_time":         None,
                "cached_locations": [],
                "content":          "",
                "error_msg":        "",
                "execution_time_s": None,
                "input_token_est":  0,
                "output_token_est": 0,
                "thinking":         "",
                "model_info":       {},
                "request_raw":      {},
                "response_raw":     "",
                "input_sources":    [],
                "input_fingerprint": "",
                "input_ready":      False,
                "cache_mode":       "",
                "note_id":          "",
                "note_call_id":     "",
                "run_origin":       run_origin,
            }
            for s in steps
        ]
        run_steps = _default_run_steps
        if existing_run_row and (existing_run_row.steps_json or "").strip():
            try:
                _parsed = json.loads(existing_run_row.steps_json or "[]")
                if isinstance(_parsed, list) and len(_parsed) == len(_default_run_steps):
                    run_steps = []
                    for _idx, _base in enumerate(_default_run_steps):
                        _row = _parsed[_idx] if _idx < len(_parsed) and isinstance(_parsed[_idx], dict) else {}
                        _merged = dict(_base)
                        _merged.update(_row or {})
                        # Keep agent_id aligned to current pipeline step definition.
                        _merged["agent_id"] = _base.get("agent_id", "")
                        _merged["run_origin"] = _base.get("run_origin", run_origin)
                        run_steps.append(_merged)
            except Exception:
                run_steps = _default_run_steps

        with Session(_db_engine) as _s:
            if existing_run_row:
                _row = _s.get(PR, run_id)
                if _row is None:
                    existing_run_row = None
                else:
                    # This run_id is being reused for a new attempt (manual retry /
                    # resumed webhook execution). Reset timing baseline so UI shows
                    # fresh "started" and duration for this attempt.
                    _row.started_at = datetime.utcnow()
                    _row.pipeline_id = pipeline_id
                    _row.pipeline_name = pipeline_name
                    _row.sales_agent = req.sales_agent
                    _row.customer = req.customer
                    _row.call_id = input_scope_call_id
                    _row.status = "running"
                    _row.run_origin = run_origin
                    _row.note_sent = False
                    _row.note_sent_at = None
                    _row.canvas_json = json.dumps(pipeline_def.get("canvas", {}))
                    _row.steps_json = json.dumps(run_steps)
                    _row.log_json = ""
                    _row.finished_at = None
                    _s.add(_row)
            if not existing_run_row:
                run_record = PR(
                    id=run_id,
                    pipeline_id=pipeline_id,
                    pipeline_name=pipeline_name,
                    sales_agent=req.sales_agent,
                    customer=req.customer,
                    call_id=input_scope_call_id,
                    status="running",
                    run_origin=run_origin,
                    canvas_json=json.dumps(pipeline_def.get("canvas", {})),
                    steps_json=json.dumps(run_steps),
                )
                _s.add(run_record)
            _s.commit()

        yield _sse(
            "execution_session",
            {"execution_session_id": execution_session_id, "run_id": run_id},
        )

        _agent_result_has_pipeline_cache = _agent_result_supports_pipeline_cache(_db_engine)
        if not _agent_result_has_pipeline_cache:
            log_buffer.emit(
                "[PIPELINE] ⚠ agent_result schema is legacy (missing pipeline cache columns); "
                "using legacy cache mode"
            )
        # Write initial state file (all steps waiting) so frontend can find it immediately.
        # force=True so a new run always claims the file even if an old run still owns it.
        _save_state(pipeline_id, run_id, req.sales_agent, req.customer, "running", run_steps,
                    force=True, start_datetime=run_start_dt)

        run_final_status = "error"
        execution_error_msg = ""
        loop = asyncio.get_event_loop()
        prev_content = ""
        LLM_TIMEOUT_S = 600.0
        cancel_state = {"reason": "run cancelled (client disconnected or server interrupted)"}

        with _ACTIVE_RUN_LOCK:
            _STOP_REQUESTED[run_slot] = threading.Event()
            _ACTIVE_RUN_TASKS[run_slot] = asyncio.current_task()

        def _is_stop_requested() -> bool:
            with _ACTIVE_RUN_LOCK:
                ev = _STOP_REQUESTED.get(run_slot)
            return bool(ev and ev.is_set())

        def _raise_if_stop_requested() -> None:
            if _is_stop_requested():
                cancel_state["reason"] = "run stopped by user"
                raise asyncio.CancelledError()

        _proc_node_id_by_step_idx: dict[int, str] = {}
        _output_node_to_step_idx: dict[str, int] = {}
        _input_node_to_step_idxs: dict[str, list[int]] = {}
        _input_node_ids: list[str] = []
        _output_node_ids: list[str] = []
        _step_output_meta: dict[int, dict[str, str]] = {}
        _artifact_ctx: dict[str, Optional[str]] = {"latest_persona_id": None}

        def _step_status_to_ui(_s: dict) -> str:
            raw = str(_s.get("state") or _s.get("status") or "waiting").strip().lower()
            if raw in ("input_prepared", "prepared"):
                return "pending"
            if raw in ("cancelled", "canceled", "aborted", "stopped"):
                return "cancelled"
            if raw in ("failed", "error"):
                return "error"
            if raw in ("running", "loading"):
                return "loading"
            if raw in ("completed", "done"):
                return "cached" if (_s.get("cached_locations") or []) else "done"
            return "pending"

        def _step_input_status(_s: dict) -> str:
            raw = str(_s.get("state") or _s.get("status") or "waiting").strip().lower()
            if raw in ("input_prepared", "prepared"):
                return "done" if _s.get("input_ready") else "pending"
            if raw in ("cancelled", "canceled", "aborted", "stopped"):
                return "cancelled"
            if raw in ("failed", "error"):
                return "error"
            if raw in ("running", "loading"):
                return "done" if _s.get("input_ready") else "loading"
            if raw in ("completed", "done"):
                return "cached" if (_s.get("cached_locations") or []) else "done"
            return "pending"

        def _build_node_states() -> dict:
            processing: dict[str, str] = {}
            output: dict[str, str] = {}
            input_nodes: dict[str, str] = {}

            for _step_idx, _node_id in _proc_node_id_by_step_idx.items():
                if _step_idx >= len(run_steps) or not _node_id:
                    continue
                processing[_node_id] = _step_status_to_ui(run_steps[_step_idx])

            for _node_id in _output_node_ids:
                _step_idx = _output_node_to_step_idx.get(_node_id)
                if _step_idx is None or _step_idx >= len(run_steps):
                    output[_node_id] = "pending"
                    continue
                _st = _step_status_to_ui(run_steps[_step_idx])
                output[_node_id] = "pending" if _st == "loading" else _st

            for _node_id in _input_node_ids:
                _step_idxs = _input_node_to_step_idxs.get(_node_id, [])
                if not _step_idxs:
                    input_nodes[_node_id] = "pending"
                    continue
                _statuses = [
                    _step_input_status(run_steps[_i])
                    for _i in _step_idxs
                    if 0 <= _i < len(run_steps)
                ]
                if any(_s == "error" for _s in _statuses):
                    input_nodes[_node_id] = "error"
                elif any(_s == "cancelled" for _s in _statuses):
                    input_nodes[_node_id] = "cancelled"
                elif any(_s == "done" for _s in _statuses):
                    input_nodes[_node_id] = "done"
                elif any(_s == "cached" for _s in _statuses):
                    input_nodes[_node_id] = "cached"
                elif any(_s == "loading" for _s in _statuses):
                    input_nodes[_node_id] = "loading"
                else:
                    input_nodes[_node_id] = "pending"

            return {
                "input": input_nodes,
                "processing": processing,
                "output": output,
            }

        _last_log_snapshot_ts = 0.0

        def _persist_run_log_snapshot(force: bool = False) -> None:
            """Persist in-flight pipeline logs so UI keeps live context across refresh/navigation."""
            nonlocal _last_log_snapshot_ts
            try:
                now_m = time.monotonic()
                if (not force) and (now_m - _last_log_snapshot_ts < 1.5):
                    return
                _last_log_snapshot_ts = now_m
                _lines = [
                    {"ts": l.ts, "text": l.text, "level": l.level}
                    for l in log_buffer.get_after(start_seq)
                ]
                with Session(_db_engine) as _s:
                    _s.execute(
                        _sql_text("UPDATE pipeline_run SET log_json = :log_json WHERE id = :id"),
                        {"log_json": json.dumps(_lines[-400:]), "id": run_id},
                    )
                    _s.commit()
            except Exception:
                pass

        def save_steps():
            """Persist current step states — writes both the DB and the live state file.
            Always written with status='running'; the state file is only promoted to
            'pass'/'failed' on completion/error. On stream disconnect, it stays
            'running' with the last known step snapshot for UI restore."""
            try:
                with Session(_db_engine) as _s:
                    _s.execute(
                        _sql_text("UPDATE pipeline_run SET steps_json = :steps_json WHERE id = :id"),
                        {"steps_json": json.dumps(run_steps), "id": run_id},
                    )
                    _s.commit()
            except Exception:
                    pass
            _persist_run_log_snapshot()
            _save_state(
                pipeline_id, run_id, req.sales_agent, req.customer, "running", run_steps,
                start_datetime=run_start_dt, node_states=_build_node_states(),
            )

        def _normalize_overrides_for_step(
            _step_idx: int, _agent_def: dict, _overrides: dict
        ) -> dict:
            """Normalize overrides for artifact-like inputs based on canvas output wiring."""
            _norm = dict(_overrides or {})
            _artifact_src = _incoming_output_src_by_step_idx.get(_step_idx)
            if not _artifact_src:
                return _norm
            for _inp in (_agent_def.get("inputs", []) or []):
                _k = _inp.get("key", "")
                _default_src = str(_inp.get("source", ""))
                if _default_src in ("chain_previous", "artifact_output") or _default_src.startswith("artifact_"):
                    _norm[_k] = _artifact_src
            return _norm

        def _public_input_source(_source: str) -> str:
            # Keep legacy compatibility internally but avoid surfacing chain_previous.
            return "artifact_output" if _source == "chain_previous" else _source

        def _lookup_step_cache(
            _sess: Session,
            _agent_id: str,
            _step_idx: int,
            _input_fingerprint: str,
        ) -> tuple[Optional[Any], bool]:
            """Return (cached_row, used_resume_partial_fallback)."""
            def _legacy_lookup_latest() -> Optional[Any]:
                _sql = (
                    "SELECT id, content, created_at "
                    "FROM agent_result "
                    "WHERE agent_id = :agent_id "
                    "AND LOWER(sales_agent) = LOWER(:sales_agent) "
                    "AND LOWER(customer) = LOWER(:customer) "
                )
                _params = {
                    "agent_id": _agent_id,
                    "sales_agent": req.sales_agent or "",
                    "customer": req.customer or "",
                }
                if input_scope_call_id:
                    _sql += "AND call_id = :call_id "
                    _params["call_id"] = input_scope_call_id
                else:
                    _sql += "AND call_id = '' "
                _sql += "ORDER BY created_at DESC LIMIT 1"
                _row = _sess.execute(_sql_text(_sql), _params).first()
                if not _row:
                    return None
                _m = getattr(_row, "_mapping", _row)
                if hasattr(_m, "get"):
                    return _SimpleNamespace(
                        id=_m.get("id"),
                        content=_m.get("content", ""),
                        created_at=_m.get("created_at"),
                    )
                return None

            if not _agent_result_has_pipeline_cache:
                _legacy = _legacy_lookup_latest()
                if _legacy:
                    return _legacy, bool(req.resume_partial)
                return None, False

            _base = select(AR).where(
                AR.agent_id == _agent_id,
                _sql_func.lower(AR.sales_agent) == (req.sales_agent or "").lower(),
                _sql_func.lower(AR.customer) == (req.customer or "").lower(),
            )
            if _agent_result_has_pipeline_cache:
                _base = _base.where(
                    AR.pipeline_id == pipeline_id,
                    AR.pipeline_step_index == _step_idx,
                )
            if input_scope_call_id:
                _base = _base.where(AR.call_id == input_scope_call_id)
            else:
                _base = _base.where(AR.call_id == "")

            _exact = _base
            if _agent_result_has_pipeline_cache:
                _exact = _exact.where(AR.input_fingerprint == _input_fingerprint)
            _exact = _exact.order_by(AR.created_at.desc())
            _cached = _sess.exec(_exact).first()
            if _cached:
                return _cached, False

            # Resume-partial mode: if exact fingerprint misses, reuse the latest
            # cached artifact for this pipeline step in the current context.
            if req.resume_partial and _agent_result_has_pipeline_cache:
                _fallback = _sess.exec(_base.order_by(AR.created_at.desc())).first()
                if _fallback:
                    return _fallback, True
            return None, False

        def _lookup_step_cache_resume_only(
            _sess: Session,
            _agent_id: str,
            _step_idx: int,
        ) -> Optional[Any]:
            """Best-effort step cache lookup for resume mode before input-resolution."""
            if not _agent_result_has_pipeline_cache:
                _sql = (
                    "SELECT id, content, created_at "
                    "FROM agent_result "
                    "WHERE agent_id = :agent_id "
                    "AND LOWER(sales_agent) = LOWER(:sales_agent) "
                    "AND LOWER(customer) = LOWER(:customer) "
                )
                _params = {
                    "agent_id": _agent_id,
                    "sales_agent": req.sales_agent or "",
                    "customer": req.customer or "",
                }
                if input_scope_call_id:
                    _sql += "AND call_id = :call_id "
                    _params["call_id"] = input_scope_call_id
                else:
                    _sql += "AND call_id = '' "
                _sql += "ORDER BY created_at DESC LIMIT 1"
                _row = _sess.execute(_sql_text(_sql), _params).first()
                if not _row:
                    return None
                _m = getattr(_row, "_mapping", _row)
                if hasattr(_m, "get"):
                    return _SimpleNamespace(
                        id=_m.get("id"),
                        content=_m.get("content", ""),
                        created_at=_m.get("created_at"),
                    )
                return None

            _base = select(AR).where(
                AR.agent_id == _agent_id,
                _sql_func.lower(AR.sales_agent) == (req.sales_agent or "").lower(),
                _sql_func.lower(AR.customer) == (req.customer or "").lower(),
            )
            if _agent_result_has_pipeline_cache:
                _base = _base.where(
                    AR.pipeline_id == pipeline_id,
                    AR.pipeline_step_index == _step_idx,
                )
            if input_scope_call_id:
                _base = _base.where(AR.call_id == input_scope_call_id)
            else:
                _base = _base.where(AR.call_id == "")
            return _sess.exec(_base.order_by(AR.created_at.desc())).first()

        def _has_call_transcript(_call_id: str) -> bool:
            if not _call_id:
                return False
            _llm = settings.agents_dir / req.sales_agent / req.customer / _call_id / "transcribed" / "llm_final"
            return (_llm / "smoothed.txt").exists() or (_llm / "voted.txt").exists()

        def _pair_has_any_transcript() -> bool:
            _pair_dir = settings.agents_dir / req.sales_agent / req.customer
            if not _pair_dir.exists():
                return False
            for _call_dir in _pair_dir.iterdir():
                if not _call_dir.is_dir() or _call_dir.name.startswith("."):
                    continue
                _llm = _call_dir / "transcribed" / "llm_final"
                if (_llm / "smoothed.txt").exists() or (_llm / "voted.txt").exists():
                    return True
                _final = _call_dir / "transcribed" / "final"
                if _final.exists() and any(_final.iterdir()):
                    return True
            return False

        def _collect_missing_transcript_requirements() -> tuple[bool, set[str]]:
            _needs_merged = False
            _missing_call_ids: set[str] = set()
            for _step_idx, _step in enumerate(steps):
                _aid = _step.get("agent_id", "")
                _adef = agent_map.get(_aid)
                if not _adef:
                    continue
                _ov = _normalize_overrides_for_step(
                    _step_idx, _adef, _step.get("input_overrides", {})
                )
                for _inp in (_adef.get("inputs", []) or []):
                    _k = _inp.get("key", "")
                    _src = _public_input_source(
                        _ov.get(_k, _inp.get("source", "manual"))
                    )
                    if _src == "transcript":
                        if input_scope_call_id:
                            if not _has_call_transcript(input_scope_call_id):
                                _missing_call_ids.add(input_scope_call_id)
                        elif not _pair_has_any_transcript():
                            _needs_merged = True
                    elif _src == "merged_transcript":
                        if not _pair_has_any_transcript():
                            _needs_merged = True
            return _needs_merged, _missing_call_ids

        async def _wait_for_jobs(
            _job_ids: list[str],
            _timeout_s: int = 5400,
        ) -> tuple[bool, int]:
            from ui.backend.models.job import Job, JobStatus

            def _job_status_text(_value: Any) -> str:
                _raw = getattr(_value, "value", _value)
                return str(_raw or "").strip().lower()

            _ids = list(dict.fromkeys([str(_j) for _j in _job_ids if str(_j)]))
            if not _ids:
                return True, 0

            _deadline = time.monotonic() + max(30, int(_timeout_s))
            _last_log = 0.0
            while True:
                _raise_if_stop_requested()
                with Session(_db_engine) as _s:
                    _rows = _s.exec(
                        select(Job).where(Job.id.in_(_ids))
                    ).all()
                _status_by_id = {str(_r.id): _job_status_text(_r.status) for _r in _rows}
                _done = sum(
                    1 for _i in _ids
                    if _status_by_id.get(_i) in ("complete", "failed")
                )
                _failed = sum(
                    1 for _i in _ids
                    if _status_by_id.get(_i) == "failed"
                )
                if _done >= len(_ids):
                    return _failed == 0, _failed
                if time.monotonic() - _last_log >= 5.0:
                    _last_log = time.monotonic()
                    log_buffer.emit(
                        f"[PIPELINE] … auto-transcription running ({_done}/{len(_ids)} complete) · {cid_short}"
                    )
                    _persist_run_log_snapshot(force=True)
                if time.monotonic() >= _deadline:
                    return False, _failed
                await asyncio.sleep(2.0)

        async def _ensure_transcripts_ready_for_run() -> None:
            from ui.backend.models.crm import CRMPair
            from ui.backend.models.job import Job, JobStatus
            from ui.backend.routers.transcription_process import (
                BatchPairsRequest, PairSpec, batch_transcribe_pairs,
            )
            from ui.backend.services.crm_service import (
                _auto_detect_re_aliases as _crm_auto_detect_re_aliases,
                _load_aliases as _crm_load_aliases,
            )

            _needs_merged, _missing_call_ids = _collect_missing_transcript_requirements()
            if not _needs_merged and not _missing_call_ids:
                return

            if not req.sales_agent or not req.customer:
                raise RuntimeError(
                    "Pipeline requires transcript inputs but sales_agent/customer context is missing."
                )

            yield_msg = (
                f"Missing transcript inputs detected "
                f"({'call' if _missing_call_ids else 'merged'}). Starting auto-transcription…"
            )
            log_buffer.emit(f"[PIPELINE] ⏳ {yield_msg} · {cid_short}")
            execution_logs.append_event(
                execution_session_id,
                yield_msg,
                level="stage",
                status="running",
                data={
                    "missing_call_ids": sorted(_missing_call_ids),
                    "needs_merged_transcript": bool(_needs_merged),
                },
            )
            _persist_run_log_snapshot(force=True)
            yield _sse("progress", {"msg": yield_msg})

            _file_aliases = _crm_load_aliases()
            _auto_aliases = _crm_auto_detect_re_aliases([req.sales_agent])
            _all_aliases = {**_auto_aliases, **_file_aliases}
            _alias_names = [a for a, p in _all_aliases.items() if p == req.sales_agent]
            _agent_names = list(dict.fromkeys([req.sales_agent] + _alias_names))

            with Session(_db_engine) as _s:
                _stmt = select(CRMPair).where(CRMPair.customer == req.customer)
                if len(_agent_names) == 1:
                    _stmt = _stmt.where(CRMPair.agent == _agent_names[0])
                else:
                    _stmt = _stmt.where(CRMPair.agent.in_(_agent_names))
                _stmt = _stmt.order_by(CRMPair.call_count.desc())
                _pair_row = _s.exec(_stmt).first()

            if not _pair_row:
                raise RuntimeError(
                    f"Auto-transcription failed: CRM pair not found for {req.sales_agent} / {req.customer}"
                )

            _call_ids = sorted(_missing_call_ids) if _missing_call_ids else []
            _batch_req = BatchPairsRequest(
                pairs=[PairSpec(
                    crm_url=str(_pair_row.crm_url or ""),
                    account_id=str(_pair_row.account_id or ""),
                    agent=req.sales_agent,
                    customer=req.customer,
                    call_ids=_call_ids,
                )]
            )
            _batch_res = await batch_transcribe_pairs(_batch_req)
            _submitted = int(_batch_res.get("submitted") or 0)
            _skipped = int(_batch_res.get("skipped") or 0)
            _job_ids = [str(_j) for _j in (_batch_res.get("job_ids") or []) if str(_j)]

            if _submitted == 0 and not _job_ids:
                # Jobs may already be running from another trigger; wait on inflight.
                with Session(_db_engine) as _s:
                    _j_stmt = select(Job).where(
                        Job.pair_slug == f"{req.sales_agent}/{req.customer}",
                        Job.status.in_([JobStatus.pending, JobStatus.running]),
                    )
                    if _call_ids:
                        _j_stmt = _j_stmt.where(Job.call_id.in_(_call_ids))
                    _inflight = _s.exec(_j_stmt).all()
                _job_ids = [str(_j.id) for _j in _inflight if _j.id]

            if _job_ids:
                _ok, _failed = await _wait_for_jobs(_job_ids)
                if not _ok:
                    raise RuntimeError(
                        f"Auto-transcription timed out/failed for {_failed} call(s)."
                    )

            # Re-check required inputs after auto-transcription finished.
            _needs_merged_after, _missing_call_ids_after = _collect_missing_transcript_requirements()
            if _needs_merged_after or _missing_call_ids_after:
                raise RuntimeError(
                    "Auto-transcription completed but required transcript inputs are still missing."
                )

            log_buffer.emit(
                f"[PIPELINE] ✓ Auto-transcription ready (submitted {_submitted}, skipped {_skipped}) · {cid_short}"
            )
            execution_logs.append_event(
                execution_session_id,
                "Auto-transcription ready",
                level="stage",
                status="running",
                data={
                    "submitted": _submitted,
                    "skipped": _skipped,
                    "job_count": len(_job_ids),
                },
            )
            _persist_run_log_snapshot(force=True)
            yield _sse("progress", {
                "msg": f"Auto-transcription ready (submitted {_submitted}, skipped {_skipped})",
            })

        def _persist_agent_result(
            _agent_id: str,
            _agent_name: str,
            _content: str,
            _model: str,
            _pipeline_step_index: int,
            _input_fingerprint: str,
        ) -> str:
            """Persist an agent result in pipeline-aware or legacy schema mode."""
            _rid = str(uuid.uuid4())
            _created_at = datetime.utcnow()
            try:
                with Session(_db_engine) as _s:
                    if _agent_result_has_pipeline_cache:
                        _s.add(AR(
                            id=_rid,
                            agent_id=_agent_id,
                            agent_name=_agent_name,
                            sales_agent=req.sales_agent,
                            customer=req.customer,
                            call_id=input_scope_call_id,
                            pipeline_id=pipeline_id,
                            pipeline_step_index=_pipeline_step_index,
                            input_fingerprint=_input_fingerprint,
                            content=_content,
                            model=_model,
                        ))
                    else:
                        _s.execute(
                            _sql_text(
                                "INSERT INTO agent_result ("
                                "id, agent_id, agent_name, sales_agent, customer, call_id, content, model, created_at"
                                ") VALUES ("
                                ":id, :agent_id, :agent_name, :sales_agent, :customer, :call_id, :content, :model, :created_at"
                                ")"
                            ),
                            {
                                "id": _rid,
                                "agent_id": _agent_id,
                                "agent_name": _agent_name,
                                "sales_agent": req.sales_agent,
                                "customer": req.customer,
                                "call_id": input_scope_call_id,
                                "content": _content,
                                "model": _model,
                                "created_at": _created_at,
                            },
                        )
                    _s.commit()
                return _rid
            except Exception as exc:
                mode = "pipeline" if _agent_result_has_pipeline_cache else "legacy"
                raise RuntimeError(
                    f"Failed to persist AgentResult in {mode} schema mode: {exc}"
                ) from exc

        def _touch_pipeline_artifact(
            _step_idx: int,
            _agent_id: str,
            _agent_name: str,
            _model: str,
            _result_id: str,
            _input_fingerprint: str = "",
            _source: str = "done",
        ) -> None:
            """Upsert stable pipeline artifact metadata for per-call/per-pair cache visibility."""
            _raw = (
                f"{pipeline_id}::{(req.sales_agent or '').strip().lower()}::"
                f"{(req.customer or '').strip().lower()}::{input_scope_call_id or ''}::{_step_idx}"
            )
            _id = hashlib.sha1(_raw.encode("utf-8")).hexdigest()
            _now = datetime.utcnow()
            try:
                with Session(_db_engine) as _s:
                    _existing = _s.get(PA, _id)
                    if _existing:
                        _existing.agent_id = _agent_id
                        _existing.agent_name = _agent_name
                        _existing.result_id = _result_id or _existing.result_id
                        _existing.input_fingerprint = _input_fingerprint or _existing.input_fingerprint
                        _existing.model = _model
                        _existing.source = _source
                        _existing.updated_at = _now
                        _s.add(_existing)
                    else:
                        _s.add(PA(
                            id=_id,
                            pipeline_id=pipeline_id,
                            sales_agent=req.sales_agent,
                            customer=req.customer,
                            call_id=input_scope_call_id or "",
                            pipeline_step_index=_step_idx,
                            agent_id=_agent_id,
                            agent_name=_agent_name,
                            result_id=_result_id or "",
                            input_fingerprint=_input_fingerprint or "",
                            model=_model,
                            source=_source,
                            created_at=_now,
                            updated_at=_now,
                        ))
                    _s.commit()
            except Exception as _e:
                log_buffer.emit(
                    f"[PIPELINE] ⚠ artifact index update failed (step {_step_idx + 1}): {_e}"
                )

        # ── Build stage groups from canvas ───────────────────────────────────
        # Processing nodes sorted by (stageIndex, x) give the pipeline step order.
        # Steps with the same stageIndex belong to the same parallel stage.
        _canvas_nodes = pipeline_def.get("canvas", {}).get("nodes", [])
        _proc_nodes_all = sorted(
            [n for n in _canvas_nodes if n.get("type") == "processing"],
            key=lambda n: (n.get("data", {}).get("stageIndex", 0), n.get("position", {}).get("x", 0)),
        )
        _proc_nodes_with_agent = [n for n in _proc_nodes_all if (n.get("data", {}) or {}).get("agentId")]
        _proc_nodes = _proc_nodes_with_agent if len(_proc_nodes_with_agent) >= len(steps) else _proc_nodes_all
        _proc_node_id_by_step_idx = {}
        for _i, _n in enumerate(_proc_nodes):
            if _i < len(steps):
                _nid = _n.get("id") or ""
                if _nid:
                    _proc_node_id_by_step_idx[_i] = _nid
        _proc_node_to_step_idx = {v: k for k, v in _proc_node_id_by_step_idx.items()}
        _input_node_ids = [n.get("id") for n in _canvas_nodes if n.get("type") == "input" and (n.get("id") or "")]
        _output_node_ids = [n.get("id") for n in _canvas_nodes if n.get("type") == "output" and (n.get("id") or "")]
        _output_node_data_by_id = {
            (n.get("id") or ""): (n.get("data", {}) or {})
            for n in _canvas_nodes
            if n.get("type") == "output" and (n.get("id") or "")
        }
        _output_node_to_step_idx = {}
        _input_node_to_step_idxs = {}
        _incoming_output_src_by_step_idx: dict[int, str] = {}
        for _e in (pipeline_def.get("canvas", {}) or {}).get("edges", []):
            _src = _e.get("source")
            _tgt = _e.get("target")
            if _src in _proc_node_to_step_idx and _tgt in _output_node_ids:
                _si = _proc_node_to_step_idx[_src]
                _output_node_to_step_idx[_tgt] = _si
                if _si not in _step_output_meta:
                    _od = _output_node_data_by_id.get(_tgt, {})
                    _step_output_meta[_si] = {
                        "sub_type": str(_od.get("subType") or "").strip(),
                        "label": str(_od.get("label") or "").strip(),
                    }
            # Output -> processing edges carry semantic artifact source for downstream inputs.
            if _src in _output_node_ids and _tgt in _proc_node_to_step_idx:
                _si = _proc_node_to_step_idx[_tgt]
                _od = _output_node_data_by_id.get(_src, {})
                _sub = str(_od.get("subType") or "").strip()
                if _sub and _si not in _incoming_output_src_by_step_idx:
                    _incoming_output_src_by_step_idx[_si] = f"artifact_{_sub}"
            if _src in _input_node_ids and _tgt in _proc_node_to_step_idx:
                _arr = _input_node_to_step_idxs.get(_src, [])
                _arr.append(_proc_node_to_step_idx[_tgt])
                _input_node_to_step_idxs[_src] = _arr
        # Keep deterministic order for stable JSON/state diffs.
        for _k, _arr in list(_input_node_to_step_idxs.items()):
            _input_node_to_step_idxs[_k] = sorted(set(_arr))

        _step_canvas_stage: dict[int, int] = {}
        for _i, _n in enumerate(_proc_nodes):
            if _i < len(steps):
                _step_canvas_stage[_i] = _n.get("data", {}).get("stageIndex", _i)
        if not _step_canvas_stage:  # no canvas → each step is its own sequential stage
            _step_canvas_stage = {_i: _i for _i in range(len(steps))}

        # Ordered list of (canvas_stage_key, [step_indices]) preserving first-occurrence order
        _seen_stages: list[int] = []
        _grp: dict[int, list[int]] = {}
        for _si in range(len(steps)):
            _cs = _step_canvas_stage.get(_si, _si)
            if _cs not in _grp:
                _grp[_cs] = []
                _seen_stages.append(_cs)
            _grp[_cs].append(_si)
        _ordered_stages = [(_cs, _grp[_cs]) for _cs in _seen_stages]

        _execute_step_indices: list[int] = []
        _seen_exec: set[int] = set()
        for _raw_idx in (req.execute_step_indices or []):
            try:
                _idx = int(_raw_idx)
            except Exception:
                continue
            if _idx < 0 or _idx >= len(steps) or _idx in _seen_exec:
                continue
            _seen_exec.add(_idx)
            _execute_step_indices.append(_idx)
        _execute_step_set: Optional[set[int]] = set(_execute_step_indices) if _execute_step_indices else None
        if _execute_step_set:
            _mode_suffix = " (inputs only)" if req.prepare_input_only else ""
            log_buffer.emit(
                f"[PIPELINE] ▶ Targeted execution: {len(_execute_step_indices)} step(s) selected{_mode_suffix} · {cid_short}"
            )
        # Rewrite once after canvas maps are available so JSON includes node_states.
        save_steps()

        def _jsonish_to_str(_raw: str) -> str:
            _text = (_raw or "").strip()
            if not _text:
                return "{}"
            # Strip optional fenced code blocks before JSON parsing.
            if _text.startswith("```"):
                _text = _re.sub(r"^```[a-zA-Z0-9_-]*\s*", "", _text)
                _text = _re.sub(r"\s*```$", "", _text).strip()
            try:
                return json.dumps(json.loads(_text), ensure_ascii=False)
            except Exception:
                pass
            _m = _re.search(r"\{[\s\S]+\}", _text)
            if _m:
                try:
                    return json.dumps(json.loads(_m.group(0)), ensure_ascii=False)
                except Exception:
                    pass
            return json.dumps({"_raw_text": _raw}, ensure_ascii=False)

        def _save_notes_rollup_from_pipeline(_step_idx: int, _sub_type: str, _content: str, _model: str) -> None:
            if not (req.sales_agent and req.customer):
                return
            try:
                _parsed = json.loads(_jsonish_to_str(_content))
                if not isinstance(_parsed, dict):
                    _parsed = {"_raw_text": _content}
            except Exception:
                _parsed = {"_raw_text": _content}
            _parsed["_saved_at"] = datetime.utcnow().isoformat()
            _parsed["_note_count"] = 1
            _parsed["_preset"] = "(all)"
            _parsed["_source"] = "pipeline"
            _parsed["_pipeline_id"] = pipeline_id
            _parsed["_run_id"] = run_id
            _parsed["_step_idx"] = _step_idx
            _parsed["_artifact_sub_type"] = _sub_type
            _parsed["_model"] = _model
            _save_dir = settings.ui_data_dir / "_note_rollups" / req.sales_agent
            _save_dir.mkdir(parents=True, exist_ok=True)
            (_save_dir / f"{req.customer}__all.json").write_text(
                json.dumps(_parsed, indent=2, ensure_ascii=False), encoding="utf-8"
            )
            # Keep legacy filename path for compatibility.
            (_save_dir / f"{req.customer}.json").write_text(
                json.dumps(_parsed, indent=2, ensure_ascii=False), encoding="utf-8"
            )

        def _persist_structured_artifact(
            _step_idx: int,
            _content: str,
            _model: str,
            _agent_name: str,
            _input_fingerprint: str,
        ) -> None:
            _meta = _step_output_meta.get(_step_idx, {})
            _sub_type = str(_meta.get("sub_type") or "").strip().lower()
            if _sub_type not in {"persona", "persona_score", "notes", "notes_compliance"}:
                return

            _fp = _input_fingerprint or _hash_text(_content)[:24]
            _marker = f"pipeline:{pipeline_id}:{_step_idx}:{_fp}"
            _label = (_meta.get("label") or "").strip() or f"{pipeline_name} · {_agent_name}"
            _call_id = input_scope_call_id or f"pipeline:{run_id}:{_step_idx}"

            try:
                if _sub_type == "persona":
                    with Session(_db_engine) as _s:
                        _existing = _s.exec(
                            select(Persona).where(Persona.persona_agent_id == _marker)
                        ).first()
                        if _existing:
                            if (_existing.content_md or "") != (_content or ""):
                                _existing.content_md = _content
                                _existing.model = _model
                                _s.add(_existing)
                                _s.commit()
                            _artifact_ctx["latest_persona_id"] = _existing.id
                            return
                        _ptype = "pair" if req.customer else "agent_overall"
                        _p = Persona(
                            id=str(uuid.uuid4()),
                            type=_ptype,
                            agent=req.sales_agent,
                            customer=req.customer or None,
                            label=_label,
                            content_md=_content,
                            prompt_used="",
                            model=_model,
                            temperature=0.0,
                            transcript_paths="",
                            script_path=None,
                            version=1,
                            parent_id=None,
                            persona_agent_id=_marker,
                            sections_json=None,
                            score_json=None,
                        )
                        _s.add(_p)
                        _s.commit()
                        _artifact_ctx["latest_persona_id"] = _p.id
                    return

                if _sub_type == "persona_score":
                    _score_json = _jsonish_to_str(_content)
                    with Session(_db_engine) as _s:
                        _target = None
                        _latest_id = _artifact_ctx.get("latest_persona_id")
                        if _latest_id:
                            _target = _s.get(Persona, _latest_id)
                        if not _target:
                            _q = select(Persona).where(
                                Persona.agent == req.sales_agent,
                                Persona.type.in_(["pair", "agent_overall"]),
                                Persona.persona_agent_id.contains(f"pipeline:{pipeline_id}:"),
                            )
                            if req.customer:
                                _q = _q.where(Persona.customer == req.customer)
                            else:
                                _q = _q.where(Persona.customer == None)  # noqa: E711
                            _q = _q.order_by(Persona.created_at.desc())
                            _target = _s.exec(_q).first()
                        if not _target:
                            log_buffer.emit(
                                f"[PIPELINE] ⚠ No matching persona row to attach persona_score for step {_step_idx + 1} · {cid_short}"
                            )
                            return
                        _target.score_json = _score_json
                        _target.model = _target.model or _model
                        _s.add(_target)
                        _s.commit()
                        _artifact_ctx["latest_persona_id"] = _target.id
                    return

                if _sub_type == "notes":
                    with Session(_db_engine) as _s:
                        _saved_note_id = ""
                        _existing = _s.exec(
                            select(Note).where(
                                Note.agent == req.sales_agent,
                                Note.customer == req.customer,
                                Note.call_id == _call_id,
                                Note.persona_agent_id == _marker,
                            )
                        ).first()
                        if _existing:
                            if (_existing.content_md or "") != (_content or ""):
                                _existing.content_md = _content
                                _existing.model = _model
                                _s.add(_existing)
                                _s.commit()
                            _saved_note_id = str(_existing.id or "")
                        else:
                            _n = Note(
                                id=str(uuid.uuid4()),
                                agent=req.sales_agent,
                                customer=req.customer,
                                call_id=_call_id,
                                persona_agent_id=_marker,
                                content_md=_content,
                                score_json=None,
                                model=_model,
                                temperature=0.0,
                            )
                            _s.add(_n)
                            _s.commit()
                            _saved_note_id = str(_n.id or "")
                    if 0 <= _step_idx < len(run_steps) and _saved_note_id:
                        run_steps[_step_idx]["note_id"] = _saved_note_id
                        run_steps[_step_idx]["note_call_id"] = str(_call_id or "")
                    _save_notes_rollup_from_pipeline(_step_idx, _sub_type, _content, _model)
                    return

                if _sub_type == "notes_compliance":
                    _score_json = _jsonish_to_str(_content)
                    with Session(_db_engine) as _s:
                        _saved_note_id = ""
                        _existing = _s.exec(
                            select(Note).where(
                                Note.agent == req.sales_agent,
                                Note.customer == req.customer,
                                Note.call_id == _call_id,
                                Note.persona_agent_id == _marker,
                            )
                        ).first()
                        if _existing:
                            _existing.content_md = _content
                            _existing.score_json = _score_json
                            _existing.model = _model
                            _s.add(_existing)
                            _s.commit()
                            _saved_note_id = str(_existing.id or "")
                        else:
                            _n = Note(
                                id=str(uuid.uuid4()),
                                agent=req.sales_agent,
                                customer=req.customer,
                                call_id=_call_id,
                                persona_agent_id=_marker,
                                content_md=_content,
                                score_json=_score_json,
                                model=_model,
                                temperature=0.0,
                            )
                            _s.add(_n)
                            _s.commit()
                            _saved_note_id = str(_n.id or "")
                    if 0 <= _step_idx < len(run_steps) and _saved_note_id:
                        run_steps[_step_idx]["note_id"] = _saved_note_id
                        run_steps[_step_idx]["note_call_id"] = str(_call_id or "")
                    return
            except Exception as _artifact_exc:
                log_buffer.emit(
                    f"[PIPELINE] ⚠ Artifact persist failed for step {_step_idx + 1} ({_sub_type}): {_artifact_exc}"
                )

        try:
            async for _evt in _ensure_transcripts_ready_for_run():
                yield _evt
            log_buffer.emit(f"[PIPELINE] ▶ {pipeline_name} ({len(steps)} steps) · {cid_short}")
            yield _sse("pipeline_start", {"total": len(steps), "name": pipeline_name, "run_id": run_id})

            fatal_error = False

            for _canvas_stage, _stage_step_indices in _ordered_stages:
                _raise_if_stop_requested()
                if fatal_error:
                    break
                step_indices = (
                    [i for i in _stage_step_indices if i in _execute_step_set]
                    if _execute_step_set is not None
                    else _stage_step_indices
                )
                if not step_indices:
                    continue

                # ── Single-step stage (streaming ok) ─────────────────────────
                if len(step_indices) == 1:
                    step_idx  = step_indices[0]
                    step      = steps[step_idx]
                    agent_id  = step.get("agent_id", "")
                    agent_def = agent_map.get(agent_id)

                    if not agent_def:
                        run_steps[step_idx]["state"]    = "failed"
                        run_steps[step_idx]["end_time"] = datetime.utcnow().isoformat()
                        run_steps[step_idx]["error_msg"] = f"Agent '{agent_id}' not found"
                        yield _sse("error", {"msg": f"Step {step_idx + 1}: agent '{agent_id}' not found", "step": step_idx})
                        save_steps()
                        fatal_error = True
                        break

                    runtime_agent_def = _apply_step_output_contract_override(agent_def, step)
                    overrides = _normalize_overrides_for_step(
                        step_idx, runtime_agent_def, step.get("input_overrides", {})
                    )

                    agent_name = runtime_agent_def.get("name", agent_id)
                    model      = runtime_agent_def.get("model", "gpt-5.4")

                    run_steps[step_idx]["agent_name"] = agent_name
                    run_steps[step_idx]["model"]      = model
                    run_steps[step_idx]["state"]      = "running"
                    run_steps[step_idx]["input_ready"] = False
                    run_steps[step_idx]["start_time"] = datetime.utcnow().isoformat()
                    save_steps()  # persist "running" so mid-run refresh shows orange

                    log_buffer.emit(f"[PIPELINE] ▶ Step {step_idx + 1}/{len(steps)}: {agent_name} [{model}] · {cid_short}")
                    yield _sse("step_start", {
                        "step": step_idx, "total": len(steps),
                        "agent_id": agent_id, "agent_name": agent_name, "model": model,
                    })

                    # ── Capture input source declarations ────────────────────
                    run_steps[step_idx]["input_sources"] = [
                        {
                            "key": inp.get("key", ""),
                            "source": _public_input_source(
                                overrides.get(inp.get("key", ""), inp.get("source", "manual"))
                            ),
                        }
                        for inp in runtime_agent_def.get("inputs", [])
                    ]

                    # Resume-partial fast path: reuse latest step cache immediately,
                    # before potentially expensive input resolution/fingerprint work.
                    if (not req.prepare_input_only) and req.resume_partial and (not req.force) and step_idx not in req.force_step_indices:
                        _resume_cached = None
                        try:
                            with Session(_db_engine) as _s:
                                _resume_cached = _lookup_step_cache_resume_only(_s, agent_id, step_idx)
                        except Exception as _cache_exc:
                            log_buffer.emit(
                                f"[PIPELINE] ⚠ Resume cache lookup failed for step {step_idx + 1}: {_cache_exc}"
                            )
                        if _resume_cached:
                            prev_content = _resume_cached.content
                            _persist_structured_artifact(
                                _step_idx=step_idx,
                                _content=_resume_cached.content,
                                _model=model,
                                _agent_name=agent_name,
                                _input_fingerprint="",
                            )
                            run_steps[step_idx].update({
                                "state":            "completed",
                                "end_time":         datetime.utcnow().isoformat(),
                                "content":          _resume_cached.content,
                                "input_ready":      True,
                                "cache_mode":       "resume_partial",
                                "cached_locations": [{
                                    "type": "agent_result",
                                    "id": _resume_cached.id,
                                    "created_at": _resume_cached.created_at.isoformat() if _resume_cached.created_at else None,
                                }],
                            })
                            save_steps()
                            log_buffer.emit(
                                f"[PIPELINE] ↩ Step {step_idx + 1}/{len(steps)}: {agent_name} → cached (resume fast-path) · {cid_short}"
                            )
                            yield _sse("step_cached", {
                                "step": step_idx,
                                "agent_name": agent_name,
                                "result_id": _resume_cached.id,
                                "content": _resume_cached.content,
                                "cache_mode": "resume_partial",
                            })
                            _touch_pipeline_artifact(
                                _step_idx=step_idx,
                                _agent_id=agent_id,
                                _agent_name=agent_name,
                                _model=model,
                                _result_id=str(_resume_cached.id or ""),
                                _input_fingerprint="",
                                _source="cached_resume",
                            )
                            continue

                    # ── Resolve inputs ───────────────────────────────────────
                    temperature   = float(runtime_agent_def.get("temperature", 0.0))
                    system_prompt = runtime_agent_def.get("system_prompt", "")
                    user_template = runtime_agent_def.get("user_prompt", "")
                    # Intentionally do not mutate prompts at runtime.
                    # Execution must use exactly the stored system/user prompts.
                    manual_inputs = {"_chain_previous": prev_content}
                    source_for_key = {
                        inp.get("key", ""): _public_input_source(
                            overrides.get(inp.get("key", ""), inp.get("source", ""))
                        )
                        for inp in runtime_agent_def.get("inputs", [])
                    }

                    resolved: dict[str, str] = {}
                    resolve_err = False
                    def _resolve_input_worker(
                        _source: str,
                        _ref_id: Optional[str],
                        _manual_inputs: dict[str, str],
                        _input_key: str,
                        _merged_scope: str,
                        _merged_until_call_id: str,
                    ) -> str:
                        with Session(_db_engine) as _ldb:
                            return _resolve_input(
                                _source, _ref_id, req.sales_agent, req.customer, input_scope_call_id,
                                _manual_inputs, _ldb, input_key=_input_key,
                                merged_scope=_merged_scope,
                                merged_until_call_id=_merged_until_call_id,
                            )
                    for inp in runtime_agent_def.get("inputs", []):
                        key    = inp.get("key", "input")
                        source = _public_input_source(
                            overrides.get(key, inp.get("source", "manual"))
                        )
                        ref_id = inp.get("agent_id")
                        merged_scope = str(inp.get("merged_scope") or "auto")
                        merged_until_call_id = str(inp.get("merged_until_call_id") or "")
                        try:
                            text = await loop.run_in_executor(
                                None,
                                lambda s=source, a=ref_id, m=manual_inputs, k=key, ms=merged_scope, mc=merged_until_call_id: _resolve_input_worker(s, a, m, k, ms, mc),
                            )
                            resolved[key] = text
                        except Exception as exc:
                            run_steps[step_idx].update({"state": "failed", "end_time": datetime.utcnow().isoformat(), "error_msg": str(exc)})
                            log_buffer.emit(f"[PIPELINE] ✗ Step {step_idx + 1}/{len(steps)}: {agent_name} → error (resolve input) · {cid_short}")
                            yield _sse("error", {"msg": str(exc), "step": step_idx})
                            save_steps()
                            fatal_error = True
                            resolve_err = True
                            break
                    if resolve_err:
                        break
                    run_steps[step_idx]["input_ready"] = True
                    run_steps[step_idx]["model_info"] = {
                        "provider": _model_provider_name(model),
                        "model": model,
                        "temperature": temperature,
                        "agent_class": str(runtime_agent_def.get("agent_class") or ""),
                        "output_format": str(runtime_agent_def.get("output_format") or ""),
                    }
                    save_steps()  # input files/text resolved — persist input-node readiness

                    # Strict runtime policy:
                    # always pass resolved inputs as provider files only.
                    file_inputs = dict(resolved)
                    inline_inputs: dict[str, str] = {}
                    run_steps[step_idx]["request_raw"] = {
                        "system_prompt": system_prompt,
                        "user_prompt_template": user_template,
                        "inline_inputs": dict(inline_inputs),
                        "resolved_input_meta": {
                            str(k): {
                                "chars": len(str(v or "")),
                                "source": str(source_for_key.get(k) or ""),
                            }
                            for k, v in resolved.items()
                        },
                    }

                    input_fingerprint = _build_input_fingerprint(
                        pipeline_id=pipeline_id,
                        step_idx=step_idx,
                        agent_id=agent_id,
                        model=model,
                        temperature=temperature,
                        system_prompt=system_prompt,
                        user_template=user_template,
                        overrides=overrides,
                        resolved_inputs=resolved,
                        output_profile=runtime_agent_def,
                    )
                    run_steps[step_idx]["input_fingerprint"] = input_fingerprint

                    if req.prepare_input_only:
                        _prepared_at = datetime.utcnow().isoformat()
                        run_steps[step_idx].update({
                            "state": "input_prepared",
                            "end_time": _prepared_at,
                            "input_ready": True,
                            "cache_mode": "input_prepared",
                            "error_msg": "",
                        })
                        save_steps()
                        log_buffer.emit(
                            f"[PIPELINE] ↺ Step {step_idx + 1}/{len(steps)}: {agent_name} → input prepared · {cid_short}"
                        )
                        yield _sse("input_ready", {"step": step_idx})
                        yield _sse("input_prepared", {
                            "step": step_idx,
                            "agent_name": agent_name,
                            "input_fingerprint": input_fingerprint,
                        })
                        continue

                    # ── Check cache (pipeline+step+input fingerprint) ────────
                    if not req.force and step_idx not in req.force_step_indices:
                        cached = None
                        cached_via_resume_partial = False
                        try:
                            with Session(_db_engine) as _s:
                                cached, cached_via_resume_partial = _lookup_step_cache(
                                    _s, agent_id, step_idx, input_fingerprint
                                )
                        except Exception as _cache_exc:
                            log_buffer.emit(
                                f"[PIPELINE] ⚠ Cache lookup failed for step {step_idx + 1}: {_cache_exc}"
                            )
                            cached = None

                        if cached:
                            prev_content = cached.content
                            _persist_structured_artifact(
                                _step_idx=step_idx,
                                _content=cached.content,
                                _model=model,
                                _agent_name=agent_name,
                                _input_fingerprint=input_fingerprint,
                            )
                            run_steps[step_idx].update({
                                "state":            "completed",
                                "end_time":         datetime.utcnow().isoformat(),
                                "content":          cached.content,
                                "input_ready":      True,
                                "cache_mode":       "resume_partial" if cached_via_resume_partial else "exact",
                                "cached_locations": [{"type": "agent_result", "id": cached.id, "created_at": cached.created_at.isoformat() if cached.created_at else None}],
                            })
                            save_steps()  # write state BEFORE yield so file is correct if client disconnects
                            if cached_via_resume_partial:
                                log_buffer.emit(
                                    f"[PIPELINE] ↩ Step {step_idx + 1}/{len(steps)}: {agent_name} → cached (resume fallback) · {cid_short}"
                                )
                            else:
                                log_buffer.emit(
                                    f"[PIPELINE] ↩ Step {step_idx + 1}/{len(steps)}: {agent_name} → cached · {cid_short}"
                                )
                            yield _sse("step_cached", {
                                "step": step_idx, "agent_name": agent_name,
                                "result_id": cached.id, "content": cached.content,
                                "cache_mode": "resume_partial" if cached_via_resume_partial else "exact",
                            })
                            _touch_pipeline_artifact(
                                _step_idx=step_idx,
                                _agent_id=agent_id,
                                _agent_name=agent_name,
                                _model=model,
                                _result_id=str(cached.id or ""),
                                _input_fingerprint=input_fingerprint,
                                _source="cached_resume" if cached_via_resume_partial else "cached_exact",
                            )
                            continue  # advance to next canvas stage

                    # Inputs resolved — notify frontend so input nodes can turn green
                    # before the LLM call starts (which may take many seconds).
                    yield _sse("input_ready", {"step": step_idx})

                    # ── Call LLM ─────────────────────────────────────────────
                    inline_chars = sum(len(v) for v in inline_inputs.values())
                    file_chars   = sum(len(v) for v in file_inputs.values())
                    total_chars  = inline_chars + (file_chars if model.startswith("grok") else 0)
                    input_tok_est = (total_chars + len(system_prompt)) // 4
                    # Show inline chars and file count separately so large file content
                    # doesn't obscure how much inline context is in the prompt.
                    if inline_chars and file_inputs:
                        _log_display = f"{inline_chars:,} chars + {len(file_inputs)} file(s)"
                    elif inline_chars:
                        _log_display = f"{inline_chars:,} chars"
                    else:
                        _log_display = f"{len(file_inputs)} file(s)"
                    log_buffer.emit(f"[LLM] {model} — {_log_display} input · {cid_short}")
                    try:
                        def _resolve_refs_only() -> dict[str, str]:
                            with Session(_db_engine) as _ldb:
                                _ldb._agent_run_ctx = {
                                    "sales_agent": req.sales_agent,
                                    "customer": req.customer,
                                    "call_id": input_scope_call_id,
                                    "source_for_key": source_for_key,
                                }
                                return _resolve_provider_file_refs(model, file_inputs, _ldb)

                        file_ref_map = await loop.run_in_executor(None, _resolve_refs_only)
                        run_steps[step_idx]["request_raw"] = {
                            **(run_steps[step_idx].get("request_raw") or {}),
                            "provider_file_refs": dict(file_ref_map or {}),
                        }
                        if file_ref_map:
                            _ref_preview = ", ".join(f"{k}={v}" for k, v in list(file_ref_map.items())[:6])
                            if len(file_ref_map) > 6:
                                _ref_preview += f", …(+{len(file_ref_map)-6} more)"
                            log_buffer.emit(
                                f"[PIPELINE] Step {step_idx + 1} file refs: {_ref_preview} · {cid_short}"
                            )
                            yield _sse("progress", {
                                "step": step_idx,
                                "msg": f"File refs: {_ref_preview}",
                            })
                    except Exception as _ref_exc:
                        log_buffer.emit(
                            f"[PIPELINE] ⚠ Step {step_idx + 1} file ref resolution failed: {_ref_exc} · {cid_short}"
                        )

                    step_start_t = time.time()
                    llm_err = False

                    if model.startswith("claude-"):
                        q: _queue.Queue = _queue.Queue()
                        result_holder: list = []
                        error_holder:  list = []

                        def _do(fi=file_inputs, ii=inline_inputs, m=model, sp=system_prompt, ut=user_template):
                            try:
                                with Session(_db_engine) as _ldb:
                                    _ldb._agent_run_ctx = {
                                        "sales_agent": req.sales_agent,
                                        "customer": req.customer,
                                        "call_id": input_scope_call_id,
                                        "source_for_key": source_for_key,
                                    }
                                    c, t = _llm_call_anthropic_files_streaming(
                                        sp, ut, fi, ii, m, _ldb,
                                        on_text=lambda chunk: q.put(("stream", chunk)),
                                    )
                                result_holder.append((c, t))
                            except Exception as exc:
                                error_holder.append(str(exc))
                            finally:
                                q.put(None)

                        threading.Thread(target=_do, daemon=True).start()

                        while True:
                            item = await loop.run_in_executor(None, q.get)
                            if item is None:
                                break
                            _, data = item
                            yield _sse("stream", {"text": data, "step": step_idx})

                        if error_holder:
                            run_steps[step_idx].update({"state": "failed", "end_time": datetime.utcnow().isoformat(), "error_msg": error_holder[0]})
                            log_buffer.emit(f"[PIPELINE] ✗ Step {step_idx + 1}/{len(steps)}: {agent_name} → error · {cid_short}")
                            yield _sse("error", {"msg": error_holder[0], "step": step_idx})
                            save_steps()
                            fatal_error = True
                            llm_err = True

                        if not llm_err:
                            content, thinking = result_holder[0]
                    else:
                        try:
                            def _do_llm():
                                with Session(_db_engine) as _ldb:
                                    _ldb._agent_run_ctx = {
                                        "sales_agent": req.sales_agent,
                                        "customer": req.customer,
                                        "call_id": input_scope_call_id,
                                        "source_for_key": source_for_key,
                                    }
                                    return _llm_call_with_files(
                                        system_prompt, user_template,
                                        file_inputs, inline_inputs,
                                        model, temperature, _ldb,
                                    )

                            _future = loop.run_in_executor(None, _do_llm)
                            yield _sse("progress", {"step": step_idx, "msg": f"Calling {model}…"})
                            _deadline = time.monotonic() + LLM_TIMEOUT_S
                            _next_heartbeat = time.monotonic() + 3.0
                            while True:
                                _raise_if_stop_requested()
                                _remaining = _deadline - time.monotonic()
                                if _remaining <= 0:
                                    raise asyncio.TimeoutError
                                done_set, _ = await asyncio.wait({_future}, timeout=min(2.0, _remaining))
                                if done_set:
                                    content, thinking = _future.result()
                                    break
                                if time.monotonic() >= _next_heartbeat:
                                    waited_s = int(LLM_TIMEOUT_S - _remaining)
                                    _next_heartbeat = time.monotonic() + 3.0
                                    log_buffer.emit(
                                        f"[PIPELINE] … Step {step_idx + 1}/{len(steps)} waiting on {model} ({waited_s}s) · {cid_short}"
                                    )
                                    yield _sse("progress", {
                                        "step": step_idx,
                                        "msg": f"Waiting for {model} response… {waited_s}s",
                                    })
                        except asyncio.TimeoutError:
                            err_msg = f"LLM call timed out after {int(LLM_TIMEOUT_S)}s (model: {model})"
                            run_steps[step_idx].update({"state": "failed", "end_time": datetime.utcnow().isoformat(), "error_msg": err_msg})
                            log_buffer.emit(f"[PIPELINE] ✗ Step {step_idx + 1}/{len(steps)}: {agent_name} → timeout · {cid_short}")
                            yield _sse("error", {"msg": err_msg, "step": step_idx})
                            save_steps()
                            fatal_error = True
                            llm_err = True
                        except Exception as exc:
                            run_steps[step_idx].update({"state": "failed", "end_time": datetime.utcnow().isoformat(), "error_msg": str(exc)})
                            log_buffer.emit(f"[PIPELINE] ✗ Step {step_idx + 1}/{len(steps)}: {agent_name} → error · {cid_short}")
                            yield _sse("error", {"msg": str(exc), "step": step_idx})
                            save_steps()
                            fatal_error = True
                            llm_err = True

                    if llm_err:
                        break

                    raw_content = content
                    content = _apply_output_postprocess(
                        raw_output=content,
                        agent_def=runtime_agent_def,
                        step_model=model,
                        previous_content=prev_content,
                    )
                    exec_time_s    = round(time.time() - step_start_t, 1)
                    output_tok_est = len(content) // 4

                    # ── Persist AgentResult ───────────────────────────────────
                    result_id = _persist_agent_result(
                        _agent_id=agent_id,
                        _agent_name=agent_name,
                        _content=content,
                        _model=model,
                        _pipeline_step_index=step_idx,
                        _input_fingerprint=input_fingerprint,
                    )
                    _persist_structured_artifact(
                        _step_idx=step_idx,
                        _content=content,
                        _model=model,
                        _agent_name=agent_name,
                        _input_fingerprint=input_fingerprint,
                    )
                    _touch_pipeline_artifact(
                        _step_idx=step_idx,
                        _agent_id=agent_id,
                        _agent_name=agent_name,
                        _model=model,
                        _result_id=result_id,
                        _input_fingerprint=input_fingerprint,
                        _source="done",
                    )

                    prev_content = content
                    run_steps[step_idx].update({
                        "state":            "completed",
                        "end_time":         datetime.utcnow().isoformat(),
                        "content":          content,
                        "input_ready":      True,
                        "execution_time_s": exec_time_s,
                        "input_token_est":  input_tok_est,
                        "output_token_est": output_tok_est,
                        "thinking":         (thinking or "")[:8000],
                        "response_raw":     raw_content,
                    })
                    save_steps()  # write state BEFORE yields so file is correct if client disconnects

                    log_buffer.emit(f"[LLM] {model} — done ({len(content):,} chars, {exec_time_s}s) · {cid_short}")

                    if thinking:
                        yield _sse("thinking", {"content": thinking[:5000], "step": step_idx})

                    log_buffer.emit(f"[PIPELINE] ✓ Step {step_idx + 1}/{len(steps)}: {agent_name} → done ({exec_time_s}s) · {cid_short}")
                    yield _sse("step_done", {
                        "step":             step_idx,
                        "agent_name":       agent_name,
                        "result_id":        result_id,
                        "content":          content,
                        "model":            model,
                        "execution_time_s": exec_time_s,
                        "input_token_est":  input_tok_est,
                        "output_token_est": output_tok_est,
                    })

                # ── Parallel stage (multiple steps, non-streaming) ────────────
                else:
                    n_par = len(step_indices)
                    log_buffer.emit(f"[PIPELINE] ▶ Stage {_canvas_stage}: {n_par} parallel steps · {cid_short}")

                    # Validate all agents before starting
                    for _sidx in step_indices:
                        _aid = steps[_sidx].get("agent_id", "")
                        if not agent_map.get(_aid):
                            run_steps[_sidx]["state"]    = "failed"
                            run_steps[_sidx]["end_time"] = datetime.utcnow().isoformat()
                            run_steps[_sidx]["error_msg"] = f"Agent '{_aid}' not found"
                            yield _sse("error", {"msg": f"Step {_sidx + 1}: agent '{_aid}' not found", "step": _sidx})
                            fatal_error = True
                            break
                    if fatal_error:
                        break

                    # Set loading + emit step_start for all parallel steps simultaneously
                    for _sidx in step_indices:
                        _s = steps[_sidx]
                        _aid = _s.get("agent_id", "")
                        _adef = agent_map[_aid]
                        _rdef = _apply_step_output_contract_override(_adef, _s)
                        _ov = _normalize_overrides_for_step(
                            _sidx, _rdef, _s.get("input_overrides", {})
                        )
                        _aname = _rdef.get("name", _aid)
                        _model = _rdef.get("model", "gpt-5.4")
                        run_steps[_sidx]["agent_name"] = _aname
                        run_steps[_sidx]["model"]      = _model
                        run_steps[_sidx]["input_sources"] = [
                            {
                                "key": inp.get("key", ""),
                                "source": _public_input_source(
                                    _ov.get(inp.get("key", ""), inp.get("source", "manual"))
                                ),
                            }
                            for inp in _rdef.get("inputs", [])
                        ]
                        run_steps[_sidx]["state"]      = "running"
                        run_steps[_sidx]["input_ready"] = False
                        run_steps[_sidx]["start_time"] = datetime.utcnow().isoformat()
                        log_buffer.emit(f"[PIPELINE] ▶ Step {_sidx + 1}/{len(steps)}: {_aname} [{_model}] · {cid_short}")
                        yield _sse("step_start", {
                            "step": _sidx, "total": len(steps),
                            "agent_id": _aid, "agent_name": _aname, "model": _model,
                        })
                    save_steps()

                    _stage_prev = prev_content  # all parallel steps share the same prev stage output

                    def _run_parallel_step_sync(par_idx: int, _sp: str) -> dict:
                        """Execute one parallel step in a worker thread. Never raises."""
                        _par_step   = steps[par_idx]
                        _par_aid    = _par_step.get("agent_id", "")
                        _par_ov     = _par_step.get("input_overrides", {})
                        _par_adef   = agent_map[_par_aid]
                        _par_rdef   = _apply_step_output_contract_override(_par_adef, _par_step)
                        _par_ov     = _normalize_overrides_for_step(
                            par_idx, _par_rdef, _par_ov
                        )
                        _par_aname  = _par_rdef.get("name", _par_aid)
                        _par_model  = _par_rdef.get("model", "gpt-5.4")
                        _par_temp   = float(_par_rdef.get("temperature", 0.0))
                        _par_sysp   = _par_rdef.get("system_prompt", "")
                        _par_ut     = _par_rdef.get("user_prompt", "")
                        # Intentionally do not mutate prompts at runtime.
                        # Execution must use exactly the stored system/user prompts.
                        _par_mi     = {"_chain_previous": _sp}
                        _par_fp     = ""
                        _par_input_ready = False
                        try:
                            with Session(_db_engine) as _par_db:
                                _source_for_key = {
                                    inp.get("key", ""): _public_input_source(
                                        _par_ov.get(inp.get("key", ""), inp.get("source", ""))
                                    )
                                    for inp in _par_rdef.get("inputs", [])
                                }
                                _par_db._agent_run_ctx = {
                                    "sales_agent": req.sales_agent,
                                    "customer": req.customer,
                                    "call_id": input_scope_call_id,
                                    "source_for_key": _source_for_key,
                                }

                                # Resume-partial fast path for parallel stages too.
                                if (not req.prepare_input_only) and req.resume_partial and (not req.force) and par_idx not in req.force_step_indices:
                                    _resume_cached = None
                                    try:
                                        _resume_cached = _lookup_step_cache_resume_only(_par_db, _par_aid, par_idx)
                                    except Exception as _cache_exc:
                                        log_buffer.emit(
                                            f"[PIPELINE] ⚠ Parallel resume cache lookup failed for step {par_idx + 1}: {_cache_exc}"
                                        )
                                    if _resume_cached:
                                        return {
                                            "step_idx": par_idx,
                                            "status": "cached",
                                            "content": _resume_cached.content,
                                            "result_id": _resume_cached.id,
                                            "cached_created_at": _resume_cached.created_at.isoformat() if _resume_cached.created_at else None,
                                            "agent_name": _par_aname,
                                            "model": _par_model,
                                            "input_fingerprint": "",
                                            "input_ready": True,
                                            "cache_mode": "resume_partial",
                                        }

                                _par_resolved: dict[str, str] = {}
                                for _inp in _par_rdef.get("inputs", []):
                                    _k   = _inp.get("key", "input")
                                    _src = _public_input_source(
                                        _par_ov.get(_k, _inp.get("source", "manual"))
                                    )
                                    _rid = _inp.get("agent_id")
                                    _ms  = str(_inp.get("merged_scope") or "auto")
                                    _mc  = str(_inp.get("merged_until_call_id") or "")
                                    _par_resolved[_k] = _resolve_input(
                                        _src, _rid, req.sales_agent, req.customer, input_scope_call_id, _par_mi, _par_db,
                                        input_key=_k,
                                        merged_scope=_ms,
                                        merged_until_call_id=_mc,
                                    )
                                _par_input_ready = True
                                _par_request_raw = {
                                    "system_prompt": _par_sysp,
                                    "user_prompt_template": _par_ut,
                                    "inline_inputs": {},
                                    "resolved_input_meta": {
                                        str(k): {
                                            "chars": len(str(v or "")),
                                            "source": str(_source_for_key.get(k) or ""),
                                        }
                                        for k, v in _par_resolved.items()
                                    },
                                }

                                # Strict runtime policy:
                                # always pass resolved inputs as provider files only.
                                _par_fi = dict(_par_resolved)
                                _par_ii: dict[str, str] = {}
                                _par_fp = _build_input_fingerprint(
                                    pipeline_id=pipeline_id,
                                    step_idx=par_idx,
                                    agent_id=_par_aid,
                                    model=_par_model,
                                    temperature=_par_temp,
                                    system_prompt=_par_sysp,
                                    user_template=_par_ut,
                                    overrides=_par_ov,
                                    resolved_inputs=_par_resolved,
                                    output_profile=_par_rdef,
                                )

                                if req.prepare_input_only:
                                    return {
                                        "step_idx": par_idx,
                                        "status": "input_prepared",
                                        "agent_name": _par_aname,
                                        "model": _par_model,
                                        "input_fingerprint": _par_fp,
                                        "input_ready": _par_input_ready,
                                    }

                                if not req.force and par_idx not in req.force_step_indices:
                                    _cached = None
                                    _cached_via_resume_partial = False
                                    try:
                                        _cached, _cached_via_resume_partial = _lookup_step_cache(
                                            _par_db, _par_aid, par_idx, _par_fp
                                        )
                                    except Exception as _cache_exc:
                                        log_buffer.emit(
                                            f"[PIPELINE] ⚠ Parallel cache lookup failed for step {par_idx + 1}: {_cache_exc}"
                                        )
                                        _cached = None
                                    if _cached:
                                        return {
                                            "step_idx": par_idx,
                                            "status": "cached",
                                            "content": _cached.content,
                                            "result_id": _cached.id,
                                            "cached_created_at": _cached.created_at.isoformat() if _cached.created_at else None,
                                            "agent_name": _par_aname,
                                            "model": _par_model,
                                            "input_fingerprint": _par_fp,
                                            "input_ready": _par_input_ready,
                                            "cache_mode": "resume_partial" if _cached_via_resume_partial else "exact",
                                        }

                                _par_ic  = sum(len(v) for v in _par_ii.values())
                                _par_fc  = sum(len(v) for v in _par_fi.values())
                                _par_tc  = _par_ic + (_par_fc if _par_model.startswith("grok") else 0)
                                _par_tok = (_par_tc + len(_par_sysp)) // 4
                                if _par_ic and _par_fi:
                                    _par_log = f"{_par_ic:,} chars + {len(_par_fi)} file(s)"
                                elif _par_ic:
                                    _par_log = f"{_par_ic:,} chars"
                                else:
                                    _par_log = f"{len(_par_fi)} file(s)"
                                log_buffer.emit(f"[LLM] {_par_model} — {_par_log} input · {cid_short}")

                                _par_ref_preview = ""
                                try:
                                    _par_ref_map = _resolve_provider_file_refs(_par_model, _par_fi, _par_db)
                                    if _par_ref_map:
                                        _par_request_raw["provider_file_refs"] = dict(_par_ref_map or {})
                                        _par_ref_preview = ", ".join(
                                            f"{k}={v}" for k, v in list(_par_ref_map.items())[:6]
                                        )
                                        if len(_par_ref_map) > 6:
                                            _par_ref_preview += f", …(+{len(_par_ref_map)-6} more)"
                                        log_buffer.emit(
                                            f"[PIPELINE] Step {par_idx + 1} file refs: {_par_ref_preview} · {cid_short}"
                                        )
                                except Exception as _par_ref_exc:
                                    log_buffer.emit(
                                        f"[PIPELINE] ⚠ Step {par_idx + 1} file ref resolution failed: {_par_ref_exc} · {cid_short}"
                                    )

                                _par_t0 = time.time()
                                _par_content, _par_thinking = _llm_call_with_files(
                                    _par_sysp, _par_ut, _par_fi, _par_ii, _par_model, _par_temp, _par_db,
                                )
                                _par_response_raw = _par_content
                                _par_content = _apply_output_postprocess(
                                    raw_output=_par_content,
                                    agent_def=_par_rdef,
                                    step_model=_par_model,
                                    previous_content=_sp,
                                    db_session=_par_db,
                                )
                                _par_exec = round(time.time() - _par_t0, 1)

                                _par_rid = _persist_agent_result(
                                    _agent_id=_par_aid,
                                    _agent_name=_par_aname,
                                    _content=_par_content,
                                    _model=_par_model,
                                    _pipeline_step_index=par_idx,
                                    _input_fingerprint=_par_fp,
                                )

                                return {
                                    "step_idx": par_idx,
                                    "status": "done",
                                    "content": _par_content,
                                    "thinking": _par_thinking,
                                    "exec_time_s": _par_exec,
                                    "input_tok": _par_tok,
                                    "output_tok": len(_par_content) // 4,
                                    "result_id": _par_rid,
                                    "model": _par_model,
                                    "agent_name": _par_aname,
                                    "input_fingerprint": _par_fp,
                                    "input_ready": _par_input_ready,
                                    "file_refs_preview": _par_ref_preview,
                                    "request_raw": _par_request_raw,
                                    "response_raw": _par_response_raw,
                                    "model_info": {
                                        "provider": _model_provider_name(_par_model),
                                        "model": _par_model,
                                        "temperature": _par_temp,
                                        "agent_class": str(_par_rdef.get("agent_class") or ""),
                                        "output_format": str(_par_rdef.get("output_format") or ""),
                                    },
                                }
                        except Exception as exc:
                            return {
                                "step_idx": par_idx,
                                "status": "error",
                                "error_msg": str(exc),
                                "agent_name": _par_aname,
                                "model": _par_model,
                                "input_fingerprint": _par_fp,
                                "input_ready": _par_input_ready,
                            }

                    async def _run_parallel_step(par_idx: int, _sp: str = _stage_prev) -> dict:
                        _par_step = steps[par_idx]
                        _par_aid = _par_step.get("agent_id", "")
                        _par_adef = agent_map[_par_aid]
                        _par_aname = _par_adef.get("name", _par_aid)
                        _par_model = _par_adef.get("model", "gpt-5.4")
                        _future = loop.run_in_executor(None, lambda: _run_parallel_step_sync(par_idx, _sp))
                        _deadline = time.monotonic() + LLM_TIMEOUT_S
                        _next_heartbeat = time.monotonic() + 3.0
                        while True:
                            _raise_if_stop_requested()
                            _remaining = _deadline - time.monotonic()
                            if _remaining <= 0:
                                return {
                                    "step_idx": par_idx,
                                    "status": "error",
                                    "error_msg": f"LLM call timed out after {int(LLM_TIMEOUT_S)}s (model: {_par_model})",
                                    "agent_name": _par_aname,
                                    "model": _par_model,
                                    "input_ready": False,
                                }
                            done_set, _ = await asyncio.wait({_future}, timeout=min(2.0, _remaining))
                            if done_set:
                                return _future.result()
                            if time.monotonic() >= _next_heartbeat:
                                waited_s = int(LLM_TIMEOUT_S - _remaining)
                                _next_heartbeat = time.monotonic() + 3.0
                                log_buffer.emit(
                                    f"[PIPELINE] … Step {par_idx + 1}/{len(steps)} waiting on {_par_model} ({waited_s}s) · {cid_short}"
                                )

                    par_results = list(await asyncio.gather(*[_run_parallel_step(idx) for idx in step_indices]))

                    stage_had_error = False
                    for _res in par_results:
                        _ri   = _res["step_idx"]
                        _rst  = _res["status"]
                        _rn   = _res.get("agent_name", "")
                        _rm   = _res.get("model", "")
                        if _rst == "input_prepared":
                            run_steps[_ri].update({
                                "state": "input_prepared",
                                "end_time": datetime.utcnow().isoformat(),
                                "input_ready": _res.get("input_ready", True),
                                "cache_mode": "input_prepared",
                                "error_msg": "",
                                "input_fingerprint": _res.get("input_fingerprint", ""),
                            })
                            save_steps()
                            log_buffer.emit(
                                f"[PIPELINE] ↺ Step {_ri + 1}/{len(steps)}: {_rn} → input prepared · {cid_short}"
                            )
                            yield _sse("input_ready", {"step": _ri})
                            yield _sse("input_prepared", {
                                "step": _ri,
                                "agent_name": _rn,
                                "input_fingerprint": _res.get("input_fingerprint", ""),
                            })
                        elif _rst == "cached":
                            _persist_structured_artifact(
                                _step_idx=_ri,
                                _content=_res["content"],
                                _model=_rm,
                                _agent_name=_rn,
                                _input_fingerprint=_res.get("input_fingerprint", ""),
                            )
                            run_steps[_ri].update({
                                "state":            "completed",
                                "end_time":         datetime.utcnow().isoformat(),
                                "content":          _res["content"],
                                "input_ready":      _res.get("input_ready", True),
                                "cache_mode":       _res.get("cache_mode", "exact"),
                                "cached_locations": [{
                                    "type": "agent_result",
                                    "id": _res.get("result_id", ""),
                                    "created_at": _res.get("cached_created_at"),
                                }],
                                "input_fingerprint": _res.get("input_fingerprint", ""),
                            })
                            save_steps()  # write BEFORE yield so file is correct if client disconnects
                            if _res.get("cache_mode") == "resume_partial":
                                log_buffer.emit(
                                    f"[PIPELINE] ↩ Step {_ri + 1}/{len(steps)}: {_rn} → cached (resume fallback) · {cid_short}"
                                )
                            else:
                                log_buffer.emit(
                                    f"[PIPELINE] ↩ Step {_ri + 1}/{len(steps)}: {_rn} → cached · {cid_short}"
                                )
                            yield _sse("step_cached", {"step": _ri, "agent_name": _rn,
                                                        "result_id": _res.get("result_id", ""), "content": _res["content"],
                                                        "cache_mode": _res.get("cache_mode", "exact")})
                            _touch_pipeline_artifact(
                                _step_idx=_ri,
                                _agent_id=steps[_ri].get("agent_id", ""),
                                _agent_name=_rn,
                                _model=_rm,
                                _result_id=str(_res.get("result_id", "") or ""),
                                _input_fingerprint=_res.get("input_fingerprint", ""),
                                _source="cached_resume" if _res.get("cache_mode") == "resume_partial" else "cached_exact",
                            )
                        elif _rst == "done":
                            _rc  = _res["content"]
                            _ret = _res["exec_time_s"]
                            _file_refs_preview = str(_res.get("file_refs_preview") or "").strip()
                            if _file_refs_preview:
                                yield _sse("progress", {
                                    "step": _ri,
                                    "msg": f"Step {_ri + 1} file refs: {_file_refs_preview}",
                                })
                            _persist_structured_artifact(
                                _step_idx=_ri,
                                _content=_rc,
                                _model=_rm,
                                _agent_name=_rn,
                                _input_fingerprint=_res.get("input_fingerprint", ""),
                            )
                            run_steps[_ri].update({
                                "state":            "completed",
                                "end_time":         datetime.utcnow().isoformat(),
                                "content":          _rc,
                                "input_ready":      _res.get("input_ready", True),
                                "execution_time_s": _ret,
                                "input_token_est":  _res["input_tok"],
                                "output_token_est": _res["output_tok"],
                                "thinking":         (_res.get("thinking") or "")[:8000],
                                "model_info":       (_res.get("model_info") or {}),
                                "request_raw":      (_res.get("request_raw") or {}),
                                "response_raw":     (_res.get("response_raw") or ""),
                                "input_fingerprint": _res.get("input_fingerprint", ""),
                            })
                            save_steps()  # write BEFORE yields so file is correct if client disconnects
                            log_buffer.emit(f"[LLM] {_rm} — done ({len(_rc):,} chars, {_ret}s) · {cid_short}")
                            log_buffer.emit(f"[PIPELINE] ✓ Step {_ri + 1}/{len(steps)}: {_rn} → done ({_ret}s) · {cid_short}")
                            if _res.get("thinking"):
                                yield _sse("thinking", {"content": _res["thinking"][:5000], "step": _ri})
                            yield _sse("step_done", {
                                "step":             _ri,
                                "agent_name":       _rn,
                                "result_id":        _res["result_id"],
                                "content":          _rc,
                                "model":            _rm,
                                "execution_time_s": _ret,
                                "input_token_est":  _res["input_tok"],
                                "output_token_est": _res["output_tok"],
                            })
                            _touch_pipeline_artifact(
                                _step_idx=_ri,
                                _agent_id=steps[_ri].get("agent_id", ""),
                                _agent_name=_rn,
                                _model=_rm,
                                _result_id=str(_res.get("result_id", "") or ""),
                                _input_fingerprint=_res.get("input_fingerprint", ""),
                                _source="done",
                            )
                        else:  # error
                            _remsg = _res.get("error_msg", "Unknown error")
                            run_steps[_ri].update({
                                "state": "failed",
                                "end_time": datetime.utcnow().isoformat(),
                                "error_msg": _remsg,
                                "input_fingerprint": _res.get("input_fingerprint", ""),
                                "input_ready": _res.get("input_ready", False),
                            })
                            save_steps()  # write BEFORE yield so file is correct if client disconnects
                            log_buffer.emit(f"[PIPELINE] ✗ Step {_ri + 1}/{len(steps)}: {_rn} → error · {cid_short}")
                            yield _sse("error", {"msg": _remsg, "step": _ri})
                            stage_had_error = True

                    if stage_had_error:
                        fatal_error = True
                        break

                    # prev_content for next stage: last parallel step's output (by index)
                    _last = max(
                        (_r for _r in par_results if _r["status"] in ("done", "cached")),
                        key=lambda _r: _r["step_idx"],
                        default=None,
                    )
                    if _last:
                        prev_content = _last["content"]

            if not fatal_error:
                run_final_status = "done"
                _save_state(pipeline_id, run_id, req.sales_agent, req.customer, "pass", run_steps,
                            start_datetime=run_start_dt, node_states=_build_node_states())
                log_buffer.emit(f"[PIPELINE] ✅ Done: {pipeline_name} · {cid_short}")
                yield _sse("pipeline_done", {})
            else:
                # Explicit error (agent failure, resolve error, etc.) — mark file as failed.
                _save_state(pipeline_id, run_id, req.sales_agent, req.customer, "failed", run_steps,
                            start_datetime=run_start_dt, node_states=_build_node_states())

        except asyncio.CancelledError:
            cancel_msg = cancel_state["reason"]
            execution_error_msg = cancel_msg
            if cancel_msg == "run stopped by user":
                now_iso = datetime.utcnow().isoformat()
                for s in run_steps:
                    raw_st = str(s.get("state") or s.get("status") or "").strip().lower()
                    if raw_st in ("running", "loading", "started"):
                        s["state"] = "cancelled"
                        s["status"] = "cancelled"
                        s["end_time"] = now_iso
                        s["error_msg"] = cancel_msg
                run_final_status = "cancelled"
                log_buffer.emit(f"[PIPELINE] ◼ Cancelled: {pipeline_name} · {cid_short}")
                _save_state(
                    pipeline_id, run_id, req.sales_agent, req.customer, "cancelled", run_steps,
                    start_datetime=run_start_dt, node_states=_build_node_states(),
                )
            else:
                run_final_status = "cancelled"
                _save_state(
                    pipeline_id, run_id, req.sales_agent, req.customer, "running", run_steps,
                    start_datetime=run_start_dt, node_states=_build_node_states(),
                )
                log_buffer.emit(f"[PIPELINE] … Stream disconnected: {pipeline_name} · {cid_short}")
            raise
        except Exception as exc:
            err_msg = f"Pipeline execution failed: {exc}"
            execution_error_msg = err_msg
            now_iso = datetime.utcnow().isoformat()
            for s in run_steps:
                if s.get("state") == "running":
                    s["state"] = "failed"
                    s["end_time"] = now_iso
                    s["error_msg"] = err_msg
            run_final_status = "error"
            _save_state(
                pipeline_id, run_id, req.sales_agent, req.customer, "failed", run_steps,
                start_datetime=run_start_dt, node_states=_build_node_states(),
            )
            log_buffer.emit(f"[PIPELINE] ✗ Fatal: {pipeline_name} · {cid_short} · {exc}")
            try:
                yield _sse("error", {"msg": err_msg})
            except Exception:
                pass

        finally:
            with _ACTIVE_RUN_LOCK:
                _STOP_REQUESTED.pop(run_slot, None)
                cur = _ACTIVE_RUN_TASKS.get(run_slot)
                if cur is asyncio.current_task():
                    _ACTIVE_RUN_TASKS.pop(run_slot, None)

            # On force rerun: delete stale cached results for errored steps so that
            # a page refresh won't show old successful data instead of the error state.
            if req.force:
                try:
                    if _agent_result_has_pipeline_cache:
                        for idx, s in enumerate(run_steps):
                            if s.get("state") == "failed" and s.get("agent_id"):
                                aid = s["agent_id"]
                                stale_stmt = select(AR).where(
                                    AR.agent_id == aid,
                                    AR.sales_agent == req.sales_agent,
                                    AR.customer == req.customer,
                                    AR.pipeline_id == pipeline_id,
                                    AR.pipeline_step_index == idx,
                                )
                                if input_scope_call_id:
                                    stale_stmt = stale_stmt.where(AR.call_id == input_scope_call_id)
                                else:
                                    stale_stmt = stale_stmt.where(AR.call_id == "")
                                fp = s.get("input_fingerprint", "")
                                if fp:
                                    stale_stmt = stale_stmt.where(AR.input_fingerprint == fp)
                                with Session(_db_engine) as _s:
                                    stale_rows = _s.exec(stale_stmt).all()
                                    for stale in stale_rows:
                                        _s.delete(stale)
                                    _s.commit()
                except Exception:
                    pass
            # For production runs triggered by webhook, optionally push notes back to CRM.
            _auto_note_sent_at: Optional[datetime] = None
            try:
                if run_final_status == "done" and run_origin == "webhook":
                    if bool(settings.live_mirror_enabled):
                        log_buffer.emit("[CRM-PUSH] Skipped: disabled in development/mirror environment.")
                    else:
                        _cfg = _load_live_webhook_config()
                        _send_ids = {
                            str(v or "").strip()
                            for v in (_cfg.get("send_note_pipeline_ids") or [])
                            if str(v or "").strip()
                        }
                        if pipeline_id in _send_ids:
                            _note_id = ""
                            for _st in run_steps:
                                _nid = str(_st.get("note_id") or "").strip()
                                if _nid:
                                    _note_id = _nid
                            if _note_id:
                                log_buffer.emit(f"[CRM-PUSH] Sending note {_note_id} to CRM…")
                                try:
                                    from ui.backend.routers.notes import send_note_to_crm_internal
                                    with Session(_db_engine) as _note_s:
                                        _push = send_note_to_crm_internal(
                                            note_id=_note_id,
                                            account_id="",
                                            run_id=run_id,
                                            db=_note_s,
                                        )
                                    _crm_status = str(_push.get("crm_status") or "")
                                    _endpoint = str(_push.get("endpoint") or "")
                                    _auto_note_sent_at = datetime.utcnow()
                                    log_buffer.emit(
                                        f"[CRM-PUSH] ✓ Sent note {_note_id} to CRM"
                                        + (f" (status {_crm_status})" if _crm_status else "")
                                    )
                                    if _endpoint:
                                        log_buffer.emit(f"[CRM-PUSH] endpoint: {_endpoint}")
                                except HTTPException as _crm_http_err:
                                    _detail = _crm_http_err.detail
                                    if isinstance(_detail, (dict, list)):
                                        _detail = json.dumps(_detail, ensure_ascii=False)
                                    log_buffer.emit(
                                        f"[CRM-PUSH] ✗ Failed for note {_note_id}: "
                                        f"{_crm_http_err.status_code} {str(_detail or '').strip()}"
                                    )
                                except Exception as _crm_err:
                                    log_buffer.emit(f"[CRM-PUSH] ✗ Failed for note {_note_id}: {_crm_err}")
                            else:
                                log_buffer.emit("[CRM-PUSH] Skipped: no note artifact produced by this run.")
            except Exception as _crm_outer_err:
                log_buffer.emit(f"[CRM-PUSH] ⚠ Post-run push check failed: {_crm_outer_err}")
            log_lines: list[dict[str, Any]] = []
            try:
                log_lines = [
                    {"ts": l.ts, "text": l.text, "level": l.level}
                    for l in log_buffer.get_after(start_seq)
                ]
                final_steps_json = json.dumps(run_steps, ensure_ascii=False)
                final_log_json = json.dumps(log_lines[-200:], ensure_ascii=False)
                final_finished_at = datetime.utcnow()
                finalized_db = False
                with Session(_db_engine) as _s:
                    _note_sent_val = _auto_note_sent_at is not None
                    _sql_parts = (
                        "UPDATE pipeline_run SET finished_at = :finished_at, status = :status,"
                        " steps_json = :steps_json, log_json = :log_json"
                    )
                    _sql_params: dict[str, Any] = {
                        "finished_at": final_finished_at,
                        "status": run_final_status,
                        "steps_json": final_steps_json,
                        "log_json": final_log_json,
                        "id": run_id,
                    }
                    if _note_sent_val:
                        _sql_parts += ", note_sent = :note_sent, note_sent_at = :note_sent_at"
                        _sql_params["note_sent"] = True
                        _sql_params["note_sent_at"] = _auto_note_sent_at
                    _sql_parts += " WHERE id = :id"
                    _s.execute(_sql_text(_sql_parts), _sql_params)
                    _s.commit()
                    finalized_db = True
                if not finalized_db:
                    raise RuntimeError("final pipeline_run UPDATE did not report success")
            except Exception as _final_write_err:
                # Fallback path: avoid leaving rows stuck in 'running' if the raw SQL
                # update fails for any adapter-specific reason.
                try:
                    with Session(_db_engine) as _s:
                        _row = _s.get(PR, run_id)
                        if _row is not None:
                            _row.finished_at = datetime.utcnow()
                            _row.status = run_final_status
                            _row.steps_json = json.dumps(run_steps, ensure_ascii=False)
                            if _auto_note_sent_at is not None:
                                _row.note_sent = True
                                _row.note_sent_at = _auto_note_sent_at
                            _row.log_json = json.dumps(log_lines[-200:], ensure_ascii=False)
                            _s.add(_row)
                            _s.commit()
                        else:
                            raise RuntimeError(f"pipeline_run row not found: {run_id}")
                except Exception as _fallback_err:
                    _msg = (
                        f"Pipeline final DB write failed (primary={_final_write_err}; "
                        f"fallback={_fallback_err})"
                    )
                    log_buffer.emit(f"[PIPELINE] ⚠ {_msg} · {cid_short}")
                    try:
                        execution_logs.append_event(
                            execution_session_id,
                            "Pipeline final DB write failed",
                            level="error",
                            status="failed",
                            error=_msg,
                            data={"run_id": run_id, "pipeline_id": pipeline_id},
                        )
                    except Exception:
                        pass
            try:
                if not execution_error_msg:
                    _step_errors = [
                        str(s.get("error_msg") or "").strip()
                        for s in run_steps
                        if str(s.get("state") or "") == "failed" and str(s.get("error_msg") or "").strip()
                    ]
                    if _step_errors:
                        execution_error_msg = " | ".join(_step_errors[:5])

                _status_counts: dict[str, int] = {"waiting": 0, "running": 0, "completed": 0, "failed": 0}
                _step_summaries: list[dict[str, Any]] = []
                for _idx, _step in enumerate(run_steps):
                    _state = str(_step.get("state") or "waiting")
                    _status_counts[_state] = _status_counts.get(_state, 0) + 1
                    _step_summaries.append(
                        {
                            "step_index": _idx,
                            "agent_id": _step.get("agent_id", ""),
                            "agent_name": _step.get("agent_name", ""),
                            "model": _step.get("model", ""),
                            "state": _state,
                            "start_time": _step.get("start_time"),
                            "end_time": _step.get("end_time"),
                            "execution_time_s": _step.get("execution_time_s"),
                            "cached": bool(_step.get("cached_locations")),
                            "error_msg": _step.get("error_msg", ""),
                        }
                    )

                _exec_status = (
                    "success"
                    if run_final_status == "done"
                    else "cancelled"
                    if run_final_status == "cancelled"
                    else "failed"
                )
                execution_logs.finish_session(
                    execution_session_id,
                    status=_exec_status,
                    report={
                        "pipeline_id": pipeline_id,
                        "pipeline_name": pipeline_name,
                        "run_id": run_id,
                        "run_slot": run_slot,
                        "sales_agent": req.sales_agent,
                        "customer": req.customer,
                        "call_id": input_scope_call_id,
                        "final_status": run_final_status,
                        "steps_total": len(run_steps),
                        "status_counts": _status_counts,
                        "step_summaries": _step_summaries,
                        "log_lines_tail": log_lines[-500:],
                    },
                    error=execution_error_msg,
                )
            except Exception as _elog_err:
                log_buffer.emit(f"[PIPELINE] ⚠ Execution log finalize failed: {_elog_err}")

    # Run the pipeline in a background task that broadcasts SSE payloads to subscribers.
    # This decouples execution from the client HTTP stream so page refresh/navigation
    # does not cancel the run.
    q: asyncio.Queue = asyncio.Queue(maxsize=1000)
    sub_token = str(uuid.uuid4())

    with _ACTIVE_RUN_LOCK:
        old_ev = _STOP_REQUESTED.get(run_slot)
        old_task = _ACTIVE_RUN_TASKS.get(run_slot)
        if old_ev:
            old_ev.set()
        if old_task and not old_task.done():
            old_task.cancel()
        _RUN_SUBSCRIBERS.setdefault(run_slot, []).append((sub_token, q))

    async def _broadcast_worker():
        try:
            async for payload in stream():
                with _ACTIVE_RUN_LOCK:
                    subs = list(_RUN_SUBSCRIBERS.get(run_slot, []))
                for tok, sq in subs:
                    if tok != sub_token:
                        continue
                    try:
                        sq.put_nowait(payload)
                    except Exception:
                        pass
        finally:
            with _ACTIVE_RUN_LOCK:
                subs = list(_RUN_SUBSCRIBERS.get(run_slot, []))
                keep: list[tuple[str, asyncio.Queue]] = []
                mine: list[asyncio.Queue] = []
                for tok, sq in subs:
                    if tok == sub_token:
                        mine.append(sq)
                    else:
                        keep.append((tok, sq))
                if keep:
                    _RUN_SUBSCRIBERS[run_slot] = keep
                else:
                    _RUN_SUBSCRIBERS.pop(run_slot, None)
            for sq in mine:
                try:
                    sq.put_nowait(None)
                except Exception:
                    pass

    worker_task = asyncio.create_task(_broadcast_worker())
    with _ACTIVE_RUN_LOCK:
        _ACTIVE_RUN_TASKS[run_slot] = worker_task

    async def stream_subscriber():
        try:
            while True:
                item = await q.get()
                if item is None:
                    break
                yield item
        except asyncio.CancelledError:
            # Client disconnected; keep background worker running.
            return
        finally:
            with _ACTIVE_RUN_LOCK:
                subs = _RUN_SUBSCRIBERS.get(run_slot, [])
                pair = (sub_token, q)
                if pair in subs:
                    try:
                        subs.remove(pair)
                    except ValueError:
                        pass
                if not subs:
                    _RUN_SUBSCRIBERS.pop(run_slot, None)

    return StreamingResponse(
        stream_subscriber(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )
