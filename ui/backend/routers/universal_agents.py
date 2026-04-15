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

def _sse(event: str, data: dict) -> str:
    return f"data: {json.dumps({'type': event, 'data': data})}\n\n"


def _llm_call(system: str, user: str, model: str, temperature: float) -> str:
    """Thin wrapper around the shared LLM client."""
    import sys
    sys.path.insert(0, str(settings.project_root))
    from shared.llm_client import LLMClient

    if model.startswith("claude-"):
        provider, key = "anthropic", os.environ.get("ANTHROPIC_API_KEY", "")
    elif model.startswith("gemini"):
        provider, key = "gemini", os.environ.get("GEMINI_API_KEY", "")
    elif model.startswith("grok"):
        provider = "grok"
        from shared.llm_client import resolve_grok_key
        key = resolve_grok_key() or ""
    else:
        provider, key = "openai", os.environ.get("OPENAI_API_KEY", "")

    if not key:
        raise RuntimeError(f"API key not set for provider '{provider}'")

    client = LLMClient(provider=provider, api_key=key)
    resp = client.chat_completion(
        model=model,
        messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
        temperature=temperature,
    )
    result = (resp.choices[0].message.content or "").strip()
    if result.startswith("```"):
        result = result.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
    return result


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

            # Substitute {key} vars into user_prompt
            user_prompt = agent_def.get("user_prompt", "")
            for k, v in resolved.items():
                user_prompt = user_prompt.replace(f"{{{k}}}", v)

            system_prompt = agent_def.get("system_prompt", "")
            model         = agent_def.get("model", "gpt-5.4")
            temperature   = float(agent_def.get("temperature", 0.0))

            yield _sse("progress", {"msg": f"Calling {model}…"})

            content = await loop.run_in_executor(
                None,
                lambda: _llm_call(system_prompt, user_prompt, model, temperature),
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
