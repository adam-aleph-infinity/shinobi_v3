"""Pipelines — ordered chains of universal agents."""
import json
import uuid
from datetime import datetime
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ui.backend.config import settings

router = APIRouter(prefix="/pipelines", tags=["pipelines"])

_DIR = settings.ui_data_dir / "_pipelines"


class PipelineStep(BaseModel):
    agent_id: str
    # Per-step input source overrides: { key: source_override }
    # e.g. {"note": "chain_previous"} overrides the agent's declared source for key "note"
    input_overrides: dict[str, str] = {}


class PipelineIn(BaseModel):
    name: str
    description: str = ""
    scope: str = "per_pair"   # per_call | per_pair
    steps: list[PipelineStep] = []


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


def _find_file(pipeline_id: str) -> tuple[Any, dict]:
    for f in _DIR.glob("*.json"):
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            if data.get("id") == pipeline_id:
                return f, data
        except Exception:
            pass
    raise HTTPException(404, f"Pipeline '{pipeline_id}' not found")


# ── Routes ────────────────────────────────────────────────────────────────────

@router.get("")
def list_pipelines():
    return _load_all()


@router.post("")
def create_pipeline(req: PipelineIn):
    _DIR.mkdir(parents=True, exist_ok=True)
    now = datetime.utcnow().isoformat()
    record = {"id": str(uuid.uuid4()), "created_at": now, "updated_at": now, **req.model_dump()}
    (_DIR / f"{record['id']}.json").write_text(
        json.dumps(record, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    return record


@router.get("/{pipeline_id}")
def get_pipeline(pipeline_id: str):
    _, data = _find_file(pipeline_id)
    return data


@router.put("/{pipeline_id}")
def update_pipeline(pipeline_id: str, req: PipelineIn):
    f, data = _find_file(pipeline_id)
    data.update({**req.model_dump(), "updated_at": datetime.utcnow().isoformat()})
    f.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    return data


@router.delete("/{pipeline_id}")
def delete_pipeline(pipeline_id: str):
    f, _ = _find_file(pipeline_id)
    f.unlink()
    return {"ok": True}
