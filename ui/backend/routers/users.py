from __future__ import annotations

import json
from datetime import datetime
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel
from sqlmodel import Session, select

from ui.backend.config import settings
from ui.backend.database import get_session
from ui.backend.services import user_profiles

router = APIRouter(prefix="/users", tags=["users"])


class UserUpsertIn(BaseModel):
    name: str = ""
    role: str = "viewer"
    enabled: bool = True
    environments: list[str] = ["dev", "prod"]
    permissions: dict[str, bool] = {}


class DevPipelineSyncIn(BaseModel):
    pipeline_ids: list[str] = []
    owner_email: str = ""
    overwrite_existing: bool = True


@router.get("/me")
def get_me(request: Request):
    return user_profiles.get_current_user_profile(request)


@router.get("")
def list_users(request: Request):
    return {
        "ok": True,
        "users": user_profiles.list_users_for_admin(request),
    }


@router.put("/{email}")
def upsert_user(email: str, req: UserUpsertIn, request: Request):
    user = user_profiles.upsert_user_for_admin(
        request,
        email=email,
        name=req.name,
        role=req.role,
        enabled=req.enabled,
        environments=req.environments,
        permissions=req.permissions,
    )
    return {"ok": True, "user": user}


@router.delete("/{email}")
def delete_user(email: str, request: Request):
    return user_profiles.delete_user_for_admin(request, email)


@router.get("/{email}/work")
def get_user_work(
    email: str,
    request: Request,
    runs_limit: int = Query(200, ge=1, le=2000),
    db: Session = Depends(get_session),
):
    profile = user_profiles.get_current_user_profile(request)
    target_email = str(email or "").strip().lower()
    if not target_email or "@" not in target_email:
        raise HTTPException(status_code=400, detail="Valid email is required.")

    current_email = str(profile.get("email") or "").strip().lower()
    can_manage_users = bool((profile.get("permissions") or {}).get("can_manage_users"))
    if not can_manage_users and target_email != current_email:
        raise HTTPException(status_code=403, detail="You do not have permission to view other users' work.")

    from ui.backend.routers import pipelines as pipes
    from ui.backend.models.pipeline_run import PipelineRun

    all_pipelines = pipes._load_all()  # noqa: SLF001
    owned_pipelines: list[dict[str, Any]] = []
    for row in all_pipelines:
        if not isinstance(row, dict):
            continue
        owner = str(row.get("workspace_user_email") or "").strip().lower()
        if owner != target_email:
            continue
        owned_pipelines.append(
            {
                "id": str(row.get("id") or ""),
                "name": str(row.get("name") or ""),
                "folder": str(row.get("folder") or ""),
                "updated_at": str(row.get("updated_at") or ""),
                "created_at": str(row.get("created_at") or ""),
                "workspace_user_email": owner,
                "workspace_user_name": str(row.get("workspace_user_name") or ""),
            }
        )
    owned_pipelines.sort(
        key=lambda x: str(x.get("updated_at") or x.get("created_at") or ""),
        reverse=True,
    )

    pipeline_ids = [str(p.get("id") or "").strip() for p in owned_pipelines if str(p.get("id") or "").strip()]
    runs_out: list[dict[str, Any]] = []
    if pipeline_ids:
        rows = db.exec(
            select(PipelineRun)
            .where(PipelineRun.pipeline_id.in_(pipeline_ids))
            .order_by(PipelineRun.started_at.desc())
            .limit(runs_limit)
        ).all()
        for r in rows:
            runs_out.append(
                {
                    "id": r.id,
                    "pipeline_id": r.pipeline_id,
                    "pipeline_name": r.pipeline_name,
                    "sales_agent": r.sales_agent,
                    "customer": r.customer,
                    "call_id": r.call_id,
                    "status": r.status,
                    "started_at": r.started_at.isoformat() if r.started_at else None,
                    "finished_at": r.finished_at.isoformat() if r.finished_at else None,
                }
            )

    return {
        "ok": True,
        "email": target_email,
        "environment": str(profile.get("environment") or ""),
        "pipeline_count": len(owned_pipelines),
        "run_count": len(runs_out),
        "pipelines": owned_pipelines,
        "runs": runs_out,
    }


@router.post("/sync/dev-pipelines")
def sync_dev_pipelines(req: DevPipelineSyncIn, request: Request):
    profile = user_profiles.require_permission(request, "can_sync_pipelines")
    if str(profile.get("environment") or "") != "prod":
        raise HTTPException(status_code=403, detail="Pipeline sync is allowed only from production environment.")

    base_url = str(settings.dev_sync_base_url or "").strip().rstrip("/")
    if not base_url:
        raise HTTPException(status_code=400, detail="DEV_SYNC_BASE_URL is not configured.")

    timeout_s = max(5, min(int(settings.dev_sync_timeout_s or 25), 120))
    headers: dict[str, str] = {}
    auth_token = str(settings.dev_sync_auth_token or "").strip()
    if auth_token:
        hdr = str(settings.dev_sync_auth_header or "x-api-token").strip() or "x-api-token"
        headers[hdr] = auth_token
    acting_email = (
        str(profile.get("email") or "").strip().lower()
        or str(settings.user_admin_emails or "").split(",", 1)[0].strip().lower()
    )
    if acting_email:
        headers["x-shinobi-user-email"] = acting_email

    try:
        with httpx.Client(timeout=timeout_s, headers=headers) as client:
            list_resp = client.get(f"{base_url}/api/pipelines")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Unable to reach dev environment: {e}") from e

    if list_resp.status_code >= 400:
        raise HTTPException(
            status_code=list_resp.status_code,
            detail=f"Dev pipelines fetch failed: {list_resp.text}",
        )
    try:
        remote_pipelines = list_resp.json()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Dev pipelines response is not JSON: {e}") from e
    if not isinstance(remote_pipelines, list):
        raise HTTPException(status_code=502, detail="Dev pipelines response must be a list.")

    wanted_ids = {
        str(pid or "").strip()
        for pid in (req.pipeline_ids or [])
        if str(pid or "").strip()
    }
    owner_email = str(req.owner_email or "").strip().lower()

    selected: list[dict[str, Any]] = []
    for item in remote_pipelines:
        if not isinstance(item, dict):
            continue
        pid = str(item.get("id") or "").strip()
        if not pid:
            continue
        if wanted_ids and pid not in wanted_ids:
            continue
        if owner_email:
            owner = str(item.get("workspace_user_email") or "").strip().lower()
            if owner != owner_email:
                continue
        selected.append(item)

    from ui.backend.routers import pipelines as pipes

    pipes._DIR.mkdir(parents=True, exist_ok=True)

    synced = 0
    skipped_existing = 0
    failed: list[str] = []
    now_iso = datetime.utcnow().isoformat()

    for item in selected:
        pid = str(item.get("id") or "").strip()
        if not pid:
            continue
        out_path = pipes._DIR / f"{pid}.json"
        if out_path.exists() and not bool(req.overwrite_existing):
            skipped_existing += 1
            continue
        try:
            payload = dict(item)
            payload["id"] = pid
            payload["updated_at"] = now_iso
            payload["synced_from_dev_at"] = now_iso
            payload["synced_from_dev_by"] = str(profile.get("email") or "")
            if not str(payload.get("created_at") or "").strip():
                payload["created_at"] = now_iso
            if str(payload.get("folder") or "").strip():
                pipes._ensure_folder_exists(str(payload.get("folder") or ""))
            out_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
            synced += 1
        except Exception:
            failed.append(pid)

    pipes._sync_ai_registry_pipelines()

    return {
        "ok": True,
        "dev_base_url": base_url,
        "selected": len(selected),
        "synced": synced,
        "skipped_existing": skipped_existing,
        "failed": failed,
    }
