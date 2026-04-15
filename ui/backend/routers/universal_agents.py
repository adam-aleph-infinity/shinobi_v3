"""Universal Agents — flexible multi-input LLM agent definitions."""
import asyncio
import json
import os
import uuid
from datetime import datetime
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlmodel import Session, select

from ui.backend.config import settings
from ui.backend.database import get_session

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
                tags: list[str], is_default: bool = False) -> dict:
    now = datetime.utcnow().isoformat()
    return {
        "id": str(uuid.uuid4()),
        "created_at": now, "updated_at": now,
        "name": name, "description": "",
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


def _clean_result(text: str) -> str:
    text = text.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
    return text


def _llm_call_gemini_files(
    system: str,
    user_template: str,
    file_inputs: dict,   # key → text content
    inline_inputs: dict, # key → text content
    model: str,
    temperature: float,
) -> str:
    """Gemini call: each file input is uploaded via the Files API (never inlined)."""
    import io
    import google.generativeai as genai

    api_key = os.environ.get("GEMINI_API_KEY", "")
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY not set")
    genai.configure(api_key=api_key)

    uploaded: list = []
    try:
        # Upload each file input to Gemini's File API
        for key, content in file_inputs.items():
            f = genai.upload_file(
                io.BytesIO(content.encode("utf-8")),
                mime_type="text/plain",
                display_name=f"{key}.txt",
            )
            uploaded.append((key, f))

        # Build user message — strip {key} placeholders for uploaded files,
        # substitute inline inputs normally.
        user_text = user_template
        for key, _ in uploaded:
            user_text = user_text.replace(f"{{{key}}}", "")
        for key, val in inline_inputs.items():
            user_text = user_text.replace(f"{{{key}}}", val)

        # Content parts: file objects first, then the instruction text
        parts = [f for _, f in uploaded] + [user_text.strip()]

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
            return _clean_result(response.text)
        except ValueError as e:
            finish = ""
            try:
                finish = response.candidates[0].finish_reason.name if response.candidates else "NONE"
            except Exception:
                pass
            raise RuntimeError(f"Gemini blocked/empty (finish_reason={finish}): {e}") from e

    finally:
        for _, f in uploaded:
            try:
                genai.delete_file(f.name)
            except Exception:
                pass


def _llm_call_anthropic_docs(
    system: str,
    user_template: str,
    file_inputs: dict,
    inline_inputs: dict,
    model: str,
    temperature: float,
) -> str:
    """Anthropic call: file inputs become document content blocks (not inlined as raw text)."""
    import anthropic

    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        raise RuntimeError("ANTHROPIC_API_KEY not set")
    client = anthropic.Anthropic(api_key=api_key)

    content_blocks: list = []
    user_text = user_template

    # Add each file as a document block; strip the placeholder from the text
    for key, content in file_inputs.items():
        user_text = user_text.replace(f"{{{key}}}", "")
        content_blocks.append({
            "type": "document",
            "source": {"type": "text", "media_type": "text/plain", "data": content},
            "title": key,
        })

    for key, val in inline_inputs.items():
        user_text = user_text.replace(f"{{{key}}}", val)

    content_blocks.append({"type": "text", "text": user_text.strip()})

    kwargs: dict = {
        "model": model,
        "max_tokens": 8192,
        "system": system,
        "messages": [{"role": "user", "content": content_blocks}],
    }
    if temperature is not None and temperature > 0:
        kwargs["temperature"] = temperature

    response = client.messages.create(**kwargs)
    text = "\n\n".join(
        block.text for block in response.content
        if getattr(block, "type", None) == "text"
    )
    return _clean_result(text)


def _llm_call_with_files(
    system: str,
    user_template: str,
    file_inputs: dict,   # inputs from _FILE_SOURCES — never pasted inline
    inline_inputs: dict, # small inputs (agent_output, manual, chain_previous)
    model: str,
    temperature: float,
) -> str:
    """
    Route to the right provider implementation.
    File inputs are uploaded as native file/document objects.
    For OpenAI / Grok, file inputs are still inlined (no native file API in chat).
    """
    if model.startswith("gemini"):
        return _llm_call_gemini_files(system, user_template, file_inputs, inline_inputs, model, temperature)

    if model.startswith("claude-"):
        return _llm_call_anthropic_docs(system, user_template, file_inputs, inline_inputs, model, temperature)

    # OpenAI / Grok: inline everything (they handle large context well)
    import sys
    sys.path.insert(0, str(settings.project_root))
    from shared.llm_client import LLMClient

    provider = "grok" if model.startswith("grok") else "openai"
    if provider == "grok":
        from shared.llm_client import resolve_grok_key
        key = resolve_grok_key() or ""
    else:
        key = os.environ.get("OPENAI_API_KEY", "")
    if not key:
        raise RuntimeError(f"API key not set for provider '{provider}'")

    user = user_template
    for k, v in {**file_inputs, **inline_inputs}.items():
        user = user.replace(f"{{{k}}}", v)

    client = LLMClient(provider=provider, api_key=key)
    resp = client.chat_completion(
        model=model,
        messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
        temperature=temperature,
    )
    return _clean_result(resp.choices[0].message.content or "")


def _resolve_input(source: str, agent_id: Optional[str],
                   sales_agent: str, customer: str, call_id: str,
                   manual_inputs: dict, db: Session) -> str:
    """Resolve one declared input to its text content."""
    from ui.backend.models.note import Note
    from ui.backend.models.agent_result import AgentResult as AR

    ui_data = settings.ui_data_dir

    if source == "transcript":
        path = ui_data / "agents" / sales_agent / customer / call_id / "transcribed" / "llm_final" / "smoothed.txt"
        if not path.exists():
            raise RuntimeError(f"Transcript not found for call {call_id}")
        return path.read_text(encoding="utf-8").strip()

    if source == "merged_transcript":
        merged = ui_data / "agents" / sales_agent / customer / "merged_transcript.txt"
        if merged.exists():
            return merged.read_text(encoding="utf-8").strip()
        # Build on the fly
        pair_dir = ui_data / "agents" / sales_agent / customer
        parts = []
        for call_dir in sorted(pair_dir.iterdir()):
            s = call_dir / "transcribed" / "llm_final" / "smoothed.txt"
            if s.exists():
                parts.append(f"--- {call_dir.name} ---\n{s.read_text(encoding='utf-8').strip()}")
        if not parts:
            raise RuntimeError(f"No transcripts found for {sales_agent}/{customer}")
        content = "\n\n".join(parts)
        merged.write_text(content, encoding="utf-8")
        return content

    if source == "notes":
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

            yield _sse("progress", {
                "msg": f"Calling {model}… ({len(file_inputs)} file(s), {len(inline_inputs)} inline)"
            })

            content = await loop.run_in_executor(
                None,
                lambda: _llm_call_with_files(
                    system_prompt, user_template,
                    file_inputs, inline_inputs,
                    model, temperature,
                ),
            )

            # Save result
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

            yield _sse("done", {"content": content, "result_id": result_id})

        except Exception as e:
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
