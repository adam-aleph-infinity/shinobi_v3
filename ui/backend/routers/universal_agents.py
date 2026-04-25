"""Universal Agents — flexible multi-input LLM agent definitions."""
import asyncio
import json
import os
import queue as _queue
import random
import threading
import time
import uuid
from datetime import datetime
from typing import Any, Optional

import requests
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
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


class AgentInput(BaseModel):
    key: str                          # template variable name, used as {key} in prompts
    source: str                       # one of INPUT_SOURCES
    agent_id: Optional[str] = None   # required when source == "agent_output"
    label: Optional[str] = None      # human-readable label (auto-derived if omitted)


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
                out.append(data)
        except Exception:
            pass
    return out


def _find_file(agent_id: str) -> tuple[Any, dict]:
    for f in _DIR.glob("*.json"):
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            if data.get("id") == agent_id:
                return f, data
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
    record = {"id": str(uuid.uuid4()), "created_at": now, "updated_at": now, **req.model_dump()}
    record["folder"] = _normalise_folder(record.get("folder", ""))
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
    db: Session = Depends(get_session),
):
    """Resolve and return the raw text for a single input source."""
    try:
        content = _resolve_input(
            source, agent_id, sales_agent, customer, call_id, {}, db
        )
        return {"content": content, "chars": len(content)}
    except RuntimeError as e:
        raise HTTPException(404, str(e))


@router.get("/{agent_id}")
def get_agent(agent_id: str):
    _, data = _find_file(agent_id)
    return data


@router.put("/{agent_id}")
def update_agent(agent_id: str, req: UniversalAgentIn):
    f, data = _find_file(agent_id)
    data.update({**req.model_dump(), "updated_at": datetime.utcnow().isoformat()})
    data["folder"] = _normalise_folder(data.get("folder", ""))
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
    copy_record = {
        **data,
        "id": str(uuid.uuid4()),
        "name": _next_copy_name(str(data.get("name", "Agent"))),
        "is_default": False,
        "created_at": now,
        "updated_at": now,
    }
    copy_record["folder"] = _normalise_folder(copy_record.get("folder", ""))
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
                   input_key: str = "") -> str:
    """Resolve one declared input to its text content."""
    from ui.backend.models.note import Note
    from ui.backend.models.persona import Persona

    ui_data = settings.ui_data_dir
    source = _normalize_input_source(source)

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
        from ui.backend.routers.agent_comparison import _build_and_save_merged_transcript
        merged = ui_data / "agents" / sales_agent / customer / "merged_transcript.txt"
        # Use cache only if it's the rich format (contains the ═ header)
        if merged.exists():
            try:
                text = merged.read_text(encoding="utf-8").strip()
                if "═" in text[:400]:
                    return text
            except Exception:
                pass
        # Pre-flight: ensure at least one transcript exists before attempting the merge.
        # Walk the pair directory looking for any smoothed/voted transcript file.
        pair_dir = ui_data / "agents" / sales_agent / customer
        _found_transcript = False
        if pair_dir.exists():
            for _call_dir in pair_dir.iterdir():
                if not _call_dir.is_dir() or _call_dir.name.startswith("."):
                    continue
                _llm = _call_dir / "transcribed" / "llm_final"
                if (_llm / "smoothed.txt").exists() or (_llm / "voted.txt").exists():
                    _found_transcript = True
                    break
                _pipeline = _call_dir / "transcribed" / "final"
                if _pipeline.exists() and any(_pipeline.iterdir()):
                    _found_transcript = True
                    break
        if not _found_transcript:
            raise RuntimeError(
                f"No transcripts found for {sales_agent} / {customer}. "
                f"Please transcribe calls first (CRM browser → click the Tx cell, "
                f"or Calls page → Select all → Transcribe)."
            )
        # Build rich version (saves to disk automatically for future cache)
        content = _build_and_save_merged_transcript(sales_agent, customer, force=True)
        if not content:
            raise RuntimeError(f"No transcripts found for {sales_agent}/{customer}")
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
        stmt = select(Note).where(
            Note.agent == sales_agent, Note.customer == customer
        ).order_by(Note.created_at.asc())
        notes = db.exec(stmt).all()
        if not notes:
            raise RuntimeError(f"No notes found for {sales_agent}/{customer}")
        return "\n\n---\n\n".join(
            f"Call: {n.call_id}\n{n.content_md}" for n in notes
        )

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

                yield _sse("progress", {"msg": f"Loading {key} ({display_source})…"})

                try:
                    text = await loop.run_in_executor(
                        None,
                        lambda s=source, a=ref_id, k=key: _resolve_input(
                            s, a, req.sales_agent, req.customer, req.call_id,
                            req.manual_inputs, db, input_key=k
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
            db.execute(
                _sql_text(
                    "INSERT INTO agent_result ("
                    "id, agent_id, agent_name, sales_agent, customer, call_id, content, model, created_at"
                    ") VALUES ("
                    ":id, :agent_id, :agent_name, :sales_agent, :customer, :call_id, :content, :model, :created_at"
                    ")"
                ),
                {
                    "id": result_id,
                    "agent_id": agent_id,
                    "agent_name": agent_def.get("name", ""),
                    "sales_agent": req.sales_agent,
                    "customer": req.customer,
                    "call_id": req.call_id,
                    "content": content,
                    "model": model,
                    "created_at": datetime.utcnow(),
                },
            )
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
