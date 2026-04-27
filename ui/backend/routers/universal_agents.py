"""Universal Agents — flexible multi-input LLM agent definitions."""
import asyncio
import json
import os
import queue as _queue
import random
import re as _re
import threading
import time
import uuid
from datetime import datetime
from typing import Any, Optional

import requests
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import inspect as _sa_inspect
from sqlalchemy import text as _sql_text
from sqlmodel import Session, select

from ui.backend.config import settings
from ui.backend.database import get_session
from ui.backend.services import log_buffer

router = APIRouter(prefix="/universal-agents", tags=["universal-agents"])

_DIR          = settings.ui_data_dir / "_universal_agents"
_PIPELINES    = settings.ui_data_dir / "_pipelines"
_FPA_PRESETS  = settings.ui_data_dir / "_fpa_analyzer_presets"
_NOTES_AGENTS = settings.ui_data_dir / "_notes_agents"
_FOLDERS_FILE = settings.ui_data_dir / "_universal_agents_folders.json"
_AI_REGISTRY_DIR = settings.ui_data_dir / "_ai_registry"
_AI_AGENTS_FILE = _AI_REGISTRY_DIR / "universal_agents_snapshot.json"
_AI_README_FILE = _AI_REGISTRY_DIR / "README.md"

# Valid input source types
INPUT_SOURCES = [
    "transcript",         # single call transcript
    "merged_transcript",  # all transcripts for the pair merged
    "notes",              # notes for a specific call
    "merged_notes",       # all notes aggregated for the pair
    "artifact_persona",   # latest persona artifact for context
    "artifact_persona_score",      # latest persona score artifact for context
    "artifact_notes",              # latest notes artifact for context
    "artifact_notes_compliance",   # latest notes compliance artifact for context
    "agent_output",       # output of another specific agent
    "artifact_output",    # output of previous pipeline stage (generic artifact alias)
    "chain_previous",     # legacy alias for artifact_output
    "manual",             # user provides at run time
]

_MERGED_SCOPE_VALUES = {"auto", "all", "upto_call"}
_OUTPUT_CONTRACT_MODES = {"off", "soft", "strict"}
_OUTPUT_FIT_STRATEGIES = {"structured", "raw"}


class AgentInput(BaseModel):
    key: str                          # template variable name, used as {key} in prompts
    source: str                       # one of INPUT_SOURCES
    agent_id: Optional[str] = None   # required when source == "agent_output"
    label: Optional[str] = None      # human-readable label (auto-derived if omitted)
    merged_scope: Optional[str] = "auto"  # auto | all | upto_call (for merged_* sources)
    merged_until_call_id: Optional[str] = ""  # optional fixed cutoff call id when merged_scope=upto_call


class UniversalAgentIn(BaseModel):
    name: str
    description: str = ""
    agent_class: str = ""    # user-defined class: notes | persona | compliance | scorer | custom…
    model: str = "gpt-5.4"
    temperature: float = 0.0
    system_prompt: str = ""
    user_prompt: str = ""
    inputs: list[AgentInput] = []
    output_format: str = "markdown"  # markdown | json | text
    artifact_type: str = ""          # user-defined artifact type label (e.g., notes, persona, compliance)
    artifact_class: str = ""         # user-defined artifact class/subtype label
    output_schema: str = ""          # optional required output schema/template contract
    output_taxonomy: list[str] = []  # optional canonical sections/labels for output
    output_contract_mode: str = "soft"  # off | soft | strict
    output_fit_strategy: str = "structured"  # structured | raw
    tags: list[str] = []
    is_default: bool = False
    folder: str = ""


class FolderIn(BaseModel):
    name: str


class FolderMoveIn(BaseModel):
    folder: str = ""


# ── Helpers ───────────────────────────────────────────────────────────────────

def _load_all() -> list[dict]:
    _DIR.mkdir(parents=True, exist_ok=True)
    out = []
    for f in sorted(_DIR.glob("*.json")):
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            if isinstance(data, dict) and data.get("id"):
                out.append(_normalize_agent_record(data))
        except Exception:
            pass
    return out


def _find_file(agent_id: str) -> tuple[Any, dict]:
    for f in _DIR.glob("*.json"):
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            if data.get("id") == agent_id:
                return f, _normalize_agent_record(data)
        except Exception:
            pass
    raise HTTPException(404, f"Universal agent '{agent_id}' not found")


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


def _next_copy_name(base_name: str) -> str:
    base = str(base_name or "Agent").strip() or "Agent"
    existing = {str(a.get("name", "")).strip().lower() for a in _load_all()}
    candidate = f"Copy of {base}"
    if candidate.lower() not in existing:
        return candidate
    i = 2
    while True:
        candidate = f"Copy of {base} ({i})"
        if candidate.lower() not in existing:
            return candidate
        i += 1


def _normalize_merged_scope(value: Any) -> str:
    v = str(value or "").strip().lower() or "auto"
    return v if v in _MERGED_SCOPE_VALUES else "auto"


def _normalize_output_contract_mode(value: Any) -> str:
    v = str(value or "").strip().lower() or "soft"
    return v if v in _OUTPUT_CONTRACT_MODES else "soft"


def _normalize_output_fit_strategy(value: Any) -> str:
    v = str(value or "").strip().lower() or "structured"
    return v if v in _OUTPUT_FIT_STRATEGIES else "structured"


def _normalize_input_def(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    key = str(value.get("key") or "").strip()
    source = _normalize_input_source(str(value.get("source") or "manual"))
    if source not in INPUT_SOURCES:
        source = "manual"
    out = {
        "key": key or "input",
        "source": source,
    }
    agent_id = str(value.get("agent_id") or "").strip()
    if agent_id:
        out["agent_id"] = agent_id
    label = str(value.get("label") or "").strip()
    if label:
        out["label"] = label
    merged_scope = _normalize_merged_scope(value.get("merged_scope"))
    merged_until_call_id = str(value.get("merged_until_call_id") or "").strip()
    out["merged_scope"] = merged_scope
    out["merged_until_call_id"] = merged_until_call_id
    return out


def _normalize_agent_record(data: dict[str, Any]) -> dict[str, Any]:
    out = dict(data or {})
    out["folder"] = _normalise_folder(out.get("folder", ""))
    out["inputs"] = [
        _normalize_input_def(x)
        for x in (out.get("inputs") or [])
        if isinstance(x, dict)
    ]
    out["artifact_type"] = str(out.get("artifact_type") or "").strip()
    out["artifact_class"] = str(out.get("artifact_class") or "").strip()
    out["output_schema"] = str(out.get("output_schema") or "").strip()
    raw_tax = out.get("output_taxonomy")
    tax = [str(x or "").strip() for x in raw_tax] if isinstance(raw_tax, list) else []
    out["output_taxonomy"] = [x for x in tax if x]
    out["output_contract_mode"] = _normalize_output_contract_mode(out.get("output_contract_mode"))
    out["output_fit_strategy"] = _normalize_output_fit_strategy(out.get("output_fit_strategy"))
    return out


def _sync_ai_registry_agents() -> None:
    """Mirror current universal agents into ui/data/_ai_registry for workspace visibility."""
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

        rows = []
        for a in _load_all():
            rows.append({
                "id": str(a.get("id") or ""),
                "name": str(a.get("name") or ""),
                "agent_class": str(a.get("agent_class") or ""),
                "model": str(a.get("model") or ""),
                "temperature": a.get("temperature", 0),
                "folder": str(a.get("folder") or ""),
                "updated_at": str(a.get("updated_at") or a.get("created_at") or ""),
                "path": f"_universal_agents/{str(a.get('id') or '')}.json",
            })
        rows.sort(key=lambda x: (x["name"].lower(), x["id"]))

        _AI_AGENTS_FILE.write_text(
            json.dumps(
                {
                    "generated_at": datetime.utcnow().isoformat(),
                    "count": len(rows),
                    "agents": rows,
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
    except Exception:
        pass


def _get_table_columns(db_or_bind: Any, table_name: str) -> set[str]:
    """Best-effort table column introspection (SQLite/Postgres-safe)."""
    try:
        bind = db_or_bind.get_bind() if hasattr(db_or_bind, "get_bind") else db_or_bind
        return {str(c.get("name")) for c in _sa_inspect(bind).get_columns(table_name) if c.get("name")}
    except Exception:
        return set()


# ── Routes ────────────────────────────────────────────────────────────────────

@router.get("")
def list_agents():
    _sync_ai_registry_agents()
    return _load_all()


@router.get("/folders")
def list_agent_folders():
    from_agents = [
        _normalise_folder(str(a.get("folder", "") or ""))
        for a in _load_all()
    ]
    merged = [*from_agents, *_load_folders()]
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
def create_agent_folder(req: FolderIn):
    name = _normalise_folder(req.name)
    if not name:
        raise HTTPException(400, "Folder name is required")
    _ensure_folder_exists(name)
    return {"ok": True, "folder": name}


@router.post("")
def create_agent(req: UniversalAgentIn):
    _DIR.mkdir(parents=True, exist_ok=True)
    now = datetime.utcnow().isoformat()
    record = _normalize_agent_record({"id": str(uuid.uuid4()), "created_at": now, "updated_at": now, **req.model_dump()})
    if record["folder"]:
        _ensure_folder_exists(record["folder"])
    (_DIR / f"{record['id']}.json").write_text(
        json.dumps(record, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    _sync_ai_registry_agents()
    return record


@router.get("/uploaded-files")
def list_uploaded_files(
    provider: str = Query(""),
    sales_agent: str = Query(""),
    customer: str = Query(""),
    call_id: str = Query(""),
    source: str = Query(""),
    db: Session = Depends(get_session),
):
    """List uploaded files, optionally filtered by context."""
    from ui.backend.models.uploaded_file import UploadedFile as UF
    stmt = select(UF).order_by(UF.created_at.desc())
    if provider:    stmt = stmt.where(UF.provider == provider)
    if sales_agent: stmt = stmt.where(UF.sales_agent == sales_agent)
    if customer:    stmt = stmt.where(UF.customer == customer)
    if call_id:     stmt = stmt.where(UF.call_id == call_id)
    if source:      stmt = stmt.where(UF.source == source)
    return db.exec(stmt).all()


@router.delete("/uploaded-files/{record_id}")
def delete_uploaded_file(record_id: str, db: Session = Depends(get_session)):
    """Delete a file record and attempt to remove the file from the provider."""
    from ui.backend.models.uploaded_file import UploadedFile as UF
    record = db.get(UF, record_id)
    if not record:
        raise HTTPException(404, "Record not found")

    if record.provider == "gemini":
        try:
            import google.generativeai as genai
            genai.configure(api_key=os.environ.get("GEMINI_API_KEY", ""))
            genai.delete_file(record.provider_file_id)
        except Exception:
            pass

    elif record.provider == "anthropic":
        try:
            import anthropic
            client = anthropic.Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY", ""))
            client.beta.files.delete(record.provider_file_id,
                                     betas=["files-api-2025-04-14"])
        except Exception:
            pass

    db.delete(record)
    db.commit()
    return {"ok": True}


@router.get("/raw-input")
def get_raw_input(
    source: str = Query(""),
    agent_id: Optional[str] = Query(None),
    sales_agent: str = Query(""),
    customer: str = Query(""),
    call_id: str = Query(""),
    merged_scope: str = Query("auto"),
    merged_until_call_id: str = Query(""),
    db: Session = Depends(get_session),
):
    """Resolve and return the raw text for a single input source."""
    try:
        content = _resolve_input(
            source,
            agent_id,
            sales_agent,
            customer,
            call_id,
            {},
            db,
            merged_scope=merged_scope,
            merged_until_call_id=merged_until_call_id,
        )
        return {"content": content, "chars": len(content)}
    except RuntimeError as e:
        raise HTTPException(404, str(e))


@router.get("/{agent_id}")
def get_agent(agent_id: str):
    _, data = _find_file(agent_id)
    return data


class FitTestRequest(BaseModel):
    raw_output: str = ""
    prefer: str = "structured"   # structured | raw
    model: str = ""              # optional override


@router.post("/{agent_id}/test-fit")
def test_output_fit(agent_id: str, req: FitTestRequest, db: Session = Depends(get_session)):
    _, agent_def = _find_file(agent_id)
    raw = str(req.raw_output or "")
    if not raw.strip():
        raise HTTPException(400, "raw_output is required")

    schema_text = _fallback_schema_from_agent(agent_def)
    taxonomy = [str(x or "").strip() for x in (agent_def.get("output_taxonomy") or []) if str(x or "").strip()]
    prefer = _normalize_output_fit_strategy(req.prefer or agent_def.get("output_fit_strategy"))
    model = str(req.model or agent_def.get("model") or "gpt-5.4").strip() or "gpt-5.4"

    raw_fit = _fit_score(raw, schema_text, taxonomy)
    normalized = _mend_output_to_schema(
        raw_output=raw,
        schema_text=schema_text,
        taxonomy=taxonomy,
        prefer=prefer,
        model=model,
        db=db,
    )
    fitted_fit = _fit_score(normalized, schema_text, taxonomy)

    return {
        "agent_id": agent_id,
        "agent_name": str(agent_def.get("name") or agent_id),
        "artifact_type": str(agent_def.get("artifact_type") or ""),
        "artifact_class": str(agent_def.get("artifact_class") or ""),
        "prefer": prefer,
        "model": model,
        "schema_template": schema_text,
        "taxonomy": taxonomy,
        "raw_output": raw,
        "fitted_output": normalized,
        "fit_before": raw_fit,
        "fit_after": fitted_fit,
    }


@router.put("/{agent_id}")
def update_agent(agent_id: str, req: UniversalAgentIn):
    f, data = _find_file(agent_id)
    data.update(_normalize_agent_record({**req.model_dump()}))
    data["updated_at"] = datetime.utcnow().isoformat()
    if data["folder"]:
        _ensure_folder_exists(data["folder"])
    f.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    _sync_ai_registry_agents()
    return data


@router.patch("/{agent_id}/folder")
def move_agent_to_folder(agent_id: str, req: FolderMoveIn):
    f, data = _find_file(agent_id)
    folder = _normalise_folder(req.folder)
    data["folder"] = folder
    data["updated_at"] = datetime.utcnow().isoformat()
    f.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    if folder:
        _ensure_folder_exists(folder)
    _sync_ai_registry_agents()
    return data


@router.post("/{agent_id}/copy")
def copy_agent(agent_id: str):
    _, data = _find_file(agent_id)
    now = datetime.utcnow().isoformat()
    copy_record = _normalize_agent_record({
        **data,
        "id": str(uuid.uuid4()),
        "name": _next_copy_name(str(data.get("name", "Agent"))),
        "is_default": False,
        "created_at": now,
        "updated_at": now,
    })
    if copy_record["folder"]:
        _ensure_folder_exists(copy_record["folder"])
    (_DIR / f"{copy_record['id']}.json").write_text(
        json.dumps(copy_record, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    _sync_ai_registry_agents()
    return copy_record


@router.delete("/{agent_id}")
def delete_agent(agent_id: str):
    f, _ = _find_file(agent_id)
    f.unlink()
    _sync_ai_registry_agents()
    return {"ok": True}


@router.patch("/{agent_id}/default")
def set_default(agent_id: str):
    for f in _DIR.glob("*.json"):
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
            want = d.get("id") == agent_id
            if d.get("is_default") != want:
                d["is_default"] = want
                d["updated_at"] = datetime.utcnow().isoformat()
                f.write_text(json.dumps(d, indent=2, ensure_ascii=False), encoding="utf-8")
        except Exception:
            pass
    _sync_ai_registry_agents()
    return {"ok": True}


# ── Preset import ─────────────────────────────────────────────────────────────

def _existing_names() -> set[str]:
    return {d.get("name", "") for d in _load_all()}


def _write_agent(record: dict) -> dict:
    _DIR.mkdir(parents=True, exist_ok=True)
    (_DIR / f"{record['id']}.json").write_text(
        json.dumps(record, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    return record


def _write_pipeline(record: dict) -> dict:
    _PIPELINES.mkdir(parents=True, exist_ok=True)
    (_PIPELINES / f"{record['id']}.json").write_text(
        json.dumps(record, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    return record


def _make_agent(name: str, model: str, temperature: float,
                system_prompt: str, user_prompt: str,
                inputs: list[dict], output_format: str,
                tags: list[str], is_default: bool = False,
                agent_class: str = "") -> dict:
    now = datetime.utcnow().isoformat()
    return {
        "id": str(uuid.uuid4()),
        "created_at": now, "updated_at": now,
        "name": name, "description": "",
        "agent_class": agent_class,
        "model": model, "temperature": temperature,
        "system_prompt": system_prompt, "user_prompt": user_prompt,
        "inputs": inputs, "output_format": output_format,
        "tags": tags, "is_default": is_default,
        "folder": "",
    }


@router.post("/import-presets")
def import_presets():
    """
    One-shot import of legacy presets into the universal agents system.
    - _fpa_analyzer_presets/ → Generator agent + Scorer agent + Pipeline (per preset)
    - _notes_agents/         → Notes agent (per record)
    Skips any preset whose derived name already exists.
    """
    existing = _existing_names()
    created_agents: list[str] = []
    created_pipelines: list[str] = []
    skipped: list[str] = []

    # ── FPA analyzer presets ───────────────────────────────────────────────────
    if _FPA_PRESETS.exists():
        for f in sorted(_FPA_PRESETS.glob("*.json")):
            try:
                p = json.loads(f.read_text(encoding="utf-8"))
            except Exception:
                continue

            preset_name = p.get("name", f.stem)
            gen_name   = f"{preset_name} Generator"
            score_name = f"{preset_name} Scorer"

            if gen_name in existing and score_name in existing:
                # Patch existing generator if it was imported without {transcript} placeholder
                for ag_f in _DIR.glob("*.json"):
                    try:
                        ag = json.loads(ag_f.read_text(encoding="utf-8"))
                        if ag.get("name") == gen_name and "{transcript}" not in ag.get("user_prompt", ""):
                            ag["user_prompt"] = ag["user_prompt"].rstrip() + "\n\n{transcript}"
                            ag_f.write_text(json.dumps(ag, indent=2, ensure_ascii=False), encoding="utf-8")
                            created_agents.append(f"{gen_name} (patched)")
                    except Exception:
                        pass
                skipped.append(preset_name)
                continue

            # Generator agent — input: merged_transcript
            # If the legacy prompt has no {transcript} placeholder, append it so the
            # resolved transcript is always injected at the end of the user message.
            gen_user_prompt = p.get("gen_user_prompt", "")
            if "{transcript}" not in gen_user_prompt:
                gen_user_prompt = gen_user_prompt.rstrip() + "\n\n{transcript}"

            gen = _make_agent(
                name=gen_name,
                model=p.get("gen_model", "gpt-5.4"),
                temperature=float(p.get("gen_temperature", 0.0)),
                system_prompt=p.get("gen_system_prompt", ""),
                user_prompt=gen_user_prompt,
                inputs=[{"key": "transcript", "source": "merged_transcript"}],
                output_format="markdown",
                tags=["persona", "generator"],
                is_default=bool(p.get("is_default", False)),
                agent_class="persona",
            )
            _write_agent(gen)
            created_agents.append(gen_name)

            # Scorer agent — inputs: persona (agent_output) + transcript (merged)
            score_user_prompt = p.get("score_user_prompt", "")
            if "{persona}" not in score_user_prompt:
                score_user_prompt = score_user_prompt.rstrip() + "\n\nPersona Analysis:\n{persona}"
            if "{transcript}" not in score_user_prompt:
                score_user_prompt = score_user_prompt.rstrip() + "\n\nTranscript:\n{transcript}"

            scorer = _make_agent(
                name=score_name,
                model=p.get("score_model", "gpt-5.4"),
                temperature=float(p.get("score_temperature", 0.0)),
                system_prompt=p.get("score_system_prompt", ""),
                user_prompt=score_user_prompt,
                inputs=[
                    {"key": "persona",     "source": "agent_output", "agent_id": gen["id"]},
                    {"key": "transcript",  "source": "merged_transcript"},
                ],
                output_format="json",
                tags=["persona", "scorer"],
                agent_class="scorer",
            )
            _write_agent(scorer)
            created_agents.append(score_name)

            # Pipeline: Generator → Scorer
            now = datetime.utcnow().isoformat()
            pipeline = {
                "id": str(uuid.uuid4()),
                "created_at": now, "updated_at": now,
                "name": preset_name,
                "description": f"Imported from FPA preset: {preset_name}",
                "scope": "per_pair",
                "steps": [
                    {"agent_id": gen["id"],    "input_overrides": {}},
                    {"agent_id": scorer["id"], "input_overrides": {}},
                ],
            }
            _write_pipeline(pipeline)
            created_pipelines.append(preset_name)

    # ── Notes agents ───────────────────────────────────────────────────────────
    if _NOTES_AGENTS.exists():
        for f in sorted(_NOTES_AGENTS.glob("*.json")):
            try:
                na = json.loads(f.read_text(encoding="utf-8"))
            except Exception:
                continue

            agent_name = na.get("name", f.stem)
            if agent_name in existing:
                skipped.append(agent_name)
                continue

            agent = _make_agent(
                name=agent_name,
                model=na.get("model", "gpt-5.4"),
                temperature=float(na.get("temperature", 0.0)),
                system_prompt=na.get("system_prompt", ""),
                user_prompt=na.get("user_prompt", ""),
                inputs=[{"key": "transcript", "source": "transcript"}],
                output_format="markdown",
                tags=["notes"],
                is_default=bool(na.get("is_default", False)),
                agent_class="notes",
            )
            _write_agent(agent)
            created_agents.append(agent_name)

    _sync_ai_registry_agents()
    return {
        "created_agents":    created_agents,
        "created_pipelines": created_pipelines,
        "skipped":           skipped,
    }


# ── Run engine ────────────────────────────────────────────────────────────────

# Input sources that represent large text files — never pasted inline into the prompt.
# These are uploaded as native file objects to the LLM provider.
_FILE_SOURCES = {"transcript", "merged_transcript", "notes", "merged_notes", "artifact_output"}


def _normalize_input_source(source: str) -> str:
    src = str(source or "").strip()
    return "artifact_output" if src == "chain_previous" else src


def _is_file_source(source: str) -> bool:
    src = _normalize_input_source(source)
    return src in _FILE_SOURCES or src.startswith("artifact_")

def _sse(event: str, data: dict) -> str:
    return f"data: {json.dumps({'type': event, 'data': data})}\n\n"


import hashlib

def _clean_result(text: str) -> str:
    text = text.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
    return text


def _content_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:24]


def _append_once(base: str, block: str) -> str:
    cur = str(base or "")
    add = str(block or "").strip()
    if not add:
        return cur
    if add in cur:
        return cur
    if cur.strip():
        return cur.rstrip() + "\n\n" + add + "\n"
    return add + "\n"


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


def _fallback_schema_from_agent(agent_def: dict[str, Any]) -> str:
    schema = str(agent_def.get("output_schema") or "").strip()
    if schema:
        return schema
    artifact_type = str(agent_def.get("artifact_type") or "").strip() or "artifact"
    artifact_class = str(agent_def.get("artifact_class") or "").strip() or "general"
    output_format = str(agent_def.get("output_format") or "markdown").strip().lower()
    taxonomy = [str(x or "").strip() for x in (agent_def.get("output_taxonomy") or []) if str(x or "").strip()]
    if output_format == "json":
        lines = [
            "{",
            f'  "artifact_type": "{artifact_type}",',
            f'  "artifact_class": "{artifact_class}",',
            '  "sections": [',
        ]
        for idx, label in enumerate(taxonomy):
            comma = "," if idx < len(taxonomy) - 1 else ""
            lines.append(f'    {{"name": "{label}", "content": ""}}{comma}')
        lines.extend(["  ]", "}"])
        return "\n".join(lines)
    lines = [
        f"# {artifact_type}",
        f"Class: {artifact_class}",
        "",
    ]
    if taxonomy:
        for i, t in enumerate(taxonomy, start=1):
            lines.append(f"{i}. {t}")
            lines.append("- ")
            lines.append("")
    else:
        lines.extend(["## Summary", "- "])
    return "\n".join(lines).strip()


def _extract_schema_markers(schema_text: str) -> list[str]:
    schema = str(schema_text or "")
    if not schema:
        return []
    markers: list[str] = []
    for token in _re.findall(r"\[[A-Z0-9_]{3,}\]", schema):
        markers.append(token.strip())
    for line in schema.splitlines():
        s = line.strip()
        if not s:
            continue
        if s.startswith("#"):
            m = s.lstrip("#").strip()
            if m:
                markers.append(m)
            continue
        m = _re.match(r"^\d+\.\s+(.+)$", s)
        if m:
            markers.append(m.group(1).strip())
            continue
        m2 = _re.match(r"^([A-Z_]{3,}):", s)
        if m2:
            markers.append(m2.group(1).strip() + ":")
            continue
    out: list[str] = []
    seen: set[str] = set()
    for m in markers:
        key = m.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(m)
    return out[:80]


def _fit_score(content: str, schema_text: str, taxonomy: list[str]) -> dict[str, Any]:
    txt = str(content or "")
    low = txt.lower()
    markers = _extract_schema_markers(schema_text)
    marker_hits = sum(1 for m in markers if m.lower() in low)
    marker_score = 100.0 if not markers else round((marker_hits / max(1, len(markers))) * 100.0, 1)
    clean_tax = [str(t or "").strip() for t in (taxonomy or []) if str(t or "").strip()]
    tax_hits = sum(1 for t in clean_tax if t.lower() in low)
    tax_score = 100.0 if not clean_tax else round((tax_hits / max(1, len(clean_tax))) * 100.0, 1)
    overall = round((marker_score * 0.7) + (tax_score * 0.3), 1)
    return {
        "overall": overall,
        "schema_marker_score": marker_score,
        "taxonomy_score": tax_score,
        "schema_markers_total": len(markers),
        "schema_markers_hit": marker_hits,
        "taxonomy_total": len(clean_tax),
        "taxonomy_hit": tax_hits,
        "missing_schema_markers": [m for m in markers if m.lower() not in low][:20],
        "missing_taxonomy": [t for t in clean_tax if t.lower() not in low][:20],
    }


def _mend_output_to_schema(
    *,
    raw_output: str,
    schema_text: str,
    taxonomy: list[str],
    prefer: str,
    model: str,
    db: Session,
) -> str:
    raw = str(raw_output or "").strip()
    schema = str(schema_text or "").strip()
    tax = [str(x or "").strip() for x in (taxonomy or []) if str(x or "").strip()]
    pref = _normalize_output_fit_strategy(prefer)
    if not raw:
        return raw
    if not schema:
        return raw

    system = (
        "You are an output normalizer. Transform raw agent output into the required target schema.\n"
        "Rules:\n"
        "- Preserve facts from the raw output.\n"
        "- Do not invent facts.\n"
        "- Keep call IDs and anchors when present.\n"
        "- If required values are missing, write UNKNOWN.\n"
        "- Return only the normalized final output."
    )
    style_rule = (
        "- Prefer strict schema adherence and ordering."
        if pref == "structured"
        else "- Preserve raw wording/style and apply minimal edits needed to satisfy schema."
    )
    user_template = (
        "TARGET SCHEMA:\n{schema}\n\n"
        "TARGET TAXONOMY:\n{taxonomy}\n\n"
        "NORMALIZATION PREFERENCE:\n{preference}\n\n"
        "RAW OUTPUT:\n{raw_output}\n\n"
        "ADDITIONAL RULE:\n{style_rule}\n\n"
        "Produce the normalized output now."
    )
    inline_inputs = {
        "schema": schema,
        "taxonomy": ("\n".join([f"- {t}" for t in tax]) if tax else "- (none)"),
        "preference": pref,
        "raw_output": raw,
        "style_rule": style_rule,
    }
    try:
        normalized, _ = _llm_call_with_files(
            system,
            user_template,
            {},
            inline_inputs,
            model or "gpt-5.4",
            0.0,
            db,
        )
        return str(normalized or "").strip() or raw
    except Exception:
        return raw

def _make_file_header(source: str, sales_agent: str, customer: str, call_id: str, chars: int) -> str:
    """Short metadata block prepended to every uploaded file so the LLM knows the context."""
    parts: list[str] = []
    if source:      parts.append(f"source={source}")
    if sales_agent: parts.append(f"agent={sales_agent}")
    if customer:    parts.append(f"customer={customer}")
    if call_id:     parts.append(f"call_id={call_id}")
    parts.append(f"size={chars:,} chars")
    return "[File context: " + " | ".join(parts) + "]\n\n"


def _fmt_call_datetime(value: Any) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    try:
        norm = raw[:-1] + "+00:00" if raw.endswith("Z") else raw
        dt = datetime.fromisoformat(norm)
        return dt.strftime("%d %b %Y  %H:%M")
    except Exception:
        return raw[:19]


def _fmt_duration(value: Any) -> str:
    try:
        d = int(float(value))
    except Exception:
        return ""
    if d < 0:
        return ""
    return f"{d // 60}m{d % 60:02d}s"


def _norm_call_id(value: Any) -> str:
    return str(value or "").strip()


def _parse_call_datetime(value: Any) -> Optional[datetime]:
    raw = str(value or "").strip()
    if not raw:
        return None
    try:
        norm = raw[:-1] + "+00:00" if raw.endswith("Z") else raw
        return datetime.fromisoformat(norm)
    except Exception:
        pass
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%d/%m/%Y %H:%M:%S", "%d/%m/%Y %H:%M"):
        try:
            return datetime.strptime(raw[:19], fmt)
        except Exception:
            continue
    return None


def _call_sort_key(row: dict[str, Any]) -> tuple[int, Any, int, str]:
    dt = _parse_call_datetime(row.get("started_at"))
    cid = _norm_call_id(row.get("call_id"))
    try:
        cid_num = int(float(cid))
    except Exception:
        cid_num = 10**18
    return (0 if dt else 1, dt or datetime.max, cid_num, cid.lower())


def _transcript_path_for_call(pair_dir: Any, call_id: str) -> Optional[Any]:
    llm_dir = pair_dir / call_id / "transcribed" / "llm_final"
    for p in (
        llm_dir / "smoothed.txt",
        llm_dir / "voted.txt",
        pair_dir / call_id / "transcribed" / "final.txt",
    ):
        if p.exists():
            return p
    return None


def _collect_pair_call_rows(
    sales_agent: str,
    customer: str,
    db: Session,
) -> list[dict[str, Any]]:
    pair_dir = settings.ui_data_dir / "agents" / sales_agent / customer
    by_call: dict[str, dict[str, Any]] = {}

    calls_path = pair_dir / "calls.json"
    if calls_path.exists():
        try:
            raw = json.loads(calls_path.read_text(encoding="utf-8"))
            if isinstance(raw, list):
                for c in raw:
                    if not isinstance(c, dict):
                        continue
                    cid = _norm_call_id(c.get("call_id"))
                    if not cid:
                        continue
                    row = by_call.setdefault(cid, {
                        "call_id": cid,
                        "started_at": "",
                        "duration_s": None,
                        "record_path": "",
                    })
                    if not row.get("started_at"):
                        row["started_at"] = c.get("started_at") or c.get("date") or ""
                    if row.get("duration_s") is None:
                        row["duration_s"] = c.get("duration_s")
                        if row.get("duration_s") is None:
                            row["duration_s"] = c.get("audio_duration_s")
                    if not row.get("record_path"):
                        row["record_path"] = c.get("record_path") or ""
        except Exception:
            pass

    if pair_dir.exists():
        try:
            for d in pair_dir.iterdir():
                if not d.is_dir() or d.name.startswith(".") or d.name.startswith("_"):
                    continue
                cid = _norm_call_id(d.name)
                if not cid:
                    continue
                by_call.setdefault(cid, {
                    "call_id": cid,
                    "started_at": "",
                    "duration_s": None,
                    "record_path": "",
                })
        except Exception:
            pass

    try:
        from ui.backend.models.crm import CRMCall

        stmt = select(CRMCall).where(CRMCall.agent == sales_agent, CRMCall.customer == customer)
        crm_rows = db.exec(stmt).all()
        for r in crm_rows:
            cid = _norm_call_id(getattr(r, "call_id", ""))
            if not cid:
                continue
            row = by_call.setdefault(cid, {
                "call_id": cid,
                "started_at": "",
                "duration_s": None,
                "record_path": "",
            })
            if not row.get("started_at"):
                row["started_at"] = getattr(r, "started_at", "") or ""
            if row.get("duration_s") is None:
                row["duration_s"] = getattr(r, "duration_s", None)
            if not row.get("record_path"):
                row["record_path"] = getattr(r, "record_path", "") or ""
    except Exception:
        pass

    out: list[dict[str, Any]] = []
    for cid, row in by_call.items():
        tx_path = _transcript_path_for_call(pair_dir, cid)
        has_transcript = bool(tx_path)
        has_audio = bool(str(row.get("record_path") or "").strip())
        transcript_status = "TRANSCRIPT" if has_transcript else ("NO_TRANSCRIPT" if has_audio else "NO_AUDIO")
        out.append({
            "call_id": cid,
            "started_at": row.get("started_at") or "",
            "duration_s": row.get("duration_s"),
            "record_path": row.get("record_path") or "",
            "transcript_path": tx_path,
            "transcript_status": transcript_status,
        })

    out.sort(key=_call_sort_key)
    return out


def _slice_rows_up_to_call(rows: list[dict[str, Any]], call_id: str) -> list[dict[str, Any]]:
    cid = _norm_call_id(call_id).lower()
    if not cid:
        return rows
    for i, row in enumerate(rows):
        if _norm_call_id(row.get("call_id")).lower() == cid:
            return rows[: i + 1]
    return rows


def _format_call_status_index(
    rows: list[dict[str, Any]],
    *,
    notes_status_by_call: Optional[dict[str, str]] = None,
) -> str:
    lines = ["CALL STATUS INDEX", "-" * 60]
    for row in rows:
        cid = _norm_call_id(row.get("call_id"))
        date_lbl = _fmt_call_datetime(row.get("started_at")) or "—"
        dur_lbl = _fmt_duration(row.get("duration_s")) or "—"
        tx_status = str(row.get("transcript_status") or "UNKNOWN")
        line = f"- CALL {cid} | {date_lbl} | {dur_lbl} | TRANSCRIPT_STATUS: {tx_status}"
        if notes_status_by_call is not None:
            note_status = notes_status_by_call.get(cid.lower(), "NO_NOTE")
            line += f" | NOTES_STATUS: {note_status}"
        lines.append(line)
    return "\n".join(lines).strip()


def _build_merged_transcript_content(
    sales_agent: str,
    customer: str,
    db: Session,
    *,
    upto_call_id: str = "",
) -> str:
    rows_all = _collect_pair_call_rows(sales_agent, customer, db)
    rows = _slice_rows_up_to_call(rows_all, upto_call_id)
    if not rows:
        return ""

    calls_total = len(rows)
    transcribed = sum(1 for r in rows if r.get("transcript_status") == "TRANSCRIPT")
    no_transcript = sum(1 for r in rows if r.get("transcript_status") == "NO_TRANSCRIPT")
    no_audio = sum(1 for r in rows if r.get("transcript_status") == "NO_AUDIO")
    now = datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC")
    scope_lbl = f"up to CALL {upto_call_id}" if _norm_call_id(upto_call_id) else "all calls"

    header = (
        f"{'═' * 60}\n"
        f"MERGED TRANSCRIPTS\n"
        f"Agent:               {sales_agent}\n"
        f"Customer:            {customer}\n"
        f"Scope:               {scope_lbl}\n"
        f"Calls Listed:        {calls_total}\n"
        f"Calls w/ Transcript: {transcribed}\n"
        f"No Transcript:       {no_transcript}\n"
        f"No Audio:            {no_audio}\n"
        f"Generated:           {now}\n"
        f"{'═' * 60}\n\n"
    )

    index_block = _format_call_status_index(rows)
    blocks: list[str] = []
    for row in rows:
        if row.get("transcript_status") != "TRANSCRIPT":
            continue
        tx_path = row.get("transcript_path")
        if not tx_path:
            continue
        try:
            text = tx_path.read_text(encoding="utf-8").strip()
        except Exception:
            text = ""
        if not text:
            continue
        cid = _norm_call_id(row.get("call_id"))
        date_lbl = _fmt_call_datetime(row.get("started_at")) or "—"
        dur_lbl = _fmt_duration(row.get("duration_s")) or "—"
        call_header = f"CALL {cid}  |  {date_lbl}  |  {dur_lbl}  |  STATUS: TRANSCRIPT"
        blocks.append(f"{'─' * 60}\n{call_header}\n{'─' * 60}\n{text}")

    body = "\n\n".join(blocks).strip()
    if not body:
        body = "No transcript bodies are available in this scope."
    return f"{header}{index_block}\n\n{body}".strip()


def _build_merged_notes_content(
    sales_agent: str,
    customer: str,
    db: Session,
    *,
    upto_call_id: str = "",
) -> str:
    from ui.backend.models.note import Note

    rows_all = _collect_pair_call_rows(sales_agent, customer, db)
    rows = _slice_rows_up_to_call(rows_all, upto_call_id)
    if not rows:
        return ""

    notes_stmt = select(Note).where(
        Note.agent == sales_agent,
        Note.customer == customer,
    ).order_by(Note.created_at.asc())
    notes = db.exec(notes_stmt).all()

    latest_by_call: dict[str, Any] = {}
    for n in notes:
        cid = _norm_call_id(getattr(n, "call_id", ""))
        if not cid:
            continue
        latest_by_call[cid.lower()] = n

    notes_status_by_call = {
        _norm_call_id(r.get("call_id")).lower():
            ("NOTE" if _norm_call_id(r.get("call_id")).lower() in latest_by_call else "NO_NOTE")
        for r in rows
    }

    calls_total = len(rows)
    with_notes = sum(1 for s in notes_status_by_call.values() if s == "NOTE")
    without_notes = calls_total - with_notes
    now = datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC")
    scope_lbl = f"up to CALL {upto_call_id}" if _norm_call_id(upto_call_id) else "all calls"

    header = (
        f"{'═' * 60}\n"
        f"MERGED NOTES\n"
        f"Agent:            {sales_agent}\n"
        f"Customer:         {customer}\n"
        f"Scope:            {scope_lbl}\n"
        f"Calls Listed:     {calls_total}\n"
        f"Calls with Notes: {with_notes}\n"
        f"Calls w/o Notes:  {without_notes}\n"
        f"Generated:        {now}\n"
        f"{'═' * 60}\n\n"
    )

    index_block = _format_call_status_index(rows, notes_status_by_call=notes_status_by_call)
    blocks: list[str] = []
    for row in rows:
        cid = _norm_call_id(row.get("call_id"))
        note = latest_by_call.get(cid.lower())
        if not note:
            continue
        content = str(getattr(note, "content_md", "") or "").strip()
        if not content:
            continue
        date_lbl = _fmt_call_datetime(row.get("started_at")) or "—"
        dur_lbl = _fmt_duration(row.get("duration_s")) or "—"
        tx_status = str(row.get("transcript_status") or "UNKNOWN")
        call_header = (
            f"CALL {cid}  |  {date_lbl}  |  {dur_lbl}  |  "
            f"TRANSCRIPT_STATUS: {tx_status}  |  NOTES_STATUS: NOTE"
        )
        blocks.append(f"{'─' * 60}\n{call_header}\n{'─' * 60}\n{content}")

    body = "\n\n".join(blocks).strip()
    if not body:
        body = "No note bodies are available in this scope."
    return f"{header}{index_block}\n\n{body}".strip()


def _single_call_header(
    sales_agent: str,
    customer: str,
    call_id: str,
    db: Session,
) -> str:
    """Build a merged-style heading block for a single-call transcript."""
    ui_data = settings.ui_data_dir
    pair_dir = ui_data / "agents" / sales_agent / customer

    rows: list[dict[str, Any]] = []
    seen: set[str] = set()

    calls_path = pair_dir / "calls.json"
    if calls_path.exists():
        try:
            raw = json.loads(calls_path.read_text(encoding="utf-8"))
            if isinstance(raw, list):
                for c in raw:
                    cid = str((c or {}).get("call_id", "") or "").strip()
                    if not cid or cid in seen:
                        continue
                    seen.add(cid)
                    rows.append({
                        "call_id": cid,
                        "started_at": (c or {}).get("started_at") or (c or {}).get("date"),
                        "duration_s": (c or {}).get("duration_s") or (c or {}).get("audio_duration_s"),
                    })
        except Exception:
            pass

    if pair_dir.exists():
        try:
            call_dirs = sorted([
                d for d in pair_dir.iterdir()
                if d.is_dir() and not d.name.startswith("_") and not d.name.startswith(".")
            ], key=lambda d: d.name.lower())
            for d in call_dirs:
                cid = str(d.name or "").strip()
                if not cid or cid in seen:
                    continue
                seen.add(cid)
                rows.append({"call_id": cid, "started_at": "", "duration_s": None})
        except Exception:
            pass

    call_number = 0
    total_calls = len(rows)
    started_at: Any = ""
    duration_s: Any = None

    for i, row in enumerate(rows):
        if str(row.get("call_id", "")).strip() != call_id:
            continue
        call_number = i + 1
        started_at = row.get("started_at") or started_at
        duration_s = row.get("duration_s") if row.get("duration_s") is not None else duration_s
        break

    # DB fallback for started_at / duration where calls.json is incomplete.
    if not started_at or duration_s is None:
        try:
            from ui.backend.models.crm import CRMCall
            stmt = select(CRMCall).where(CRMCall.call_id == call_id)
            if sales_agent:
                stmt = stmt.where(CRMCall.agent == sales_agent)
            if customer:
                stmt = stmt.where(CRMCall.customer == customer)
            crm_rows = db.exec(stmt).all()
            for r in crm_rows:
                if not started_at and getattr(r, "started_at", None):
                    started_at = r.started_at
                if duration_s is None and getattr(r, "duration_s", None) is not None:
                    duration_s = r.duration_s
                if started_at and duration_s is not None:
                    break
        except Exception:
            pass

    number_label = f"{call_number}/{total_calls}" if call_number and total_calls else "unknown"
    date_label = _fmt_call_datetime(started_at) or "unknown"
    dur_label = _fmt_duration(duration_s) or "unknown"

    call_line = f"CALL {call_id}"
    if date_label != "unknown":
        call_line += f"  |  {date_label}"
    if dur_label != "unknown":
        call_line += f"  |  {dur_label}"

    return (
        f"{'═' * 60}\n"
        f"SINGLE CALL TRANSCRIPT\n"
        f"Agent:      {sales_agent or '—'}\n"
        f"Customer:   {customer or '—'}\n"
        f"Call No.:   {number_label}\n"
        f"Call ID:    {call_id}\n"
        f"{'═' * 60}\n"
        f"{'─' * 60}\n"
        f"{call_line}\n"
        f"{'─' * 60}\n\n"
    )


# ── Per-provider file upload helpers (with DB dedup) ─────────────────────────

def _get_or_upload_gemini(
    content: str, key: str, source: str,
    sales_agent: str, customer: str, call_id: str,
    db: Session,
):
    """Upload to Gemini Files API or reuse cached record if still valid."""
    import io
    from datetime import timedelta
    import google.generativeai as genai
    from ui.backend.models.uploaded_file import UploadedFile as UF

    api_key = os.environ.get("GEMINI_API_KEY", "")
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY not set")
    genai.configure(api_key=api_key)

    chash     = _content_hash(content)
    now       = datetime.utcnow()
    cid_short = f"…{call_id[-8:]}" if call_id else "pair"
    header    = _make_file_header(source, sales_agent, customer, call_id, len(content))

    # Try existing record first
    existing = db.exec(
        select(UF).where(UF.provider == "gemini", UF.content_hash == chash)
        .order_by(UF.created_at.desc())
    ).first()

    if existing and (existing.expires_at is None or existing.expires_at > now):
        try:
            f = genai.get_file(existing.provider_file_id)
            log_buffer.emit(f"[FILE] ✓ gemini:{existing.provider_file_id} ({source} · {cid_short})")
            return f  # ✓ reused cached file
        except Exception:
            pass  # file gone on Google's side; fall through

    # Upload fresh (header + content so the model sees the context)
    f = genai.upload_file(
        io.BytesIO((header + content).encode("utf-8")),
        mime_type="text/plain",
        display_name=f"{source}_{customer}_{call_id or 'pair'}.txt",
    )
    log_buffer.emit(f"[FILE] ↑ gemini:{f.name} ({source} · {cid_short})")

    record = UF(
        id=str(uuid.uuid4()),
        provider="gemini",
        provider_file_id=f.name,
        provider_file_uri=getattr(f, "uri", ""),
        content_hash=chash,
        input_key=key,
        source=source,
        sales_agent=sales_agent,
        customer=customer,
        call_id=call_id,
        chars=len(content),
        created_at=now,
        expires_at=now + timedelta(hours=47),  # Gemini files expire after 48 h
    )
    db.add(record)
    db.commit()
    return f


def _get_or_upload_anthropic(
    content: str, key: str, source: str,
    sales_agent: str, customer: str, call_id: str,
    db: Session,
) -> str:
    """Upload to Anthropic Files API (beta) or reuse cached file_id."""
    import anthropic
    from ui.backend.models.uploaded_file import UploadedFile as UF

    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        raise RuntimeError("ANTHROPIC_API_KEY not set")
    client = anthropic.Anthropic(api_key=api_key)

    chash     = _content_hash(content)
    now       = datetime.utcnow()
    cid_short = f"…{call_id[-8:]}" if call_id else "pair"
    header    = _make_file_header(source, sales_agent, customer, call_id, len(content))

    # Try existing record
    existing = db.exec(
        select(UF).where(UF.provider == "anthropic", UF.content_hash == chash)
        .order_by(UF.created_at.desc())
    ).first()

    if existing:
        try:
            client.beta.files.retrieve(existing.provider_file_id,
                                        betas=["files-api-2025-04-14"])
            log_buffer.emit(f"[FILE] ✓ anthropic:{existing.provider_file_id} ({source} · {cid_short})")
            return existing.provider_file_id  # ✓ reused
        except Exception:
            pass  # file deleted on Anthropic's side; fall through

    # Upload fresh (header + content so the model sees the context)
    resp = client.beta.files.upload(
        file=(f"{source}_{customer}_{call_id or 'pair'}.txt", (header + content).encode("utf-8"), "text/plain"),
        betas=["files-api-2025-04-14"],
    )
    file_id = resp.id
    log_buffer.emit(f"[FILE] ↑ anthropic:{file_id} ({source} · {cid_short})")

    record = UF(
        id=str(uuid.uuid4()),
        provider="anthropic",
        provider_file_id=file_id,
        provider_file_uri="",
        content_hash=chash,
        input_key=key,
        source=source,
        sales_agent=sales_agent,
        customer=customer,
        call_id=call_id,
        chars=len(content),
        created_at=now,
        expires_at=None,  # Anthropic files persist until deleted
    )
    db.add(record)
    db.commit()
    return file_id


def _get_or_upload_openai(
    content: str, key: str, source: str,
    sales_agent: str, customer: str, call_id: str,
    provider: str, api_key: str,
    db: Session,
) -> tuple[str, str]:
    """Upload to OpenAI/Grok Files API, track in DB, return (file_id, content_with_header).
    `content_with_header` is used by Grok's inline fallback path; OpenAI Responses uses file_id."""
    from openai import OpenAI
    from ui.backend.models.uploaded_file import UploadedFile as UF

    chash     = _content_hash(content)
    now       = datetime.utcnow()
    cid_short = f"…{call_id[-8:]}" if call_id else "pair"
    header    = _make_file_header(source, sales_agent, customer, call_id, len(content))
    upload_content = header + content

    # OpenAI Responses API requires purpose="user_data"; old records used purpose="assistants"
    # and cannot be reused. Distinguish them via provider_file_uri ("user_data" vs "").
    purpose = "user_data" if provider == "openai" else "assistants"

    # Try existing record — for user_data purpose, only match records that were also
    # uploaded with user_data (provider_file_uri == "user_data"); ignore old assistants files.
    existing_stmt = select(UF).where(UF.provider == provider, UF.content_hash == chash)
    if purpose == "user_data":
        existing_stmt = existing_stmt.where(UF.provider_file_uri == "user_data")
    existing = db.exec(existing_stmt.order_by(UF.created_at.desc())).first()

    if existing:
        log_buffer.emit(f"[FILE] ✓ {provider}:{existing.provider_file_id} ({source} · {cid_short})")
        return existing.provider_file_id, upload_content

    # Upload fresh
    base_url = "https://api.x.ai/v1" if provider == "grok" else None
    upload_timeout_s = float(os.environ.get("OPENAI_UPLOAD_TIMEOUT_S", os.environ.get("OPENAI_CONNECT_TIMEOUT_S", "30")))
    client = OpenAI(api_key=api_key, base_url=base_url, timeout=upload_timeout_s)
    filename = f"{source}_{customer}_{call_id or 'pair'}.txt"
    file_id = f"local:{chash[:16]}"  # fallback if upload fails
    try:
        resp = client.files.create(
            file=(filename, upload_content.encode("utf-8"), "text/plain"),
            purpose=purpose,
        )
        file_id = resp.id
        log_buffer.emit(f"[FILE] ↑ {provider}:{file_id} ({source} · {cid_short})")
    except Exception as exc:
        log_buffer.emit(f"[FILE] ⚠ {provider} upload failed ({source} · {cid_short}): {exc} — tracking locally as {file_id}")

    # If uploading a user_data file, delete any stale assistants-purpose records for
    # the same content so they don't appear as duplicates in the Provider Files view.
    if purpose == "user_data":
        try:
            stale = db.exec(
                select(UF).where(
                    UF.provider == provider,
                    UF.content_hash == chash,
                    UF.provider_file_uri != "user_data",
                )
            ).all()
            for s in stale:
                db.delete(s)
        except Exception:
            pass

    record = UF(
        id=str(uuid.uuid4()),
        provider=provider,
        provider_file_id=file_id,
        provider_file_uri="user_data" if purpose == "user_data" else "",
        content_hash=chash,
        input_key=key,
        source=source,
        sales_agent=sales_agent,
        customer=customer,
        call_id=call_id,
        chars=len(content),
        created_at=now,
        expires_at=None,
    )
    db.add(record)
    db.commit()
    return file_id, upload_content


# ── LLM call with file upload ─────────────────────────────────────────────────

def _llm_call_gemini_files(
    system: str, user_template: str,
    file_inputs: dict, inline_inputs: dict,
    model: str, temperature: float,
    db: Session,
) -> tuple[str, str]:
    import google.generativeai as genai

    api_key = os.environ.get("GEMINI_API_KEY", "")
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY not set")
    genai.configure(api_key=api_key)

    # Get or upload each file input (context passed for record-keeping)
    ctx = getattr(db, "_agent_run_ctx", {})
    file_objs = {}
    for key, content in file_inputs.items():
        file_objs[key] = _get_or_upload_gemini(
            content, key,
            ctx.get("source_for_key", {}).get(key, ""),
            ctx.get("sales_agent", ""), ctx.get("customer", ""), ctx.get("call_id", ""),
            db,
        )

    # Build user message — strip {key} placeholders for file inputs
    user_text = user_template
    for key in file_objs:
        user_text = user_text.replace(f"{{{key}}}", "")
    for key, val in inline_inputs.items():
        user_text = user_text.replace(f"{{{key}}}", val)

    parts = list(file_objs.values()) + [user_text.strip()]

    gen_model = genai.GenerativeModel(
        model_name=model,
        system_instruction=system or None,
    )
    cfg: dict = {}
    if temperature > 0:
        cfg["temperature"] = temperature

    response = gen_model.generate_content(
        parts,
        generation_config=genai.GenerationConfig(**cfg) if cfg else None,
    )
    try:
        return _clean_result(response.text), ""
    except ValueError as e:
        finish = ""
        try:
            finish = response.candidates[0].finish_reason.name if response.candidates else "NONE"
        except Exception:
            pass
        raise RuntimeError(f"Gemini blocked/empty (finish_reason={finish}): {e}") from e


def _llm_call_anthropic_files(
    system: str, user_template: str,
    file_inputs: dict, inline_inputs: dict,
    model: str, temperature: float,
    db: Session,
) -> tuple[str, str]:
    import anthropic

    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        raise RuntimeError("ANTHROPIC_API_KEY not set")
    client = anthropic.Anthropic(api_key=api_key)

    content_blocks: list = []
    user_text = user_template

    ctx = getattr(db, "_agent_run_ctx", {})
    for key, content in file_inputs.items():
        user_text = user_text.replace(f"{{{key}}}", "")
        file_id = _get_or_upload_anthropic(
            content, key,
            ctx.get("source_for_key", {}).get(key, ""),
            ctx.get("sales_agent", ""), ctx.get("customer", ""), ctx.get("call_id", ""),
            db,
        )
        content_blocks.append({
            "type": "document",
            "source": {"type": "file", "file_id": file_id},
            "title": key,
        })

    for key, val in inline_inputs.items():
        user_text = user_text.replace(f"{{{key}}}", val)

    content_blocks.append({"type": "text", "text": user_text.strip()})

    kwargs: dict = {
        "model": model,
        "max_tokens": 16000,
        "system": system,
        "messages": [{"role": "user", "content": content_blocks}],
        "betas": ["files-api-2025-04-14"],
        "thinking": {"type": "enabled", "budget_tokens": 8000},
        "temperature": 1,  # Required when extended thinking is enabled
    }

    response = client.beta.messages.create(**kwargs)
    text = "\n\n".join(
        block.text for block in response.content
        if getattr(block, "type", None) == "text"
    )
    thinking = "\n\n".join(
        getattr(block, "thinking", "") for block in response.content
        if getattr(block, "type", None) == "thinking"
    ).strip()
    return _clean_result(text), thinking


def _llm_call_anthropic_files_streaming(
    system: str, user_template: str,
    file_inputs: dict, inline_inputs: dict,
    model: str, db: Session,
    on_text: Any,
) -> tuple[str, str]:
    """Streaming variant of _llm_call_anthropic_files. Calls on_text(chunk) for each text delta."""
    import anthropic

    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        raise RuntimeError("ANTHROPIC_API_KEY not set")
    client = anthropic.Anthropic(api_key=api_key)

    content_blocks: list = []
    user_text = user_template

    ctx = getattr(db, "_agent_run_ctx", {})
    for key, content in file_inputs.items():
        user_text = user_text.replace(f"{{{key}}}", "")
        file_id = _get_or_upload_anthropic(
            content, key,
            ctx.get("source_for_key", {}).get(key, ""),
            ctx.get("sales_agent", ""), ctx.get("customer", ""), ctx.get("call_id", ""),
            db,
        )
        content_blocks.append({
            "type": "document",
            "source": {"type": "file", "file_id": file_id},
            "title": key,
        })

    for key, val in inline_inputs.items():
        user_text = user_text.replace(f"{{{key}}}", val)

    content_blocks.append({"type": "text", "text": user_text.strip()})

    text_acc: list[str] = []
    thinking_acc: list[str] = []

    with client.beta.messages.stream(
        model=model,
        max_tokens=16000,
        system=system,
        messages=[{"role": "user", "content": content_blocks}],
        betas=["files-api-2025-04-14"],
        thinking={"type": "enabled", "budget_tokens": 8000},
        temperature=1,
    ) as s:
        for event in s:
            if event.type == "content_block_delta":
                if event.delta.type == "text_delta":
                    text_acc.append(event.delta.text)
                    on_text(event.delta.text)
                elif event.delta.type == "thinking_delta":
                    thinking_acc.append(event.delta.thinking)

    return _clean_result("".join(text_acc)), "".join(thinking_acc).strip()


def _llm_call_openai_responses_files(
    system: str, user_template: str,
    file_inputs: dict, inline_inputs: dict,
    model: str, temperature: float,
    db: Session,
) -> tuple[str, str]:
    """Call OpenAI Responses API with file references — no inline content pasting.
    Uses direct HTTP with explicit connect/read timeouts to avoid SDK-level hangs."""
    api_key = os.environ.get("OPENAI_API_KEY", "")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY not set")
    base_url = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
    connect_timeout_s = float(os.environ.get("OPENAI_CONNECT_TIMEOUT_S", "20"))
    read_timeout_s = float(os.environ.get("OPENAI_RESPONSES_TIMEOUT_S", "600"))
    max_retries = max(0, int(os.environ.get("OPENAI_RESPONSES_MAX_RETRIES", "4")))
    retry_base_s = max(0.1, float(os.environ.get("OPENAI_RESPONSES_RETRY_BASE_S", "1.2")))
    retry_max_s = max(0.5, float(os.environ.get("OPENAI_RESPONSES_RETRY_MAX_S", "20")))
    retry_jitter_s = max(0.0, float(os.environ.get("OPENAI_RESPONSES_RETRY_JITTER_S", "0.4")))
    ctx = getattr(db, "_agent_run_ctx", {})

    # Upload (or reuse cached) each file input — returns (file_id, _) tuple
    file_ids: dict[str, str] = {}
    for k, v in file_inputs.items():
        fid, _ = _get_or_upload_openai(
            v, k,
            ctx.get("source_for_key", {}).get(k, ""),
            ctx.get("sales_agent", ""), ctx.get("customer", ""), ctx.get("call_id", ""),
            "openai", api_key, db,
        )
        file_ids[k] = fid

    # Strip file placeholders; substitute inline inputs
    user_text = user_template
    for k in file_ids:
        user_text = user_text.replace(f"{{{k}}}", "")
    for k, v in inline_inputs.items():
        user_text = user_text.replace(f"{{{k}}}", v)
    user_text = user_text.strip()

    # Build Responses API input: file blocks + text wrapped in a user message.
    # Important: dedupe repeated file_ids. A pipeline step may map multiple keys
    # to the same source/content hash, and repeating identical file refs can
    # unnecessarily inflate context usage.
    unique_file_ids: list[str] = []
    seen_file_ids: set[str] = set()
    duplicate_count = 0
    for fid in file_ids.values():
        if fid in seen_file_ids:
            duplicate_count += 1
            continue
        seen_file_ids.add(fid)
        unique_file_ids.append(fid)
    if duplicate_count:
        log_buffer.emit(
            f"[LLM] {model} — deduped {duplicate_count} duplicate file reference(s)"
        )

    content: list = []
    for fid in unique_file_ids:
        content.append({"type": "input_file", "file_id": fid})
    if user_text:
        content.append({"type": "input_text", "text": user_text})

    payload: dict = {
        "model": model,
        "input": [{"type": "message", "role": "user", "content": content}],
    }
    if system:
        payload["instructions"] = system
    if temperature > 0:
        payload["temperature"] = temperature

    def _extract_text_and_thinking(data: dict) -> tuple[str, str]:
        text_parts: list[str] = []
        thinking_parts: list[str] = []

        top_text = data.get("output_text")
        if isinstance(top_text, str) and top_text.strip():
            text_parts.append(top_text)

        for item in data.get("output", []) or []:
            if not isinstance(item, dict):
                continue
            if item.get("type") == "reasoning":
                for summary in item.get("summary", []) or []:
                    if isinstance(summary, dict):
                        t = summary.get("text")
                        if isinstance(t, str) and t.strip():
                            thinking_parts.append(t.strip())

            for block in item.get("content", []) or []:
                if not isinstance(block, dict):
                    continue
                btype = block.get("type")
                if btype in ("output_text", "text"):
                    t = block.get("text", "")
                    if isinstance(t, str) and t.strip():
                        text_parts.append(t)
                elif btype == "reasoning":
                    t = block.get("text", "")
                    if isinstance(t, str) and t.strip():
                        thinking_parts.append(t)

        text = _clean_result("\n\n".join(x.strip() for x in text_parts if x and x.strip()))
        thinking = "\n\n".join(x.strip() for x in thinking_parts if x and x.strip())
        return text, thinking

    retriable_statuses = {408, 409, 429, 500, 502, 503, 504}
    retriable_codes = {
        "server_error",
        "rate_limit_exceeded",
        "temporarily_unavailable",
        "overloaded_error",
    }
    total_attempts = max_retries + 1
    last_err: Optional[Exception] = None

    for attempt in range(1, total_attempts + 1):
        if attempt == 1:
            log_buffer.emit(f"[LLM] {model} — OpenAI responses request started")
        else:
            log_buffer.emit(
                f"[LLM] {model} — OpenAI responses retry attempt {attempt}/{total_attempts}"
            )

        try:
            resp = requests.post(
                f"{base_url}/responses",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json=payload,
                timeout=(connect_timeout_s, read_timeout_s),
            )
        except requests.Timeout as exc:
            last_err = RuntimeError(
                f"OpenAI Responses API timed out after {int(read_timeout_s)}s (model: {model})"
            )
            if attempt >= total_attempts:
                raise last_err from exc
            sleep_s = min(retry_max_s, retry_base_s * (2 ** (attempt - 1))) + (random.random() * retry_jitter_s)
            log_buffer.emit(
                f"[LLM] {model} — timeout on attempt {attempt}/{total_attempts}; retrying in {sleep_s:.1f}s"
            )
            time.sleep(sleep_s)
            continue
        except requests.RequestException as exc:
            last_err = RuntimeError(f"OpenAI Responses API request failed: {exc}")
            if attempt >= total_attempts:
                raise last_err from exc
            sleep_s = min(retry_max_s, retry_base_s * (2 ** (attempt - 1))) + (random.random() * retry_jitter_s)
            log_buffer.emit(
                f"[LLM] {model} — transport error on attempt {attempt}/{total_attempts}; retrying in {sleep_s:.1f}s"
            )
            time.sleep(sleep_s)
            continue

        if not resp.ok:
            raw_body = (resp.text or "").strip()
            body = raw_body if len(raw_body) <= 800 else (raw_body[:800] + "…")
            request_id = (resp.headers.get("x-request-id") or "").strip()
            error_code = ""
            retry_after_s = 0.0
            try:
                body_json = resp.json() if raw_body else {}
                if isinstance(body_json, dict):
                    err_obj = body_json.get("error") if isinstance(body_json.get("error"), dict) else {}
                    error_code = str(err_obj.get("code") or "")
                    if not request_id:
                        request_id = str(err_obj.get("request_id") or "")
            except Exception:
                body_json = {}

            retry_after_hdr = (resp.headers.get("retry-after") or "").strip()
            if retry_after_hdr:
                try:
                    retry_after_s = max(0.0, float(retry_after_hdr))
                except Exception:
                    retry_after_s = 0.0

            if resp.status_code == 400 and "context_length_exceeded" in body:
                inline_chars = sum(len(v or "") for v in inline_inputs.values())
                file_chars = sum(len(v or "") for v in file_inputs.values())
                raise RuntimeError(
                    "OpenAI context_length_exceeded "
                    f"(model={model}, inline_chars≈{inline_chars:,}, "
                    f"file_inputs={len(file_inputs)}, unique_files={len(unique_file_ids)}, "
                    f"file_chars≈{file_chars:,}). {body or 'empty response'}"
                )

            is_retriable = (resp.status_code in retriable_statuses) or (error_code in retriable_codes)
            err_msg = f"OpenAI Responses API HTTP {resp.status_code}: {body or 'empty response'}"
            if request_id:
                err_msg += f" (request_id={request_id})"

            if is_retriable and attempt < total_attempts:
                exp_backoff_s = min(retry_max_s, retry_base_s * (2 ** (attempt - 1))) + (random.random() * retry_jitter_s)
                sleep_s = max(exp_backoff_s, retry_after_s)
                log_buffer.emit(
                    f"[LLM] {model} — transient HTTP {resp.status_code} on attempt {attempt}/{total_attempts}; "
                    f"retrying in {sleep_s:.1f}s"
                )
                time.sleep(sleep_s)
                continue

            raise RuntimeError(err_msg)

        try:
            data = resp.json()
        except Exception as exc:
            last_err = RuntimeError("OpenAI Responses API returned invalid JSON")
            if attempt >= total_attempts:
                raise last_err from exc
            sleep_s = min(retry_max_s, retry_base_s * (2 ** (attempt - 1))) + (random.random() * retry_jitter_s)
            log_buffer.emit(
                f"[LLM] {model} — invalid JSON on attempt {attempt}/{total_attempts}; retrying in {sleep_s:.1f}s"
            )
            time.sleep(sleep_s)
            continue

        text, thinking = _extract_text_and_thinking(data)
        if not text:
            last_err = RuntimeError("OpenAI Responses API returned empty output")
            if attempt >= total_attempts:
                raise last_err
            sleep_s = min(retry_max_s, retry_base_s * (2 ** (attempt - 1))) + (random.random() * retry_jitter_s)
            log_buffer.emit(
                f"[LLM] {model} — empty output on attempt {attempt}/{total_attempts}; retrying in {sleep_s:.1f}s"
            )
            time.sleep(sleep_s)
            continue

        log_buffer.emit(
            f"[LLM] {model} — OpenAI responses complete ({len(text):,} chars, attempt {attempt}/{total_attempts})"
        )
        return text, thinking

    raise RuntimeError(str(last_err or "OpenAI Responses API failed after retries"))


def _llm_call_with_files(
    system: str, user_template: str,
    file_inputs: dict, inline_inputs: dict,
    model: str, temperature: float,
    db: Session,
) -> tuple[str, str]:
    """Route to provider-specific file-upload implementation. Returns (content, thinking)."""
    if model.startswith("gemini"):
        return _llm_call_gemini_files(
            system, user_template, file_inputs, inline_inputs, model, temperature, db)

    if model.startswith("claude-"):
        return _llm_call_anthropic_files(
            system, user_template, file_inputs, inline_inputs, model, temperature, db)

    # OpenAI — Responses API with file references (no inline content pasting)
    if not model.startswith("grok"):
        return _llm_call_openai_responses_files(
            system, user_template, file_inputs, inline_inputs, model, temperature, db)

    # Grok — Chat Completions with inline content (xAI doesn't support file references)
    import sys
    sys.path.insert(0, str(settings.project_root))
    from shared.llm_client import LLMClient, resolve_grok_key

    provider = "grok"
    api_key = resolve_grok_key() or ""
    if not api_key:
        raise RuntimeError("API key not set for provider 'grok'")

    ctx = getattr(db, "_agent_run_ctx", {})

    # Upload each file input and get (file_id, content_with_header)
    file_resolved: dict[str, tuple[str, str]] = {}
    for k, v in file_inputs.items():
        fid, content_with_header = _get_or_upload_openai(
            v, k,
            ctx.get("source_for_key", {}).get(k, ""),
            ctx.get("sales_agent", ""), ctx.get("customer", ""), ctx.get("call_id", ""),
            provider, api_key, db,
        )
        file_resolved[k] = (fid, content_with_header)

    user = user_template
    orphaned: list[str] = []
    for k, v in inline_inputs.items():
        placeholder = f"{{{k}}}"
        if placeholder in user:
            user = user.replace(placeholder, v)
    for k, (fid, content_with_header) in file_resolved.items():
        placeholder = f"{{{k}}}"
        if placeholder in user:
            user = user.replace(placeholder, content_with_header)
        elif content_with_header.strip():
            # No placeholder — append so the model always receives the content
            orphaned.append(f"--- {k} [file_id={fid}] ---\n{content_with_header}")
    if orphaned:
        user = user.strip() + "\n\n" + "\n\n".join(orphaned)

    client = LLMClient(provider=provider, api_key=api_key)
    resp = client.chat_completion(
        model=model,
        messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
        temperature=temperature,
    )
    return _clean_result(resp.choices[0].message.content or ""), ""


def _resolve_input(source: str, agent_id: Optional[str],
                   sales_agent: str, customer: str, call_id: str,
                   manual_inputs: dict, db: Session,
                   input_key: str = "",
                   merged_scope: str = "auto",
                   merged_until_call_id: str = "") -> str:
    """Resolve one declared input to its text content."""
    from ui.backend.models.note import Note
    from ui.backend.models.persona import Persona

    ui_data = settings.ui_data_dir
    source = _normalize_input_source(source)
    merged_scope_norm = _normalize_merged_scope(merged_scope)
    fixed_merged_call_id = _norm_call_id(merged_until_call_id)

    if source == "transcript":
        if not call_id:
            # Per-pair context: fall back to merged transcript
            source = "merged_transcript"
        else:
            llm_dir = ui_data / "agents" / sales_agent / customer / call_id / "transcribed" / "llm_final"
            path = llm_dir / "smoothed.txt"
            if not path.exists():
                voted = llm_dir / "voted.txt"
                if voted.exists():
                    path = voted
            if not path.exists():
                raise RuntimeError(f"Transcript not found for call {call_id}")
            content = path.read_text(encoding="utf-8").strip()
            if not content:
                return content
            try:
                header = _single_call_header(sales_agent, customer, call_id, db)
                if header:
                    return header + content
            except Exception:
                pass
            return content

    if source == "merged_transcript":
        pair_dir = ui_data / "agents" / sales_agent / customer
        pair_dir.mkdir(parents=True, exist_ok=True)
        cutoff_call_id = _norm_call_id(call_id)
        if merged_scope_norm == "all":
            cutoff_call_id = ""
        elif merged_scope_norm == "upto_call" and fixed_merged_call_id:
            cutoff_call_id = fixed_merged_call_id

        if not cutoff_call_id:
            merged = pair_dir / "merged_transcript.txt"
            if merged.exists():
                try:
                    cached = merged.read_text(encoding="utf-8").strip()
                    # Rich merged transcript cache marker
                    if "CALL STATUS INDEX" in cached[:2000]:
                        return cached
                except Exception:
                    pass

        content = _build_merged_transcript_content(
            sales_agent,
            customer,
            db,
            upto_call_id=cutoff_call_id,
        )
        if not content:
            raise RuntimeError(
                f"No call metadata found for {sales_agent} / {customer}. "
                f"Please sync CRM first."
            )

        try:
            if cutoff_call_id:
                safe_id = _re.sub(r"[^A-Za-z0-9_.-]+", "_", cutoff_call_id).strip("._") or "call"
                out_path = pair_dir / f"merged_transcript_upto_{safe_id}.txt"
            else:
                out_path = pair_dir / "merged_transcript.txt"
            out_path.write_text(content, encoding="utf-8")
        except Exception:
            pass
        return content

    if source == "notes":
        if not call_id:
            # Per-pair context: fall back to merged notes
            source = "merged_notes"
        else:
            stmt = select(Note).where(
                Note.agent == sales_agent, Note.customer == customer, Note.call_id == call_id
            ).order_by(Note.created_at.desc())
            note = db.exec(stmt).first()
            if not note:
                raise RuntimeError(f"No notes found for call {call_id}")
            return note.content_md

    if source == "merged_notes":
        pair_dir = ui_data / "agents" / sales_agent / customer
        pair_dir.mkdir(parents=True, exist_ok=True)
        cutoff_call_id = _norm_call_id(call_id)
        if merged_scope_norm == "all":
            cutoff_call_id = ""
        elif merged_scope_norm == "upto_call" and fixed_merged_call_id:
            cutoff_call_id = fixed_merged_call_id
        content = _build_merged_notes_content(
            sales_agent,
            customer,
            db,
            upto_call_id=cutoff_call_id,
        )
        if not content:
            raise RuntimeError(f"No call metadata found for {sales_agent}/{customer}")
        try:
            if cutoff_call_id:
                safe_id = _re.sub(r"[^A-Za-z0-9_.-]+", "_", cutoff_call_id).strip("._") or "call"
                out_path = pair_dir / f"merged_notes_upto_{safe_id}.txt"
            else:
                out_path = pair_dir / "merged_notes.txt"
            out_path.write_text(content, encoding="utf-8")
        except Exception:
            pass
        return content

    if source == "agent_output":
        if not agent_id:
            raise RuntimeError("agent_output input missing agent_id")
        sql = (
            "SELECT content "
            "FROM agent_result "
            "WHERE agent_id = :agent_id "
            "AND sales_agent = :sales_agent "
            "AND customer = :customer "
        )
        params = {
            "agent_id": agent_id,
            "sales_agent": sales_agent,
            "customer": customer,
        }
        if call_id:
            sql += "AND call_id = :call_id "
            params["call_id"] = call_id
        sql += "ORDER BY created_at DESC LIMIT 1"
        row = db.execute(_sql_text(sql), params).first()
        if not row:
            raise RuntimeError(f"No stored result for agent {agent_id} in this context")
        m = getattr(row, "_mapping", row)
        if hasattr(m, "get"):
            return str(m.get("content", "") or "")
        return str(row[0] if isinstance(row, tuple) and row else "")

    if source == "artifact_output" or source.startswith("artifact_"):
        # Pipeline stage chaining source.
        chained = manual_inputs.get("_chain_previous", "")
        if chained:
            return chained

        # Standalone agent-run fallback for persisted artifacts.
        if source == "artifact_persona":
            q = select(Persona).where(
                Persona.agent == sales_agent,
                Persona.type.in_(["pair", "agent_overall"]),
            )
            if customer:
                q = q.where(Persona.customer == customer)
            else:
                q = q.where(Persona.customer == None)  # noqa: E711
            q = q.order_by(Persona.created_at.desc())
            p = db.exec(q).first()
            if not p:
                raise RuntimeError("No persona cached for this context")
            return p.content_md or ""

        if source == "artifact_persona_score":
            q = select(Persona).where(
                Persona.agent == sales_agent,
                Persona.type.in_(["pair", "agent_overall"]),
                Persona.score_json != None,  # noqa: E711
            )
            if customer:
                q = q.where(Persona.customer == customer)
            else:
                q = q.where(Persona.customer == None)  # noqa: E711
            q = q.order_by(Persona.created_at.desc())
            p = db.exec(q).first()
            if not p:
                raise RuntimeError("No scored persona cached for this context")
            return p.score_json or ""

        if source == "artifact_notes":
            rollup = ui_data / "_note_rollups" / sales_agent / f"{customer}__all.json"
            legacy_rollup = ui_data / "_note_rollups" / sales_agent / f"{customer}.json"
            path = rollup if rollup.exists() else legacy_rollup
            if not path.exists():
                raise RuntimeError("No notes artifact cached for this context")
            return path.read_text(encoding="utf-8").strip()

        if source == "artifact_notes_compliance":
            q = select(Note).where(
                Note.agent == sales_agent,
                Note.customer == customer,
                Note.score_json != None,  # noqa: E711
            ).order_by(Note.created_at.desc())
            n = db.exec(q).first()
            if not n:
                raise RuntimeError("No compliance-scored notes cached for this context")
            return n.score_json or ""

        return ""

    if source == "manual":
        if input_key and input_key in manual_inputs:
            return manual_inputs.get(input_key, "") or ""
        return manual_inputs.get("manual", "")

    raise RuntimeError(f"Unknown input source '{source}'")


class RunRequest(BaseModel):
    sales_agent: str = ""
    customer: str = ""
    call_id: str = ""
    manual_inputs: dict = {}
    source_overrides: dict = {}  # input key → alternative source (e.g. "transcript" → "transcript")


@router.post("/{agent_id}/run")
async def run_agent(agent_id: str, req: RunRequest, db: Session = Depends(get_session)):
    """Execute a universal agent against a given context and stream results via SSE."""
    _, agent_def = _find_file(agent_id)

    async def stream():
        try:
            yield _sse("progress", {"msg": "Resolving inputs…"})

            # Resolve all inputs
            resolved: dict[str, str] = {}
            loop = asyncio.get_event_loop()
            requested_source_for_key: dict[str, str] = {}
            effective_source_for_key: dict[str, str] = {}

            for inp in agent_def.get("inputs", []):
                key = inp.get("key", "input")
                declared_src = _normalize_input_source(inp.get("source", "manual"))
                requested_src = _normalize_input_source(
                    req.source_overrides.get(key, declared_src)
                )
                effective_src = requested_src
                # Quick-test mode can inject artifact/file-like content via manual text.
                # Keep those on the file-upload path for provider file IDs and context safety.
                if (
                    requested_src == "manual"
                    and key in req.manual_inputs
                    and _is_file_source(declared_src)
                ):
                    effective_src = declared_src
                requested_source_for_key[key] = requested_src
                effective_source_for_key[key] = effective_src

            for inp in agent_def.get("inputs", []):
                key     = inp.get("key", "input")
                source  = requested_source_for_key.get(key, "manual")
                display_source = effective_source_for_key.get(key, source)
                ref_id  = inp.get("agent_id")
                inp_merged_scope = _normalize_merged_scope(inp.get("merged_scope"))
                inp_merged_until_call_id = str(inp.get("merged_until_call_id") or "").strip()

                yield _sse("progress", {"msg": f"Loading {key} ({display_source})…"})

                try:
                    text = await loop.run_in_executor(
                        None,
                        lambda s=source, a=ref_id, k=key, ms=inp_merged_scope, mc=inp_merged_until_call_id: _resolve_input(
                            s, a, req.sales_agent, req.customer, req.call_id,
                            req.manual_inputs, db, input_key=k,
                            merged_scope=ms, merged_until_call_id=mc
                        ),
                    )
                    resolved[key] = text
                except Exception as e:
                    yield _sse("error", {"msg": str(e)})
                    return

            system_prompt    = agent_def.get("system_prompt", "")
            user_template    = agent_def.get("user_prompt", "")
            model            = agent_def.get("model", "gpt-5.4")
            temperature      = float(agent_def.get("temperature", 0.0))
            output_contract_mode = _normalize_output_contract_mode(agent_def.get("output_contract_mode"))
            output_contract_block = _build_output_contract_block(agent_def)
            if output_contract_mode != "off" and output_contract_block:
                system_prompt = _append_once(system_prompt, output_contract_block)
                if output_contract_mode == "strict":
                    user_template = _append_once(
                        user_template,
                        "STRICT OUTPUT REQUIREMENT:\n- Follow the OUTPUT CONTRACT exactly.\n- Return only the final formatted output.",
                    )

            # Split resolved inputs into file-type (uploaded) vs inline (substituted)
            file_keys: set[str] = set()
            for inp in agent_def.get("inputs", []):
                k = inp.get("key", "")
                effective_src = effective_source_for_key.get(
                    k, _normalize_input_source(inp.get("source", "manual"))
                )
                if _is_file_source(effective_src):
                    file_keys.add(k)

            file_inputs   = {k: v for k, v in resolved.items() if k in file_keys}
            inline_inputs = {k: v for k, v in resolved.items() if k not in file_keys}

            # Attach run context to db session so upload helpers can record it
            db._agent_run_ctx = {
                "sales_agent": req.sales_agent,
                "customer":    req.customer,
                "call_id":     req.call_id,
                "source_for_key": {
                    inp.get("key", ""): effective_source_for_key.get(
                        inp.get("key", ""),
                        _normalize_input_source(inp.get("source", "")),
                    )
                    for inp in agent_def.get("inputs", [])
                },
            }

            # Grok pastes files inline; all other providers use file references
            total_chars = sum(len(v) for v in inline_inputs.values())
            if model.startswith("grok"):
                total_chars += sum(len(v) for v in file_inputs.values())
            log_buffer.emit(f"[AGENT] ▶ {agent_def.get('name', agent_id)} · {model}")
            log_buffer.emit(f"[LLM] {model} — {total_chars:,} chars input")
            yield _sse("progress", {
                "msg": f"Calling {model}… ({len(file_inputs)} file(s), {len(inline_inputs)} inline)"
            })

            if model.startswith("claude-"):
                # Stream Anthropic response token-by-token via a queue
                q: _queue.Queue = _queue.Queue()
                result_holder: list = []
                error_holder: list = []

                def _do_stream():
                    try:
                        c, t = _llm_call_anthropic_files_streaming(
                            system_prompt, user_template,
                            file_inputs, inline_inputs,
                            model, db,
                            on_text=lambda chunk: q.put(("stream", chunk)),
                        )
                        result_holder.append((c, t))
                    except Exception as exc:
                        error_holder.append(str(exc))
                    finally:
                        q.put(None)

                threading.Thread(target=_do_stream, daemon=True).start()

                while True:
                    item = await loop.run_in_executor(None, q.get)
                    if item is None:
                        break
                    kind, data = item
                    if kind == "stream":
                        yield _sse("stream", {"text": data})

                if error_holder:
                    yield _sse("error", {"msg": error_holder[0]})
                    return

                content, thinking = result_holder[0]
            else:
                content, thinking = await loop.run_in_executor(
                    None,
                    lambda: _llm_call_with_files(
                        system_prompt, user_template,
                        file_inputs, inline_inputs,
                        model, temperature, db,
                    ),
                )

            # Save result (thinking not persisted — it's ephemeral reasoning)
            result_id = str(uuid.uuid4())
            cols = _get_table_columns(db, "agent_result")
            insert_cols = [
                "id",
                "agent_id",
                "agent_name",
                "sales_agent",
                "customer",
                "call_id",
                "content",
                "model",
                "created_at",
            ]
            params: dict[str, Any] = {
                "id": result_id,
                "agent_id": agent_id,
                "agent_name": agent_def.get("name", ""),
                "sales_agent": req.sales_agent,
                "customer": req.customer,
                "call_id": req.call_id,
                "content": content,
                "model": model,
                "created_at": datetime.utcnow(),
            }
            optional_defaults: dict[str, Any] = {
                "pipeline_id": "",
                "pipeline_step_index": -1,
                "input_fingerprint": "",
            }
            for opt_col, default_val in optional_defaults.items():
                if opt_col in cols:
                    insert_cols.append(opt_col)
                    params[opt_col] = default_val

            col_csv = ", ".join(insert_cols)
            val_csv = ", ".join(f":{c}" for c in insert_cols)
            db.execute(_sql_text(f"INSERT INTO agent_result ({col_csv}) VALUES ({val_csv})"), params)
            db.commit()

            log_buffer.emit(f"[LLM] {model} — done ({len(content):,} chars)")
            log_buffer.emit(f"[AGENT] ✓ {agent_def.get('name', agent_id)}")
            if thinking:
                yield _sse("thinking", {"content": thinking})
            yield _sse("done", {"content": content, "result_id": result_id})

        except Exception as e:
            log_buffer.emit(f"[AGENT] ✗ {agent_def.get('name', agent_id)}: {e}")
            yield _sse("error", {"msg": str(e)})

    return StreamingResponse(stream(), media_type="text/event-stream")


@router.get("/{agent_id}/results")
def get_results(
    agent_id: str,
    sales_agent: str = Query(""),
    customer: str = Query(""),
    call_id: str = Query(""),
    db: Session = Depends(get_session),
):
    """Fetch stored results for a given agent + context."""
    sql = (
        "SELECT id, agent_id, agent_name, sales_agent, customer, call_id, content, model, created_at "
        "FROM agent_result "
        "WHERE agent_id = :agent_id "
    )
    params: dict[str, Any] = {"agent_id": agent_id}
    if sales_agent:
        sql += "AND sales_agent = :sales_agent "
        params["sales_agent"] = sales_agent
    if customer:
        sql += "AND customer = :customer "
        params["customer"] = customer
    if call_id:
        sql += "AND call_id = :call_id "
        params["call_id"] = call_id
    sql += "ORDER BY created_at DESC"
    rows = db.execute(_sql_text(sql), params).all()

    out = []
    for row in rows:
        m = getattr(row, "_mapping", row)
        if hasattr(m, "get"):
            created_at = m.get("created_at")
            out.append({
                "id": m.get("id", ""),
                "agent_id": m.get("agent_id", ""),
                "agent_name": m.get("agent_name", ""),
                "sales_agent": m.get("sales_agent", ""),
                "customer": m.get("customer", ""),
                "call_id": m.get("call_id", ""),
                "content": m.get("content", ""),
                "model": m.get("model", ""),
                "created_at": created_at.isoformat() if hasattr(created_at, "isoformat") else created_at,
                "pipeline_id": "",
                "pipeline_step_index": -1,
                "input_fingerprint": "",
            })
        else:
            out.append({
                "id": row[0] if len(row) > 0 else "",
                "agent_id": row[1] if len(row) > 1 else "",
                "agent_name": row[2] if len(row) > 2 else "",
                "sales_agent": row[3] if len(row) > 3 else "",
                "customer": row[4] if len(row) > 4 else "",
                "call_id": row[5] if len(row) > 5 else "",
                "content": row[6] if len(row) > 6 else "",
                "model": row[7] if len(row) > 7 else "",
                "created_at": row[8].isoformat() if len(row) > 8 and hasattr(row[8], "isoformat") else (row[8] if len(row) > 8 else None),
                "pipeline_id": "",
                "pipeline_step_index": -1,
                "input_fingerprint": "",
            })
    return out
