"""Universal Agents — flexible multi-input LLM agent definitions."""
import asyncio
import json
import os
import queue as _queue
import threading
import uuid
from datetime import datetime
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlmodel import Session, select

from ui.backend.config import settings
from ui.backend.database import get_session
from ui.backend.services import log_buffer

router = APIRouter(prefix="/universal-agents", tags=["universal-agents"])

_DIR          = settings.ui_data_dir / "_universal_agents"
_PIPELINES    = settings.ui_data_dir / "_pipelines"
_FPA_PRESETS  = settings.ui_data_dir / "_fpa_analyzer_presets"
_NOTES_AGENTS = settings.ui_data_dir / "_notes_agents"

# Valid input source types
INPUT_SOURCES = [
    "transcript",         # single call transcript
    "merged_transcript",  # all transcripts for the pair merged
    "notes",              # notes for a specific call
    "merged_notes",       # all notes aggregated for the pair
    "agent_output",       # output of another specific agent
    "chain_previous",     # output of immediately preceding pipeline step
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


# ── Helpers ───────────────────────────────────────────────────────────────────

def _load_all() -> list[dict]:
    _DIR.mkdir(parents=True, exist_ok=True)
    out = []
    for f in sorted(_DIR.glob("*.json")):
        try:
            out.append(json.loads(f.read_text(encoding="utf-8")))
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


# ── Routes ────────────────────────────────────────────────────────────────────

@router.get("")
def list_agents():
    return _load_all()


@router.post("")
def create_agent(req: UniversalAgentIn):
    _DIR.mkdir(parents=True, exist_ok=True)
    now = datetime.utcnow().isoformat()
    record = {"id": str(uuid.uuid4()), "created_at": now, "updated_at": now, **req.model_dump()}
    (_DIR / f"{record['id']}.json").write_text(
        json.dumps(record, indent=2, ensure_ascii=False), encoding="utf-8"
    )
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
    f.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    return data


@router.delete("/{agent_id}")
def delete_agent(agent_id: str):
    f, _ = _find_file(agent_id)
    f.unlink()
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

    return {
        "created_agents":    created_agents,
        "created_pipelines": created_pipelines,
        "skipped":           skipped,
    }


# ── Run engine ────────────────────────────────────────────────────────────────

# Input sources that represent large text files — never pasted inline into the prompt.
# These are uploaded as native file objects to the LLM provider.
_FILE_SOURCES = {"transcript", "merged_transcript", "notes", "merged_notes"}

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
    Note: OpenAI/Grok Chat Completions don't support inline file references, so the returned
    content_with_header is still included as text in the message, but the file_id is logged
    and persisted for reference."""
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
    client = OpenAI(api_key=api_key, base_url=base_url)
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
    """Call OpenAI Responses API with file references — no inline content pasting."""
    from openai import OpenAI

    api_key = os.environ.get("OPENAI_API_KEY", "")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY not set")
    client = OpenAI(api_key=api_key, timeout=180.0)  # 3-min hard timeout — prevents hung threads
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

    # Build Responses API input: file blocks + text wrapped in a user message
    content: list = []
    for fid in file_ids.values():
        content.append({"type": "input_file", "file_id": fid})
    if user_text:
        content.append({"type": "input_text", "text": user_text})

    kwargs: dict = {
        "model": model,
        "input": [{"type": "message", "role": "user", "content": content}],
    }
    if system:
        kwargs["instructions"] = system
    if temperature > 0:
        kwargs["temperature"] = temperature

    response = client.responses.create(**kwargs)
    return _clean_result(response.output_text or ""), ""


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
                   manual_inputs: dict, db: Session) -> str:
    """Resolve one declared input to its text content."""
    from ui.backend.models.note import Note
    from ui.backend.models.agent_result import AgentResult as AR

    ui_data = settings.ui_data_dir

    if source == "transcript":
        if not call_id:
            # Per-pair context: fall back to merged transcript
            source = "merged_transcript"
        else:
            path = ui_data / "agents" / sales_agent / customer / call_id / "transcribed" / "llm_final" / "smoothed.txt"
            if not path.exists():
                raise RuntimeError(f"Transcript not found for call {call_id}")
            return path.read_text(encoding="utf-8").strip()

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
        stmt = select(AR).where(
            AR.agent_id == agent_id,
            AR.sales_agent == sales_agent,
            AR.customer == customer,
        )
        if call_id:
            stmt = stmt.where(AR.call_id == call_id)
        stmt = stmt.order_by(AR.created_at.desc())
        result = db.exec(stmt).first()
        if not result:
            raise RuntimeError(f"No stored result for agent {agent_id} in this context")
        return result.content

    if source == "chain_previous" or source.startswith("artifact_"):
        # artifact_persona / artifact_persona_score / artifact_notes / etc.
        # all resolve to the previous stage's output (chain_previous).
        return manual_inputs.get("_chain_previous", "")

    if source == "manual":
        return manual_inputs.get("manual", "")

    return ""


class RunRequest(BaseModel):
    sales_agent: str = ""
    customer: str = ""
    call_id: str = ""
    manual_inputs: dict = {}
    source_overrides: dict = {}  # input key → alternative source (e.g. "transcript" → "transcript")


@router.post("/{agent_id}/run")
async def run_agent(agent_id: str, req: RunRequest, db: Session = Depends(get_session)):
    """Execute a universal agent against a given context and stream results via SSE."""
    from ui.backend.models.agent_result import AgentResult as AR

    _, agent_def = _find_file(agent_id)

    async def stream():
        try:
            yield _sse("progress", {"msg": "Resolving inputs…"})

            # Resolve all inputs
            resolved: dict[str, str] = {}
            loop = asyncio.get_event_loop()

            for inp in agent_def.get("inputs", []):
                key     = inp.get("key", "input")
                # Allow caller to override the source for this input key
                source  = req.source_overrides.get(key, inp.get("source", "manual"))
                ref_id  = inp.get("agent_id")

                yield _sse("progress", {"msg": f"Loading {key} ({source})…"})

                try:
                    text = await loop.run_in_executor(
                        None,
                        lambda s=source, a=ref_id: _resolve_input(
                            s, a, req.sales_agent, req.customer, req.call_id,
                            req.manual_inputs, db
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
                effective_src = req.source_overrides.get(k, inp.get("source", "manual"))
                if effective_src in _FILE_SOURCES:
                    file_keys.add(k)

            file_inputs   = {k: v for k, v in resolved.items() if k in file_keys}
            inline_inputs = {k: v for k, v in resolved.items() if k not in file_keys}

            # Attach run context to db session so upload helpers can record it
            db._agent_run_ctx = {
                "sales_agent": req.sales_agent,
                "customer":    req.customer,
                "call_id":     req.call_id,
                "source_for_key": {
                    inp.get("key", ""): req.source_overrides.get(
                        inp.get("key", ""), inp.get("source", "")
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
            record = AR(
                id=result_id,
                agent_id=agent_id,
                agent_name=agent_def.get("name", ""),
                sales_agent=req.sales_agent,
                customer=req.customer,
                call_id=req.call_id,
                content=content,
                model=model,
            )
            db.add(record)
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
    from ui.backend.models.agent_result import AgentResult as AR

    stmt = select(AR).where(AR.agent_id == agent_id)
    if sales_agent:
        stmt = stmt.where(AR.sales_agent == sales_agent)
    if customer:
        stmt = stmt.where(AR.customer == customer)
    if call_id:
        stmt = stmt.where(AR.call_id == call_id)
    stmt = stmt.order_by(AR.created_at.desc())
    results = db.exec(stmt).all()
    return results
