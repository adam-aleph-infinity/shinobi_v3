import json
import uuid
from datetime import datetime
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ui.backend.config import settings

router = APIRouter(prefix="/persona-agents", tags=["persona-agents"])

_DIR = settings.ui_data_dir / "_persona_agents"


def _all() -> list[dict]:
    if not _DIR.exists():
        return []
    items = []
    for f in sorted(_DIR.glob("*.json")):
        try:
            items.append(json.loads(f.read_text()))
        except Exception:
            continue
    items.sort(key=lambda x: x.get("created_at", ""), reverse=True)
    # Starred agent always first
    items.sort(key=lambda x: (0 if x.get("is_default") else 1))
    return items


def _load(id: str) -> dict:
    p = _DIR / f"{id}.json"
    if not p.exists():
        raise HTTPException(404, "Persona agent not found")
    return json.loads(p.read_text())


def _save(data: dict):
    _DIR.mkdir(parents=True, exist_ok=True)
    (_DIR / f"{data['id']}.json").write_text(json.dumps(data, indent=2, default=str))


class PersonaAgentCreate(BaseModel):
    name: str
    description: str = ""
    persona_type: str = "agent_overall"   # agent_overall | pair | customer
    system_prompt: str = ""               # short preamble (global rules); assembled with sections on run
    user_prompt: str = ""
    temperature: float = 0.0
    model: str = "gpt-5.4"
    is_default: bool = False
    sections: list = []                   # list of PersonaSection dicts


class PersonaAgentUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    persona_type: Optional[str] = None
    system_prompt: Optional[str] = None
    user_prompt: Optional[str] = None
    temperature: Optional[float] = None
    model: Optional[str] = None
    is_default: Optional[bool] = None
    sections: Optional[list] = None


@router.get("/defaults/{persona_type}")
def get_defaults(persona_type: str):
    """Return default sections + preamble for a given persona type."""
    from ui.backend.routers.personas import _DEFAULT_SECTIONS, _DEFAULT_PREAMBLE
    return {
        "sections": _DEFAULT_SECTIONS.get(persona_type, _DEFAULT_SECTIONS["agent_overall"]),
        "preamble": _DEFAULT_PREAMBLE.get(persona_type, _DEFAULT_PREAMBLE["agent_overall"]),
    }


@router.get("")
def list_agents():
    return _all()


@router.post("")
def create_agent(req: PersonaAgentCreate):
    if req.is_default:
        # Clear default flag on all others
        for a in _all():
            if a.get("is_default") and a["id"] != "":
                a["is_default"] = False
                _save(a)
    data = {
        "id": str(uuid.uuid4()),
        "created_at": datetime.utcnow().isoformat(),
        "updated_at": datetime.utcnow().isoformat(),
        **req.model_dump(),
    }
    _save(data)
    return data


@router.put("/{id}")
def update_agent(id: str, req: PersonaAgentUpdate):
    data = _load(id)
    updates = req.model_dump(exclude_none=True)
    if updates.get("is_default"):
        # Clear default on all others
        for a in _all():
            if a.get("is_default") and a["id"] != id:
                a["is_default"] = False
                _save(a)
    for k, v in updates.items():
        data[k] = v
    data["updated_at"] = datetime.utcnow().isoformat()
    _save(data)
    return data


@router.patch("/{id}/default")
def set_default_agent(id: str):
    """Set an agent as the default (and clear default on all others)."""
    if not (_DIR / f"{id}.json").exists():
        raise HTTPException(404, "Persona agent not found")
    for a in _all():
        new_default = a["id"] == id
        if a.get("is_default") != new_default:
            a["is_default"] = new_default
            _save(a)
    return {"ok": True}


@router.delete("/{id}")
def delete_agent(id: str):
    p = _DIR / f"{id}.json"
    if not p.exists():
        raise HTTPException(404, "Not found")
    p.unlink()
    return {"ok": True}


class SuggestSectionRequest(BaseModel):
    field: str                            # "name" | "cover" | "score" | "all"
    name: str = ""
    instruction: str = ""                 # current "what to cover"
    scoring_instruction: str = ""         # current "how to score"
    other_sections: list = []             # other existing sections [{name, instruction, scoring_instruction}]


_SUGGEST_SYSTEM = """You are a behavioral research persona designer.
You help design analysis sections for LLM-powered persona agents used in sales call research.

A persona agent defines sections that the LLM analyzes from sales call transcripts.
Each section has:
- name: short heading (3-6 words)
- instruction (what to cover): what behaviors/patterns to look for and quote
- scoring_instruction (how to score): scoring criteria where 100 = highest research flag intensity

Research scoring model:
- High score = high research value (flag this for researchers to study)
- Non-compliant + effective = highest value; Compliant + ineffective = lowest value
- All sections use higher_better (high score = flag for research, not a quality medal)

Return ONLY valid JSON. No explanation, no markdown, no preamble."""


@router.post("/suggest-section")
def suggest_section(req: SuggestSectionRequest):
    """Use LLM to auto-fill one or more fields of a persona section."""
    import json as _json
    from ui.backend.routers.final_transcript import _llm_call

    others_text = ""
    if req.other_sections:
        lines = []
        for s in req.other_sections[:10]:
            lines.append(f"- {s.get('name', '?')}: {s.get('instruction', '')[:80]}")
        others_text = "\nOther sections already defined:\n" + "\n".join(lines)

    if req.field == "name":
        prompt = (
            f"Given this section's content:\n"
            f"What to cover: {req.instruction or '(not set)'}\n"
            f"How to score: {req.scoring_instruction or '(not set)'}\n"
            f"{others_text}\n\n"
            f"Suggest a short section name (3-6 words, title case).\n"
            f'Return JSON: {{"name": "..."}}'
        )
    elif req.field == "cover":
        prompt = (
            f"Section name: {req.name or '(not set)'}\n"
            f"How to score: {req.scoring_instruction or '(not set)'}\n"
            f"{others_text}\n\n"
            f"Write a 'What to Cover' instruction for this section: what behaviors, patterns, "
            f"quotes or dimensions the LLM should look for in sales call transcripts.\n"
            f'Return JSON: {{"instruction": "..."}}'
        )
    elif req.field == "score":
        prompt = (
            f"Section name: {req.name or '(not set)'}\n"
            f"What to cover: {req.instruction or '(not set)'}\n"
            f"{others_text}\n\n"
            f"Write a 'How to Score' scoring guide for this section. "
            f"Score 0-100 where high = high research flag intensity (not a quality badge). "
            f"Include concrete thresholds (e.g. '80-100 if..., 40-70 if..., 0-39 if...').\n"
            f'Return JSON: {{"scoring_instruction": "..."}}'
        )
    else:  # "all"
        prompt = (
            f"Existing data for this section:\n"
            f"Name: {req.name or '(empty)'}\n"
            f"What to cover: {req.instruction or '(empty)'}\n"
            f"How to score: {req.scoring_instruction or '(empty)'}\n"
            f"{others_text}\n\n"
            f"Fill in all missing or weak fields. Generate a complete, research-focused "
            f"section that would complement the existing sections.\n"
            f"Return JSON with all three fields: "
            f'{{"name": "...", "instruction": "...", "scoring_instruction": "..."}}'
        )

    raw = _llm_call(_SUGGEST_SYSTEM, prompt, "gpt-4.1-mini")
    raw = raw.strip()
    if raw.startswith("```"):
        raw = raw.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
    try:
        return _json.loads(raw)
    except Exception:
        raise HTTPException(500, f"Failed to parse suggestion: {raw[:300]}")
