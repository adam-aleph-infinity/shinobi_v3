from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from ui.backend.services.automations import (
    get_automations_snapshot,
    run_automation_now,
    update_automations,
)

router = APIRouter(prefix="/automations", tags=["automations"])


class AutomationConfigIn(BaseModel):
    id: str
    name: str | None = None
    description: str | None = None
    action: str | None = None
    enabled: bool = True
    schedule: str
    params: dict[str, Any] = Field(default_factory=dict)


class AutomationConfigSetIn(BaseModel):
    automations: list[AutomationConfigIn] = Field(default_factory=list)


@router.get("/config")
def get_automations_config(limit_runs: int = Query(default=120, ge=1, le=2000)):
    return get_automations_snapshot(limit_runs=limit_runs)


@router.put("/config")
def set_automations_config(payload: AutomationConfigSetIn):
    items = [
        {
            "id": str(row.id or "").strip(),
            "name": row.name,
            "description": row.description,
            "action": row.action,
            "enabled": bool(row.enabled),
            "schedule": str(row.schedule or "").strip(),
            "params": row.params or {},
        }
        for row in payload.automations
        if str(row.id or "").strip()
    ]
    update_automations(items)
    return get_automations_snapshot(limit_runs=120)


@router.post("/{automation_id}/run")
def run_automation(automation_id: str):
    ok, run_id_or_error = run_automation_now(automation_id)
    if not ok:
        raise HTTPException(status_code=400, detail=run_id_or_error)
    return {"ok": True, "run_id": run_id_or_error}
