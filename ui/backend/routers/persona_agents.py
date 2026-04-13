"""Persona Agents CRUD — manages the _persona_agents/ directory records."""
import json
import uuid
from datetime import datetime
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ui.backend.config import settings

router = APIRouter(prefix="/persona-agents", tags=["persona-agents"])

_PA_DIR = settings.ui_data_dir / "_persona_agents"


def _load_all() -> list[dict]:
    _PA_DIR.mkdir(parents=True, exist_ok=True)
    out = []
    for f in sorted(_PA_DIR.glob("*.json")):
        try:
            out.append(json.loads(f.read_text(encoding="utf-8")))
        except Exception:
            pass
    return out


def _find_file(record_id: str) -> tuple[Any, dict]:
    """Return (Path, data) for the record with the given id, or raise 404."""
    for f in _PA_DIR.glob("*.json"):
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            if data.get("id") == record_id:
                return f, data
        except Exception:
            pass
    raise HTTPException(404, "Persona agent not found")


class PersonaAgentIn(BaseModel):
    name: str
    description: str = ""
    persona_type: str = "pair"  # pair | agent_overall | customer
    system_prompt: str = ""
    user_prompt: str = ""
    temperature: float = 0.3
    model: str = ""
    is_default: bool = False
    sections: list[dict] = []


class PersonaAgentPatch(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    persona_type: Optional[str] = None
    system_prompt: Optional[str] = None
    user_prompt: Optional[str] = None
    temperature: Optional[float] = None
    model: Optional[str] = None
    is_default: Optional[bool] = None
    sections: Optional[list[dict]] = None


# ── Routes ────────────────────────────────────────────────────────────────────

@router.get("")
def list_agents():
    return _load_all()


@router.post("")
def create_agent(req: PersonaAgentIn):
    _PA_DIR.mkdir(parents=True, exist_ok=True)
    now = datetime.utcnow().isoformat()
    record = {
        "id": str(uuid.uuid4()),
        "created_at": now,
        "updated_at": now,
        **req.model_dump(),
    }
    if req.is_default:
        # Unset other defaults
        for f in _PA_DIR.glob("*.json"):
            try:
                d = json.loads(f.read_text(encoding="utf-8"))
                if d.get("is_default") and d.get("id") != record["id"]:
                    d["is_default"] = False
                    f.write_text(json.dumps(d, indent=2, ensure_ascii=False), encoding="utf-8")
            except Exception:
                pass
    (_PA_DIR / f"{record['id']}.json").write_text(
        json.dumps(record, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    return record


@router.get("/{agent_id}")
def get_agent(agent_id: str):
    _, data = _find_file(agent_id)
    return data


@router.put("/{agent_id}")
def update_agent(agent_id: str, req: PersonaAgentPatch):
    f, data = _find_file(agent_id)
    updates = {k: v for k, v in req.model_dump().items() if v is not None}
    data.update(updates)
    data["updated_at"] = datetime.utcnow().isoformat()
    if updates.get("is_default") is True:
        for other in _PA_DIR.glob("*.json"):
            if other == f:
                continue
            try:
                od = json.loads(other.read_text(encoding="utf-8"))
                if od.get("is_default"):
                    od["is_default"] = False
                    other.write_text(json.dumps(od, indent=2, ensure_ascii=False), encoding="utf-8")
            except Exception:
                pass
    f.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    return data


@router.patch("/{agent_id}/default")
def set_default(agent_id: str):
    target_f, target_data = _find_file(agent_id)
    # Unset all others
    for f in _PA_DIR.glob("*.json"):
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


@router.delete("/{agent_id}")
def delete_agent(agent_id: str):
    f, _ = _find_file(agent_id)
    f.unlink()
    return {"ok": True}


# ── Section suggestion (LLM-powered) ─────────────────────────────────────────

class SuggestSectionIn(BaseModel):
    field: str  # "name" | "cover" | "score" | "all"
    name: str = ""
    instruction: str = ""
    scoring_instruction: str = ""
    other_sections: list[dict] = []


@router.post("/suggest-section")
async def suggest_section(req: SuggestSectionIn):
    """Use an LLM to suggest section content for the section builder."""
    try:
        from openai import AsyncOpenAI
        client = AsyncOpenAI()

        others_desc = "\n".join(
            f"- {s.get('name', '')}: {s.get('instruction', '')[:80]}"
            for s in req.other_sections
        ) or "None yet."

        system = (
            "You are a persona analysis expert. Help define a section for a persona evaluation framework. "
            "Return ONLY valid JSON with the requested fields — no markdown, no explanation."
        )

        if req.field == "name":
            prompt = (
                f"Existing sections:\n{others_desc}\n\n"
                "Suggest a concise name (3–6 words) for a NEW distinct section. "
                'Return: {"name": "..."}'
            )
        elif req.field == "cover":
            prompt = (
                f"Section name: {req.name}\n"
                f"Existing sections:\n{others_desc}\n\n"
                "Write a clear instruction for what this section should cover and analyse. "
                "Be specific and actionable, 2–4 sentences. "
                'Return: {"instruction": "..."}'
            )
        elif req.field == "score":
            prompt = (
                f"Section name: {req.name}\n"
                f"What it covers: {req.instruction[:200]}\n\n"
                "Write a concise scoring instruction (1–2 sentences) for how to assign a 0–100 score. "
                'Return: {"scoring_instruction": "..."}'
            )
        else:  # "all"
            prompt = (
                f"Existing sections:\n{others_desc}\n\n"
                "Design a complete NEW distinct section for a persona evaluation. "
                'Return: {"name": "...", "instruction": "...", "scoring_instruction": "..."}'
            )

        resp = await client.chat.completions.create(
            model="gpt-4.1-mini",
            messages=[{"role": "system", "content": system}, {"role": "user", "content": prompt}],
            temperature=0.7,
            max_tokens=300,
        )
        return json.loads(resp.choices[0].message.content or "{}")
    except Exception as e:
        raise HTTPException(500, str(e))
