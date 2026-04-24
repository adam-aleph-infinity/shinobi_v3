"""Persistent knowledge + artifacts store for Copilot.

All copilot artifacts are stored under `ui/data/copilot/`:
- app_map.json
- memory.json
- skills.json
- distillation_state.json
- sub_agents/*.json
- sessions/*.json (managed by assistant router)
"""
from __future__ import annotations

import json
import shutil
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from sqlmodel import Session, select

from ui.backend.config import settings
from ui.backend.database import engine
from ui.backend.models.pipeline_run import PipelineRun
from ui.backend.routers import pipelines as pipelines_router
from ui.backend.routers import universal_agents as universal_agents_router

_ROOT = settings.ui_data_dir / "copilot"
_ROOT.mkdir(parents=True, exist_ok=True)
(_ROOT / "sub_agents").mkdir(parents=True, exist_ok=True)
(_ROOT / "sessions").mkdir(parents=True, exist_ok=True)

_LEGACY_ROOT = settings.ui_data_dir / "_assistant_knowledge"

_APP_MAP_PATH = _ROOT / "app_map.json"
_MEMORY_PATH = _ROOT / "memory.json"
_SKILLS_PATH = _ROOT / "skills.json"
_DISTILL_STATE_PATH = _ROOT / "distillation_state.json"
_SUB_AGENT_DIR = _ROOT / "sub_agents"

_MAX_TEXT = 12000

_SUCCESS_STATES = {"success", "succeeded", "done", "completed", "complete", "ok"}
_FAILURE_STATES = {"failed", "error", "errored", "timeout", "cancelled", "canceled"}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _now_iso() -> str:
    return _now().isoformat()


def artifact_root() -> Path:
    return _ROOT


def _safe_text(s: Any, cap: int = _MAX_TEXT) -> str:
    txt = str(s or "").strip()
    if len(txt) > cap:
        return txt[:cap]
    return txt


def _save_json(path: Path, payload: Any) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def _load_json_dict(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return raw if isinstance(raw, dict) else {}


def _load_json_list(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return []
    if not isinstance(raw, list):
        return []
    return [r for r in raw if isinstance(r, dict)]


def _tokenize(text: str) -> list[str]:
    raw = _safe_text(text, cap=20000).lower()
    buf: list[str] = []
    cur: list[str] = []
    for ch in raw:
        if ch.isalnum() or ch in {"_", "-"}:
            cur.append(ch)
        else:
            if cur:
                buf.append("".join(cur))
                cur = []
    if cur:
        buf.append("".join(cur))
    return [t for t in buf if len(t) >= 3]


def _score_match(query: str, candidate: str) -> float:
    q_tokens = set(_tokenize(query))
    if not q_tokens:
        return 0.0
    c_tokens = set(_tokenize(candidate))
    if not c_tokens:
        return 0.0
    inter = len(q_tokens.intersection(c_tokens))
    if inter == 0:
        return 0.0
    return inter / max(1, len(q_tokens))


def _migrate_legacy_data() -> None:
    if not _LEGACY_ROOT.exists() or not _LEGACY_ROOT.is_dir():
        return
    for name, target in (
        ("app_map.json", _APP_MAP_PATH),
        ("memory.json", _MEMORY_PATH),
        ("skills.json", _SKILLS_PATH),
    ):
        legacy = _LEGACY_ROOT / name
        if not target.exists() and legacy.exists():
            try:
                shutil.copy2(legacy, target)
            except Exception:
                pass


_migrate_legacy_data()


def ensure_app_map(tool_specs: list[dict[str, Any]], force: bool = False) -> dict[str, Any]:
    now = _now_iso()
    if _APP_MAP_PATH.exists() and not force:
        existing = _load_json_dict(_APP_MAP_PATH)
        if existing:
            existing.setdefault("generated_at", now)
            return existing

    agents = universal_agents_router._load_all()
    pipelines = pipelines_router._load_all()

    with Session(engine) as db:
        total_runs = db.exec(select(PipelineRun)).all()

    app_map = {
        "generated_at": now,
        "summary": {
            "agent_count": len(agents),
            "pipeline_count": len(pipelines),
            "run_count": len(total_runs),
        },
        "tools": [
            {
                "name": str((t.get("function") or {}).get("name") or ""),
                "description": str((t.get("function") or {}).get("description") or ""),
            }
            for t in tool_specs
        ],
        "agents": [
            {
                "id": str(a.get("id") or ""),
                "name": str(a.get("name") or ""),
                "agent_class": str(a.get("agent_class") or ""),
                "model": str(a.get("model") or ""),
                "folder": str(a.get("folder") or ""),
            }
            for a in agents
        ],
        "pipelines": [
            {
                "id": str(p.get("id") or ""),
                "name": str(p.get("name") or ""),
                "description": str(p.get("description") or ""),
                "scope": str(p.get("scope") or ""),
                "folder": str(p.get("folder") or ""),
                "step_count": len(p.get("steps") or []),
                "step_agent_ids": [
                    str((s or {}).get("agent_id") or "")
                    for s in (p.get("steps") or [])
                    if isinstance(s, dict)
                ],
            }
            for p in pipelines
        ],
    }
    _save_json(_APP_MAP_PATH, app_map)
    return app_map


def get_app_map() -> dict[str, Any]:
    payload = _load_json_dict(_APP_MAP_PATH)
    if payload:
        return payload
    return {"generated_at": _now_iso(), "summary": {}, "tools": [], "agents": [], "pipelines": []}


def add_memory(
    *,
    text: str,
    source: str,
    kind: str = "lesson",
    confidence: float = 0.7,
    tags: list[str] | None = None,
    meta: dict[str, Any] | None = None,
) -> dict[str, Any]:
    rows = _load_json_list(_MEMORY_PATH)
    row = {
        "id": str(uuid.uuid4()),
        "kind": _safe_text(kind, cap=48) or "lesson",
        "text": _safe_text(text),
        "source": _safe_text(source, cap=120) or "assistant",
        "confidence": max(0.0, min(1.0, float(confidence))),
        "tags": [str(t).strip().lower() for t in (tags or []) if str(t).strip()],
        "meta": meta or {},
        "created_at": _now_iso(),
        "updated_at": _now_iso(),
        "last_used_at": "",
    }
    rows.append(row)
    if len(rows) > 3000:
        rows = rows[-3000:]
    _save_json(_MEMORY_PATH, rows)
    return row


def list_memory(limit: int = 50, query: str = "") -> list[dict[str, Any]]:
    rows = _load_json_list(_MEMORY_PATH)
    cap = max(1, min(500, int(limit)))
    if not query.strip():
        return rows[-cap:][::-1]

    q = query.strip()
    scored: list[tuple[float, dict[str, Any]]] = []
    for row in rows:
        blob = " ".join(
            [
                str(row.get("text") or ""),
                " ".join(str(t) for t in (row.get("tags") or [])),
                str(row.get("kind") or ""),
            ]
        )
        score = _score_match(q, blob)
        if score > 0:
            scored.append((score, row))
    scored.sort(key=lambda x: x[0], reverse=True)
    return [r for _, r in scored[:cap]]


def upsert_skill(
    *,
    name: str,
    guidance: str,
    source: str,
    confidence: float = 0.7,
    tags: list[str] | None = None,
    meta: dict[str, Any] | None = None,
) -> dict[str, Any]:
    rows = _load_json_list(_SKILLS_PATH)
    nm = _safe_text(name, cap=120) or "Unnamed skill"
    target = None
    for row in rows:
        if str(row.get("name") or "").strip().lower() == nm.lower():
            target = row
            break

    now = _now_iso()
    payload = {
        "name": nm,
        "guidance": _safe_text(guidance),
        "source": _safe_text(source, cap=120) or "assistant",
        "confidence": max(0.0, min(1.0, float(confidence))),
        "tags": [str(t).strip().lower() for t in (tags or []) if str(t).strip()],
        "meta": meta or {},
        "updated_at": now,
    }
    if target:
        target.update(payload)
        row = target
    else:
        row = {
            "id": str(uuid.uuid4()),
            "created_at": now,
            **payload,
        }
        rows.append(row)

    if len(rows) > 2000:
        rows = rows[-2000:]
    _save_json(_SKILLS_PATH, rows)
    return row


def list_skills(limit: int = 50, query: str = "") -> list[dict[str, Any]]:
    rows = _load_json_list(_SKILLS_PATH)
    cap = max(1, min(500, int(limit)))
    if not query.strip():
        return rows[-cap:][::-1]

    q = query.strip()
    scored: list[tuple[float, dict[str, Any]]] = []
    for row in rows:
        blob = " ".join(
            [
                str(row.get("name") or ""),
                str(row.get("guidance") or ""),
                " ".join(str(t) for t in (row.get("tags") or [])),
            ]
        )
        score = _score_match(q, blob)
        if score > 0:
            scored.append((score, row))
    scored.sort(key=lambda x: x[0], reverse=True)
    return [r for _, r in scored[:cap]]


def _status_is_success(status: str) -> bool:
    return str(status or "").strip().lower() in _SUCCESS_STATES


def _parse_steps_json(raw: str) -> list[dict[str, Any]]:
    try:
        parsed = json.loads(raw or "[]")
    except Exception:
        return []
    if not isinstance(parsed, list):
        return []
    return [row for row in parsed if isinstance(row, dict)]


def _parse_log_json(raw: str) -> list[dict[str, Any]]:
    try:
        parsed = json.loads(raw or "[]")
    except Exception:
        return []
    if not isinstance(parsed, list):
        return []
    return [row for row in parsed if isinstance(row, dict)]


def _distill_state() -> dict[str, Any]:
    state = _load_json_dict(_DISTILL_STATE_PATH)
    if not state:
        state = {}
    state.setdefault("processed_success_run_ids", [])
    state.setdefault("last_scan_at", "")
    state.setdefault("last_distilled_at", "")
    state.setdefault("last_distilled_run_ids", [])
    return state


def _save_distill_state(state: dict[str, Any]) -> None:
    _save_json(_DISTILL_STATE_PATH, state)


def distill_skills_from_successful_runs(
    *,
    limit: int = 120,
    force: bool = False,
    min_interval_seconds: int = 300,
) -> dict[str, Any]:
    state = _distill_state()
    now = _now()
    last_scan = str(state.get("last_scan_at") or "")
    if not force and last_scan:
        try:
            dt = datetime.fromisoformat(last_scan)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            if now - dt < timedelta(seconds=max(1, int(min_interval_seconds))):
                return {
                    "ok": True,
                    "skipped": True,
                    "reason": "scan_interval_guard",
                    "last_scan_at": last_scan,
                    "distilled": 0,
                    "scanned": 0,
                }
        except Exception:
            pass

    cap = max(1, min(500, int(limit)))
    with Session(engine) as db:
        candidate_rows = db.exec(
            select(PipelineRun).order_by(PipelineRun.finished_at.desc(), PipelineRun.started_at.desc()).limit(cap * 3)
        ).all()

    success_rows = [r for r in candidate_rows if _status_is_success(getattr(r, "status", ""))][:cap]
    processed: list[str] = [str(x) for x in (state.get("processed_success_run_ids") or []) if str(x).strip()]
    processed_set = set(processed)

    distilled = 0
    touched_run_ids: list[str] = []

    for run in success_rows:
        run_id = str(getattr(run, "id", "") or "").strip()
        if not run_id or run_id in processed_set:
            continue

        steps = _parse_steps_json(getattr(run, "steps_json", "") or "")
        logs = _parse_log_json(getattr(run, "log_json", "") or "")

        # If run says success but contains failed step states, skip distillation but mark processed.
        bad_state = False
        step_names: list[str] = []
        step_agent_ids: list[str] = []
        for idx, st in enumerate(steps):
            s_state = str(st.get("state") or st.get("status") or "").strip().lower()
            if s_state in _FAILURE_STATES:
                bad_state = True
            label = str(st.get("agent_name") or st.get("name") or st.get("agent_id") or f"step_{idx + 1}").strip()
            if label:
                step_names.append(label)
            aid = str(st.get("agent_id") or "").strip()
            if aid:
                step_agent_ids.append(aid)

        processed_set.add(run_id)
        touched_run_ids.append(run_id)

        if bad_state or not step_names:
            continue

        pipeline_label = str(getattr(run, "pipeline_name", "") or getattr(run, "pipeline_id", "") or "Unnamed Pipeline").strip()
        sales_agent = str(getattr(run, "sales_agent", "") or "").strip()
        customer = str(getattr(run, "customer", "") or "").strip()
        call_id = str(getattr(run, "call_id", "") or "").strip()

        hints: list[str] = []
        for row in logs[-120:]:
            text = str(row.get("text") or "")
            lo = text.lower()
            if any(k in lo for k in ("retry", "cache", "fallback", "timeout", "rate", "guardrail", "validation")):
                hints.append(text[:200])
            if len(hints) >= 8:
                break

        sequence = " -> ".join(step_names[:18])
        skill_name = f"Pipeline success pattern: {pipeline_label}"
        guidance = (
            f"Recent successful run pattern for '{pipeline_label}'.\n"
            f"Recommended step sequence: {sequence}\n"
            "When building similar pipelines, keep this ordering unless user requirements demand otherwise.\n"
            "Validate each agent_id exists before create/update and verify run status/logs after execution."
        )
        if hints:
            guidance += "\nOperational hints observed:\n- " + "\n- ".join(hints[:5])

        upsert_skill(
            name=skill_name,
            guidance=guidance,
            source="auto_distillation",
            confidence=0.78,
            tags=[
                "pipeline",
                "success_pattern",
                str(getattr(run, "pipeline_id", "") or "").strip(),
                pipeline_label.lower()[:80],
            ],
            meta={
                "pipeline_id": str(getattr(run, "pipeline_id", "") or ""),
                "last_run_id": run_id,
                "sales_agent": sales_agent,
                "customer": customer,
                "call_id": call_id,
                "step_agent_ids": step_agent_ids[:30],
            },
        )
        add_memory(
            kind="run_distillation",
            source="auto_distillation",
            confidence=0.72,
            tags=["distillation", "pipeline", "success"],
            text=(
                f"Successful run distilled for pipeline '{pipeline_label}'.\n"
                f"Run ID: {run_id}\n"
                f"Sequence: {sequence}"
            ),
            meta={"pipeline_id": str(getattr(run, "pipeline_id", "") or ""), "run_id": run_id},
        )
        distilled += 1

    processed_merged = processed + [rid for rid in touched_run_ids if rid not in set(processed)]
    # Keep recent processed IDs to bound state size.
    processed_merged = processed_merged[-6000:]

    state["processed_success_run_ids"] = processed_merged
    state["last_scan_at"] = _now_iso()
    if distilled > 0:
        state["last_distilled_at"] = _now_iso()
        state["last_distilled_run_ids"] = touched_run_ids[-100:]
    _save_distill_state(state)

    return {
        "ok": True,
        "skipped": False,
        "scanned": len(success_rows),
        "distilled": distilled,
        "newly_processed_runs": len(touched_run_ids),
        "last_scan_at": state.get("last_scan_at"),
        "last_distilled_at": state.get("last_distilled_at"),
    }


def get_distillation_state() -> dict[str, Any]:
    state = _distill_state()
    # Avoid returning huge ID arrays to model contexts.
    ids = state.get("processed_success_run_ids") or []
    state["processed_success_run_count"] = len(ids)
    state["processed_success_run_ids"] = ids[-30:]
    return state


def save_sub_agent_artifact(payload: dict[str, Any]) -> dict[str, Any]:
    aid = str(uuid.uuid4())
    path = _SUB_AGENT_DIR / f"{aid}.json"
    artifact = {
        "id": aid,
        "created_at": _now_iso(),
        "payload": payload if isinstance(payload, dict) else {"raw": str(payload)},
    }
    _save_json(path, artifact)
    return {
        "id": aid,
        "path": str(path.relative_to(settings.ui_data_dir)),
        "created_at": artifact["created_at"],
    }


def context_pack(query: str, *, memory_limit: int = 6, skills_limit: int = 6) -> dict[str, Any]:
    return {
        "app_map": get_app_map(),
        "skills": list_skills(limit=skills_limit, query=query),
        "memory": list_memory(limit=memory_limit, query=query),
        "distillation_state": get_distillation_state(),
        "generated_at": _now_iso(),
    }
