"""Universal Agents — flexible multi-input LLM agent definitions."""
import json
import uuid
from datetime import datetime
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ui.backend.config import settings

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
            gen = _make_agent(
                name=gen_name,
                model=p.get("gen_model", "gpt-5.4"),
                temperature=float(p.get("gen_temperature", 0.0)),
                system_prompt=p.get("gen_system_prompt", ""),
                user_prompt=p.get("gen_user_prompt", ""),
                inputs=[{"key": "transcript", "source": "merged_transcript"}],
                output_format="markdown",
                tags=["persona", "generator"],
                is_default=bool(p.get("is_default", False)),
            )
            _write_agent(gen)
            created_agents.append(gen_name)

            # Scorer agent — inputs: persona (agent_output) + transcript (merged)
            scorer = _make_agent(
                name=score_name,
                model=p.get("score_model", "gpt-5.4"),
                temperature=float(p.get("score_temperature", 0.0)),
                system_prompt=p.get("score_system_prompt", ""),
                user_prompt=p.get("score_user_prompt", ""),
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
