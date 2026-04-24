"""Persistent knowledge store for Copilot.

Auto-generates an app map and stores learned memories/skills that the assistant
can retrieve and update over time.
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from sqlmodel import Session, select

from ui.backend.config import settings
from ui.backend.database import engine
from ui.backend.models.pipeline_run import PipelineRun
from ui.backend.routers import pipelines as pipelines_router
from ui.backend.routers import universal_agents as universal_agents_router

_ROOT = settings.ui_data_dir / "_assistant_knowledge"
_ROOT.mkdir(parents=True, exist_ok=True)

_APP_MAP_PATH = _ROOT / "app_map.json"
_MEMORY_PATH = _ROOT / "memory.json"
_SKILLS_PATH = _ROOT / "skills.json"

_MAX_TEXT = 12000


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _safe_text(s: Any, cap: int = _MAX_TEXT) -> str:
    txt = str(s or "").strip()
    if len(txt) > cap:
        return txt[:cap]
    return txt


def _load_json_list(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return []
    if not isinstance(raw, list):
        return []
    out: list[dict[str, Any]] = []
    for row in raw:
        if isinstance(row, dict):
            out.append(row)
    return out


def _save_json(path: Path, payload: Any) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def _tokenize(text: str) -> list[str]:
    raw = _safe_text(text, cap=20000).lower()
    buf = []
    cur = []
    for ch in raw:
        if ch.isalnum() or ch in {"_", "-"}:
            cur.append(ch)
        else:
            if cur:
                buf.append("".join(cur))
                cur = []
    if cur:
        buf.append("".join(cur))
    # prefer meaningful terms
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


def ensure_app_map(tool_specs: list[dict[str, Any]], force: bool = False) -> dict[str, Any]:
    now = _now_iso()
    if _APP_MAP_PATH.exists() and not force:
        try:
            existing = json.loads(_APP_MAP_PATH.read_text(encoding="utf-8"))
            if isinstance(existing, dict):
                existing.setdefault("generated_at", now)
                return existing
        except Exception:
            pass

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
                "step_agent_ids": [str((s or {}).get("agent_id") or "") for s in (p.get("steps") or []) if isinstance(s, dict)],
            }
            for p in pipelines
        ],
    }
    _save_json(_APP_MAP_PATH, app_map)
    return app_map


def get_app_map() -> dict[str, Any]:
    if not _APP_MAP_PATH.exists():
        return {"generated_at": _now_iso(), "summary": {}, "tools": [], "agents": [], "pipelines": []}
    try:
        payload = json.loads(_APP_MAP_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {"generated_at": _now_iso(), "summary": {}, "tools": [], "agents": [], "pipelines": []}
    if not isinstance(payload, dict):
        return {"generated_at": _now_iso(), "summary": {}, "tools": [], "agents": [], "pipelines": []}
    return payload


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
    # Keep recency-bounded file growth.
    if len(rows) > 2000:
        rows = rows[-2000:]
    _save_json(_MEMORY_PATH, rows)
    return row


def list_memory(limit: int = 50, query: str = "") -> list[dict[str, Any]]:
    rows = _load_json_list(_MEMORY_PATH)
    if not query.strip():
        return rows[-max(1, min(500, int(limit))):][::-1]

    q = query.strip()
    scored = []
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
    return [r for _, r in scored[: max(1, min(500, int(limit)))]]


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

    if len(rows) > 1000:
        rows = rows[-1000:]
    _save_json(_SKILLS_PATH, rows)
    return row


def list_skills(limit: int = 50, query: str = "") -> list[dict[str, Any]]:
    rows = _load_json_list(_SKILLS_PATH)
    if not query.strip():
        return rows[-max(1, min(500, int(limit))):][::-1]

    q = query.strip()
    scored = []
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
    return [r for _, r in scored[: max(1, min(500, int(limit)))]]


def context_pack(query: str, *, memory_limit: int = 6, skills_limit: int = 6) -> dict[str, Any]:
    return {
        "app_map": get_app_map(),
        "skills": list_skills(limit=skills_limit, query=query),
        "memory": list_memory(limit=memory_limit, query=query),
        "generated_at": _now_iso(),
    }
