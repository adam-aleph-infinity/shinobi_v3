"""In-app AI copilot chat with constrained tool access.

The assistant can inspect and operate on workflow data (agents/pipelines/runs/logs)
but cannot modify application source code.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import inspect as _sa_inspect, text as _sql_text
from sqlmodel import Session, select

from shared.llm_client import LLMClient
from ui.backend.config import settings
from ui.backend.database import engine
from ui.backend.models.pipeline_run import PipelineRun
from ui.backend.routers import pipelines as pipelines_router
from ui.backend.routers import universal_agents as universal_agents_router
from ui.backend.services import assistant_knowledge, execution_logs, log_buffer

router = APIRouter(prefix="/assistant", tags=["assistant"])

_SESSION_DIR = settings.ui_data_dir / "copilot" / "sessions"
_SESSION_DIR.mkdir(parents=True, exist_ok=True)
_LEGACY_SESSION_DIR = settings.ui_data_dir / "_assistant_sessions"

_TEXT_EXTS = {".json", ".txt", ".md", ".log", ".csv", ".srt"}
_CLEANUP_ARTIFACT_TYPES = {
    "all",
    "pipeline_runs",
    "notes",
    "personas",
    "execution_logs",
    "uploaded_files",
    "pipeline_artifacts",
    "agent_results",
}

_DEFAULT_MODEL = os.environ.get("ASSISTANT_MODEL", "gpt-5.4")
_DEFAULT_MAX_TOKENS = int(os.environ.get("ASSISTANT_MAX_TOKENS", "32000"))
_MAX_MODEL_MESSAGES = 80
_MAX_TOOL_ROUNDS = 14
_MAX_SUB_AGENT_TOOL_ROUNDS = 6
_PLANNER_CRITIC_ENABLED = os.environ.get("ASSISTANT_PLANNER_CRITIC_ENABLED", "1").strip().lower() not in {
    "0",
    "false",
    "no",
}
_PLANNER_CRITIC_MAX_TOKENS = int(os.environ.get("ASSISTANT_PLANNER_CRITIC_MAX_TOKENS", "12000"))
_MODEL_ALIASES = {
    # Anthropic currently exposes Sonnet 4.6 as the active Sonnet 4 API model.
    # Keep this alias so users can request "Sonnet 4.7" without breaking requests.
    "claude-sonnet-4-7": "claude-sonnet-4-6",
    "claude-sonnet-4.7": "claude-sonnet-4-6",
}

_SUPPORTED_ORCHESTRATION_PROVIDERS = {"openai", "anthropic"}
_CORRECTION_HINTS = (
    "wrong",
    "incorrect",
    "not right",
    "didnt work",
    "didn't work",
    "failed",
    "fix this",
    "fix it",
    "try again",
    "you missed",
    "not what i asked",
)

_DEFAULT_MODEL_CATALOG = [
    {
        "id": "gpt-5.4",
        "label": "OpenAI Best (gpt-5.4)",
        "provider": "openai",
        "description": "Max-quality OpenAI reasoning/tool orchestration.",
    },
    {
        "id": "claude-opus-4-7",
        "label": "Anthropic Best (Claude Opus 4.7)",
        "provider": "anthropic",
        "description": "Max-quality Anthropic reasoning/tool orchestration.",
    },
    {
        "id": "claude-sonnet-4-7",
        "label": "Claude Sonnet 4.7 (compat alias)",
        "provider": "anthropic",
        "description": "Compatibility alias that routes to Claude Sonnet 4.6.",
    },
    {
        "id": "claude-sonnet-4-6",
        "label": "Claude Sonnet 4.6 (stable)",
        "provider": "anthropic",
        "description": "Current stable Sonnet 4 API model.",
    },
    {
        "id": "gpt-5.3-codex",
        "label": "OpenAI Codex Fast (fallback)",
        "provider": "openai",
        "description": "Faster fallback OpenAI model for iteration.",
    },
]


def _migrate_legacy_sessions() -> None:
    if not _LEGACY_SESSION_DIR.exists() or not _LEGACY_SESSION_DIR.is_dir():
        return
    for legacy_file in _LEGACY_SESSION_DIR.glob("*.json"):
        target = _SESSION_DIR / legacy_file.name
        if target.exists():
            continue
        try:
            target.write_text(legacy_file.read_text(encoding="utf-8"), encoding="utf-8")
        except Exception:
            continue


_migrate_legacy_sessions()


SYSTEM_PROMPT = (
    "You are Shinobi Copilot, an expert workflow assistant inside the Shinobi app.\n"
    "Your mission is to help users build pipelines, debug failed runs, and inspect app data.\n"
    "\n"
    "Hard safety boundaries:\n"
    "- You MUST use tools for factual app state (agents, pipelines, runs, logs, workspace files).\n"
    "- You MAY create or update pipeline definitions via tools when the user asks.\n"
    "- You MUST NOT attempt to modify application source code or deployment config.\n"
    "- Never claim an action was executed unless a tool result confirms it.\n"
    "\n"
    "Behavior:\n"
    "- Be concise and practical.\n"
    "- For debugging, identify root cause, evidence, and exact next fixes.\n"
    "- For pipeline design, propose concrete steps and assumptions.\n"
    "- For artifact cleanup requests, run cleanup_artifacts in dry-run first, then execute only after explicit user confirmation.\n"
)


class SessionCreateIn(BaseModel):
    title: str = ""


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=40000)
    model: str = ""
    max_tool_rounds: int = Field(default=8, ge=1, le=_MAX_TOOL_ROUNDS)


def _now_iso() -> str:
    return datetime.utcnow().isoformat()


def _sse(event: str, data: dict[str, Any]) -> str:
    return f"data: {json.dumps({'type': event, 'data': data}, ensure_ascii=False)}\\n\\n"


def _session_path(session_id: str) -> Path:
    sid = str(session_id or "").strip()
    if not sid:
        raise HTTPException(400, "session_id is required")
    if any(c in sid for c in ("/", "\\", "..", "\x00")):
        raise HTTPException(400, "Invalid session_id")
    return _SESSION_DIR / f"{sid}.json"


def _default_session(title: str = "") -> dict[str, Any]:
    now = _now_iso()
    return {
        "id": str(uuid.uuid4()),
        "title": (title or "New Copilot Chat").strip()[:120] or "New Copilot Chat",
        "created_at": now,
        "updated_at": now,
        "messages": [],
        "model_messages": [],
    }


def _load_session(session_id: str) -> dict[str, Any]:
    path = _session_path(session_id)
    if not path.exists():
        raise HTTPException(404, "Session not found")
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise HTTPException(500, f"Failed to parse session: {exc}") from exc
    if not isinstance(payload, dict):
        raise HTTPException(500, "Corrupt session file")
    payload.setdefault("messages", [])
    payload.setdefault("model_messages", [])
    return payload


def _save_session(session: dict[str, Any]) -> None:
    sid = str(session.get("id") or "").strip()
    if not sid:
        raise HTTPException(500, "Session missing id")

    model_messages = session.get("model_messages")
    if isinstance(model_messages, list) and len(model_messages) > _MAX_MODEL_MESSAGES:
        session["model_messages"] = model_messages[-_MAX_MODEL_MESSAGES:]

    session["updated_at"] = _now_iso()
    path = _session_path(sid)
    path.write_text(json.dumps(session, ensure_ascii=False, indent=2), encoding="utf-8")


def _append_display_message(session: dict[str, Any], role: str, content: str, meta: Optional[dict[str, Any]] = None) -> None:
    items = session.setdefault("messages", [])
    if not isinstance(items, list):
        items = []
        session["messages"] = items
    items.append(
        {
            "id": str(uuid.uuid4()),
            "role": role,
            "content": str(content or ""),
            "created_at": _now_iso(),
            "meta": meta or {},
        }
    )


def _append_model_message(session: dict[str, Any], message: dict[str, Any]) -> None:
    items = session.setdefault("model_messages", [])
    if not isinstance(items, list):
        items = []
        session["model_messages"] = items
    items.append(message)


def _tool_specs(include_sub_agent: bool = True) -> list[dict[str, Any]]:
    tools: list[dict[str, Any]] = [
        {
            "type": "function",
            "function": {
                "name": "list_universal_agents",
                "description": "List available universal agents.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "limit": {"type": "integer", "minimum": 1, "maximum": 200, "default": 100}
                    },
                    "additionalProperties": False,
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "get_universal_agent",
                "description": "Get one universal agent by ID.",
                "parameters": {
                    "type": "object",
                    "properties": {"agent_id": {"type": "string"}},
                    "required": ["agent_id"],
                    "additionalProperties": False,
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "list_pipelines",
                "description": "List existing pipelines.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "limit": {"type": "integer", "minimum": 1, "maximum": 200, "default": 100}
                    },
                    "additionalProperties": False,
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "get_pipeline",
                "description": "Get one pipeline definition by ID.",
                "parameters": {
                    "type": "object",
                    "properties": {"pipeline_id": {"type": "string"}},
                    "required": ["pipeline_id"],
                    "additionalProperties": False,
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "create_pipeline",
                "description": (
                    "Create a new pipeline in Shinobi. This writes only to ui/data pipeline definitions "
                    "and cannot modify source code."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string"},
                        "description": {"type": "string"},
                        "scope": {"type": "string", "default": "per_pair"},
                        "folder": {"type": "string", "default": ""},
                        "steps": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "agent_id": {"type": "string"},
                                    "input_overrides": {"type": "object", "additionalProperties": {"type": "string"}},
                                },
                                "required": ["agent_id"],
                                "additionalProperties": False,
                            },
                            "minItems": 1,
                        },
                    },
                    "required": ["name", "steps"],
                    "additionalProperties": False,
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "update_pipeline",
                "description": "Replace an existing pipeline definition by ID.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "pipeline_id": {"type": "string"},
                        "name": {"type": "string"},
                        "description": {"type": "string"},
                        "scope": {"type": "string", "default": "per_pair"},
                        "folder": {"type": "string", "default": ""},
                        "steps": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "agent_id": {"type": "string"},
                                    "input_overrides": {"type": "object", "additionalProperties": {"type": "string"}},
                                },
                                "required": ["agent_id"],
                                "additionalProperties": False,
                            },
                            "minItems": 1,
                        },
                    },
                    "required": ["pipeline_id", "name", "steps"],
                    "additionalProperties": False,
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "list_recent_runs",
                "description": "List recent pipeline runs from global history.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "limit": {"type": "integer", "minimum": 1, "maximum": 200, "default": 25},
                        "pipeline_id": {"type": "string", "default": ""},
                        "sales_agent": {"type": "string", "default": ""},
                        "customer": {"type": "string", "default": ""},
                    },
                    "additionalProperties": False,
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "get_run",
                "description": "Get one pipeline run including status, steps_json, and log_json.",
                "parameters": {
                    "type": "object",
                    "properties": {"run_id": {"type": "string"}},
                    "required": ["run_id"],
                    "additionalProperties": False,
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "analyze_run_failure",
                "description": "Extract a deterministic failure summary from a failed run.",
                "parameters": {
                    "type": "object",
                    "properties": {"run_id": {"type": "string"}},
                    "required": ["run_id"],
                    "additionalProperties": False,
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "list_execution_logs",
                "description": "List recent execution log sessions.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "limit": {"type": "integer", "minimum": 1, "maximum": 500, "default": 50},
                        "action": {"type": "string", "default": ""},
                        "source": {"type": "string", "default": ""},
                    },
                    "additionalProperties": False,
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "get_execution_log",
                "description": "Get one execution log session with all events.",
                "parameters": {
                    "type": "object",
                    "properties": {"session_id": {"type": "string"}},
                    "required": ["session_id"],
                    "additionalProperties": False,
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "cleanup_artifacts",
                "description": (
                    "Delete old artifacts while keeping the most recent N records. "
                    "Defaults to dry-run preview. Use confirm='DELETE' with dry_run=false to execute."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "artifact_type": {
                            "type": "string",
                            "enum": sorted(_CLEANUP_ARTIFACT_TYPES),
                            "default": "all",
                        },
                        "keep_latest": {"type": "integer", "minimum": 0, "maximum": 2000, "default": 10},
                        "dry_run": {"type": "boolean", "default": True},
                        "confirm": {"type": "string", "default": ""},
                        "sales_agent": {"type": "string", "default": ""},
                        "customer": {"type": "string", "default": ""},
                        "pipeline_id": {"type": "string", "default": ""},
                        "call_id": {"type": "string", "default": ""},
                    },
                    "additionalProperties": False,
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "preview_workspace_file",
                "description": "Read a text file under ui/data by relative path.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string"},
                        "max_chars": {"type": "integer", "minimum": 500, "maximum": 200000, "default": 12000},
                    },
                    "required": ["path"],
                    "additionalProperties": False,
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "get_app_map",
                "description": "Get the auto-generated internal app map and counts.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "refresh": {"type": "boolean", "default": False},
                    },
                    "additionalProperties": False,
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "list_copilot_memory",
                "description": "Retrieve learned memory entries relevant to a query.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string", "default": ""},
                        "limit": {"type": "integer", "minimum": 1, "maximum": 100, "default": 12},
                    },
                    "additionalProperties": False,
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "list_copilot_skills",
                "description": "Retrieve learned skill entries relevant to a query.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string", "default": ""},
                        "limit": {"type": "integer", "minimum": 1, "maximum": 100, "default": 12},
                    },
                    "additionalProperties": False,
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "remember_lesson",
                "description": "Persist a lesson/memory so future chats improve.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "text": {"type": "string"},
                        "kind": {"type": "string", "default": "lesson"},
                        "confidence": {"type": "number", "minimum": 0, "maximum": 1, "default": 0.7},
                        "tags": {"type": "array", "items": {"type": "string"}},
                    },
                    "required": ["text"],
                    "additionalProperties": False,
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "update_skill",
                "description": "Create or update a reusable skill guideline for Copilot.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string"},
                        "guidance": {"type": "string"},
                        "confidence": {"type": "number", "minimum": 0, "maximum": 1, "default": 0.75},
                        "tags": {"type": "array", "items": {"type": "string"}},
                    },
                    "required": ["name", "guidance"],
                    "additionalProperties": False,
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "refresh_copilot_familiarity",
                "description": (
                    "Refresh copilot familiarization snapshot from live app state (CRM DB, agents, pipelines, runs). "
                    "Use this when data changed and copilot should re-learn current topology."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "force": {"type": "boolean", "default": False},
                    },
                    "additionalProperties": False,
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "distill_successful_run_skills",
                "description": (
                    "Auto-distill reusable pipeline skills from recent successful runs. "
                    "Use after completing or validating runs to improve future design quality."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "limit": {"type": "integer", "minimum": 5, "maximum": 500, "default": 120},
                        "force": {"type": "boolean", "default": False},
                    },
                    "additionalProperties": False,
                },
            },
        },
    ]
    if include_sub_agent:
        tools.append(
            {
                "type": "function",
                "function": {
                    "name": "spawn_sub_agent",
                    "description": (
                        "Run a focused sub-agent to plan/check a specific subtask. "
                        "Useful for second-opinion reasoning."
                    ),
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "goal": {"type": "string"},
                            "model": {"type": "string", "default": ""},
                            "provider": {"type": "string", "default": ""},
                        },
                        "required": ["goal"],
                        "additionalProperties": False,
                    },
                },
            }
        )
    return tools


def _normalize_step(step: dict[str, Any]) -> dict[str, Any]:
    agent_id = str(step.get("agent_id") or "").strip()
    if not agent_id:
        raise HTTPException(400, "Each step requires agent_id")

    raw_overrides = step.get("input_overrides")
    overrides: dict[str, str] = {}
    if isinstance(raw_overrides, dict):
        for k, v in raw_overrides.items():
            key = str(k or "").strip()
            if not key:
                continue
            overrides[key] = str(v or "")

    return {"agent_id": agent_id, "input_overrides": overrides}


def _tool_list_universal_agents(args: dict[str, Any]) -> dict[str, Any]:
    limit = max(1, min(200, int(args.get("limit", 100) or 100)))
    rows = universal_agents_router._load_all()[:limit]
    return {
        "count": len(rows),
        "agents": [
            {
                "id": str(a.get("id") or ""),
                "name": str(a.get("name") or ""),
                "agent_class": str(a.get("agent_class") or ""),
                "model": str(a.get("model") or ""),
                "folder": str(a.get("folder") or ""),
                "updated_at": str(a.get("updated_at") or a.get("created_at") or ""),
            }
            for a in rows
        ],
    }


def _tool_get_universal_agent(args: dict[str, Any]) -> dict[str, Any]:
    agent_id = str(args.get("agent_id") or "").strip()
    if not agent_id:
        raise HTTPException(400, "agent_id is required")
    _, data = universal_agents_router._find_file(agent_id)
    return data


def _tool_list_pipelines(args: dict[str, Any]) -> dict[str, Any]:
    limit = max(1, min(200, int(args.get("limit", 100) or 100)))
    rows = pipelines_router._load_all()[:limit]
    return {
        "count": len(rows),
        "pipelines": [
            {
                "id": str(p.get("id") or ""),
                "name": str(p.get("name") or ""),
                "description": str(p.get("description") or ""),
                "scope": str(p.get("scope") or ""),
                "folder": str(p.get("folder") or ""),
                "step_count": len(p.get("steps") or []),
                "updated_at": str(p.get("updated_at") or p.get("created_at") or ""),
            }
            for p in rows
        ],
    }


def _tool_get_pipeline(args: dict[str, Any]) -> dict[str, Any]:
    pipeline_id = str(args.get("pipeline_id") or "").strip()
    if not pipeline_id:
        raise HTTPException(400, "pipeline_id is required")
    _, data = pipelines_router._find_file(pipeline_id)
    return data


def _validate_agent_ids_exist(steps: list[dict[str, Any]]) -> None:
    known = {str(a.get("id") or "") for a in universal_agents_router._load_all()}
    missing = [s["agent_id"] for s in steps if s.get("agent_id") not in known]
    if missing:
        raise HTTPException(
            400,
            "Unknown agent_id(s): " + ", ".join(sorted(set(missing))),
        )


def _tool_create_pipeline(args: dict[str, Any]) -> dict[str, Any]:
    steps_raw = args.get("steps")
    if not isinstance(steps_raw, list) or not steps_raw:
        raise HTTPException(400, "steps must be a non-empty array")

    steps = [_normalize_step(s if isinstance(s, dict) else {}) for s in steps_raw]
    _validate_agent_ids_exist(steps)

    req = pipelines_router.PipelineIn(
        name=str(args.get("name") or "").strip(),
        description=str(args.get("description") or ""),
        scope=str(args.get("scope") or "per_pair"),
        folder=str(args.get("folder") or ""),
        steps=[pipelines_router.PipelineStep(**s) for s in steps],
        canvas={},
    )
    if not req.name:
        raise HTTPException(400, "name is required")

    created = pipelines_router.create_pipeline(req)
    return {
        "created": True,
        "pipeline": {
            "id": created.get("id"),
            "name": created.get("name"),
            "step_count": len(created.get("steps") or []),
            "folder": created.get("folder", ""),
            "scope": created.get("scope", ""),
        },
    }


def _tool_update_pipeline(args: dict[str, Any]) -> dict[str, Any]:
    pipeline_id = str(args.get("pipeline_id") or "").strip()
    if not pipeline_id:
        raise HTTPException(400, "pipeline_id is required")

    steps_raw = args.get("steps")
    if not isinstance(steps_raw, list) or not steps_raw:
        raise HTTPException(400, "steps must be a non-empty array")
    steps = [_normalize_step(s if isinstance(s, dict) else {}) for s in steps_raw]
    _validate_agent_ids_exist(steps)

    req = pipelines_router.PipelineIn(
        name=str(args.get("name") or "").strip(),
        description=str(args.get("description") or ""),
        scope=str(args.get("scope") or "per_pair"),
        folder=str(args.get("folder") or ""),
        steps=[pipelines_router.PipelineStep(**s) for s in steps],
        canvas={},
    )
    if not req.name:
        raise HTTPException(400, "name is required")

    updated = pipelines_router.update_pipeline(pipeline_id, req)
    return {
        "updated": True,
        "pipeline": {
            "id": updated.get("id"),
            "name": updated.get("name"),
            "step_count": len(updated.get("steps") or []),
            "folder": updated.get("folder", ""),
            "scope": updated.get("scope", ""),
        },
    }


def _run_to_dict(r: PipelineRun) -> dict[str, Any]:
    return {
        "id": r.id,
        "pipeline_id": r.pipeline_id,
        "pipeline_name": r.pipeline_name,
        "sales_agent": r.sales_agent,
        "customer": r.customer,
        "call_id": r.call_id,
        "status": r.status,
        "started_at": r.started_at.isoformat() if r.started_at else None,
        "finished_at": r.finished_at.isoformat() if r.finished_at else None,
        "canvas_json": r.canvas_json,
        "steps_json": r.steps_json,
        "log_json": r.log_json,
    }


def _tool_list_recent_runs(args: dict[str, Any]) -> dict[str, Any]:
    limit = max(1, min(200, int(args.get("limit", 25) or 25)))
    pipeline_id = str(args.get("pipeline_id") or "").strip()
    sales_agent = str(args.get("sales_agent") or "").strip()
    customer = str(args.get("customer") or "").strip()

    with Session(engine) as db:
        stmt = select(PipelineRun)
        if pipeline_id:
            stmt = stmt.where(PipelineRun.pipeline_id == pipeline_id)
        if sales_agent:
            stmt = stmt.where(PipelineRun.sales_agent == sales_agent)
        if customer:
            stmt = stmt.where(PipelineRun.customer == customer)
        stmt = stmt.order_by(PipelineRun.started_at.desc()).limit(limit)
        rows = db.exec(stmt).all()

    return {"count": len(rows), "runs": [_run_to_dict(r) for r in rows]}


def _tool_get_run(args: dict[str, Any]) -> dict[str, Any]:
    run_id = str(args.get("run_id") or "").strip()
    if not run_id:
        raise HTTPException(400, "run_id is required")
    with Session(engine) as db:
        run = db.get(PipelineRun, run_id)
    if not run:
        raise HTTPException(404, "Run not found")
    return _run_to_dict(run)


def _tool_analyze_run_failure(args: dict[str, Any]) -> dict[str, Any]:
    run_id = str(args.get("run_id") or "").strip()
    if not run_id:
        raise HTTPException(400, "run_id is required")

    with Session(engine) as db:
        run = db.get(PipelineRun, run_id)
    if not run:
        raise HTTPException(404, "Run not found")

    steps_raw = []
    logs_raw = []
    try:
        parsed = json.loads(run.steps_json or "[]")
        if isinstance(parsed, list):
            steps_raw = parsed
    except Exception:
        pass
    try:
        parsed = json.loads(run.log_json or "[]")
        if isinstance(parsed, list):
            logs_raw = parsed
    except Exception:
        pass

    failed_steps = []
    for idx, step in enumerate(steps_raw):
        if not isinstance(step, dict):
            continue
        state = str(step.get("state") or step.get("status") or "").lower()
        if state in {"failed", "error"}:
            failed_steps.append(
                {
                    "index": idx,
                    "agent_name": str(step.get("agent_name") or ""),
                    "agent_id": str(step.get("agent_id") or ""),
                    "error_msg": str(step.get("error_msg") or ""),
                }
            )

    error_lines = []
    for row in logs_raw:
        if not isinstance(row, dict):
            continue
        text = str(row.get("text") or "")
        lo = text.lower()
        if any(k in lo for k in ("error", "failed", "exception", "traceback", "timeout", "rate limit")):
            error_lines.append(text)

    return {
        "run_id": run.id,
        "pipeline_id": run.pipeline_id,
        "pipeline_name": run.pipeline_name,
        "status": run.status,
        "failed_steps": failed_steps,
        "error_line_count": len(error_lines),
        "error_lines": error_lines[-40:],
        "note": (
            "Run is not marked as error" if str(run.status or "").lower() not in {"error", "failed"}
            else "Failure evidence extracted"
        ),
    }


def _tool_list_execution_logs(args: dict[str, Any]) -> dict[str, Any]:
    limit = max(1, min(500, int(args.get("limit", 50) or 50)))
    action = str(args.get("action") or "")
    source = str(args.get("source") or "")
    rows = execution_logs.list_recent(limit=limit, action=action, source=source)
    return {"count": len(rows), "logs": rows}


def _tool_get_execution_log(args: dict[str, Any]) -> dict[str, Any]:
    session_id = str(args.get("session_id") or "").strip()
    if not session_id:
        raise HTTPException(400, "session_id is required")
    row = execution_logs.get_session(session_id)
    if not row:
        raise HTTPException(404, "Execution log not found")
    return row


def _cleanup_filters(args: dict[str, Any]) -> dict[str, str]:
    return {
        "sales_agent": str(args.get("sales_agent") or "").strip(),
        "customer": str(args.get("customer") or "").strip(),
        "pipeline_id": str(args.get("pipeline_id") or "").strip(),
        "call_id": str(args.get("call_id") or "").strip(),
    }


def _table_columns(table_name: str) -> set[str]:
    try:
        return {str(c.get("name") or "") for c in _sa_inspect(engine).get_columns(table_name)}
    except Exception:
        return set()


def _log_matches_filters(payload: dict[str, Any], filters: dict[str, str]) -> bool:
    ctx = payload.get("context") if isinstance(payload.get("context"), dict) else {}

    def _pick(*keys: str) -> str:
        for key in keys:
            v = ctx.get(key) if isinstance(ctx, dict) else None
            if v is None:
                v = payload.get(key)
            txt = str(v or "").strip()
            if txt:
                return txt
        return ""

    sales_agent = filters.get("sales_agent") or ""
    customer = filters.get("customer") or ""
    pipeline_id = filters.get("pipeline_id") or ""
    call_id = filters.get("call_id") or ""

    if sales_agent:
        got = _pick("sales_agent", "agent", "salesAgent")
        if got != sales_agent:
            return False
    if customer:
        got = _pick("customer", "customer_name")
        if got != customer:
            return False
    if pipeline_id:
        got = _pick("pipeline_id", "pipeline")
        if got != pipeline_id:
            return False
    if call_id:
        got = _pick("call_id", "call")
        if got != call_id:
            return False
    return True


def _collect_cleanup_rows(artifact_type: str, filters: dict[str, str], db: Optional[Session]) -> list[dict[str, Any]]:
    at = artifact_type
    sales_agent = filters.get("sales_agent") or ""
    customer = filters.get("customer") or ""
    pipeline_id = filters.get("pipeline_id") or ""
    call_id = filters.get("call_id") or ""

    if at == "pipeline_runs":
        if not _table_columns("pipeline_run"):
            return []
        stmt = select(PipelineRun)
        if sales_agent:
            stmt = stmt.where(PipelineRun.sales_agent == sales_agent)
        if customer:
            stmt = stmt.where(PipelineRun.customer == customer)
        if pipeline_id:
            stmt = stmt.where(PipelineRun.pipeline_id == pipeline_id)
        if call_id:
            stmt = stmt.where(PipelineRun.call_id == call_id)
        stmt = stmt.order_by(PipelineRun.started_at.desc())
        rows = (db.exec(stmt).all() if db is not None else [])
        return [
            {
                "id": str(r.id),
                "ts": (r.started_at.isoformat() if r.started_at else ""),
                "_row": r,
            }
            for r in rows
        ]

    if at == "notes":
        if not _table_columns("note"):
            return []
        from ui.backend.models.note import Note

        stmt = select(Note)
        if sales_agent:
            stmt = stmt.where(Note.agent == sales_agent)
        if customer:
            stmt = stmt.where(Note.customer == customer)
        if call_id:
            stmt = stmt.where(Note.call_id == call_id)
        stmt = stmt.order_by(Note.created_at.desc())
        rows = (db.exec(stmt).all() if db is not None else [])
        return [
            {
                "id": str(r.id),
                "ts": (r.created_at.isoformat() if r.created_at else ""),
                "_row": r,
            }
            for r in rows
        ]

    if at == "personas":
        if not _table_columns("persona"):
            return []
        from ui.backend.models.persona import Persona

        stmt = select(Persona)
        if sales_agent:
            stmt = stmt.where(Persona.agent == sales_agent)
        if customer:
            stmt = stmt.where(Persona.customer == customer)
        stmt = stmt.order_by(Persona.created_at.desc())
        rows = (db.exec(stmt).all() if db is not None else [])
        return [
            {
                "id": str(r.id),
                "ts": (r.created_at.isoformat() if r.created_at else ""),
                "_row": r,
            }
            for r in rows
        ]

    if at == "uploaded_files":
        if not _table_columns("uploaded_file"):
            return []
        from ui.backend.models.uploaded_file import UploadedFile

        stmt = select(UploadedFile)
        if sales_agent:
            stmt = stmt.where(UploadedFile.sales_agent == sales_agent)
        if customer:
            stmt = stmt.where(UploadedFile.customer == customer)
        if call_id:
            stmt = stmt.where(UploadedFile.call_id == call_id)
        stmt = stmt.order_by(UploadedFile.created_at.desc())
        rows = (db.exec(stmt).all() if db is not None else [])
        return [
            {
                "id": str(r.id),
                "ts": (r.created_at.isoformat() if r.created_at else ""),
                "_row": r,
            }
            for r in rows
        ]

    if at == "pipeline_artifacts":
        if not _table_columns("pipeline_artifact"):
            return []
        from ui.backend.models.pipeline_artifact import PipelineArtifact

        stmt = select(PipelineArtifact)
        if sales_agent:
            stmt = stmt.where(PipelineArtifact.sales_agent == sales_agent)
        if customer:
            stmt = stmt.where(PipelineArtifact.customer == customer)
        if pipeline_id:
            stmt = stmt.where(PipelineArtifact.pipeline_id == pipeline_id)
        if call_id:
            stmt = stmt.where(PipelineArtifact.call_id == call_id)
        stmt = stmt.order_by(PipelineArtifact.updated_at.desc())
        rows = (db.exec(stmt).all() if db is not None else [])
        return [
            {
                "id": str(r.id),
                "ts": (r.updated_at.isoformat() if r.updated_at else ""),
                "_row": r,
            }
            for r in rows
        ]

    if at == "agent_results":
        if db is None:
            return []
        cols = _table_columns("agent_result")
        if not cols or "id" not in cols:
            return []

        if pipeline_id and "pipeline_id" not in cols:
            return []
        if sales_agent and "sales_agent" not in cols:
            return []
        if customer and "customer" not in cols:
            return []
        if call_id and "call_id" not in cols:
            return []

        has_created_at = "created_at" in cols
        select_cols = "id" + (", created_at" if has_created_at else "")
        where: list[str] = []
        params: dict[str, Any] = {}
        if sales_agent:
            where.append("sales_agent = :sales_agent")
            params["sales_agent"] = sales_agent
        if customer:
            where.append("customer = :customer")
            params["customer"] = customer
        if pipeline_id:
            where.append("pipeline_id = :pipeline_id")
            params["pipeline_id"] = pipeline_id
        if call_id:
            where.append("call_id = :call_id")
            params["call_id"] = call_id

        sql = f"SELECT {select_cols} FROM agent_result"
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY " + ("created_at DESC" if has_created_at else "id DESC")
        rows = db.execute(_sql_text(sql), params).all()
        out: list[dict[str, Any]] = []
        for r in rows:
            try:
                rid = str(getattr(r, "id", None) or r[0] or "")
            except Exception:
                rid = str((r.get("id") if isinstance(r, dict) else "") or "")
            if not rid:
                continue
            created = ""
            if has_created_at:
                try:
                    raw_dt = getattr(r, "created_at", None)
                    if raw_dt is None and hasattr(r, "_mapping"):
                        raw_dt = r._mapping.get("created_at")
                    created = str(raw_dt.isoformat() if hasattr(raw_dt, "isoformat") else (raw_dt or ""))
                except Exception:
                    created = ""
            out.append({"id": rid, "ts": created})
        return out

    if at == "execution_logs":
        log_dir = settings.ui_data_dir / "execution_logs"
        out: list[dict[str, Any]] = []
        if not log_dir.exists():
            return out
        for path in sorted(log_dir.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
            try:
                payload = json.loads(path.read_text(encoding="utf-8"))
            except Exception:
                payload = {}
            if not isinstance(payload, dict):
                payload = {}
            if not _log_matches_filters(payload, filters):
                continue
            out.append(
                {
                    "id": str(payload.get("session_id") or path.stem),
                    "ts": str(payload.get("updated_at_utc") or ""),
                    "_path": path,
                }
            )
        return out

    raise HTTPException(400, f"Unsupported artifact_type '{artifact_type}'")


def _cleanup_one_type(
    artifact_type: str,
    *,
    keep_latest: int,
    dry_run: bool,
    filters: dict[str, str],
) -> dict[str, Any]:
    at = artifact_type
    if at == "execution_logs":
        try:
            rows = _collect_cleanup_rows(at, filters, None)
        except Exception as exc:
            return {
                "artifact_type": at,
                "total_matched": 0,
                "keep_latest": keep_latest,
                "kept_count": 0,
                "delete_count": 0,
                "deleted_count": 0,
                "dry_run": dry_run,
                "kept_ids": [],
                "delete_ids_preview": [],
                "errors": [str(exc)],
            }
        keep = rows[:keep_latest]
        remove = rows[keep_latest:]
        deleted_ids: list[str] = []
        errors: list[str] = []
        if not dry_run:
            for item in remove:
                path = item.get("_path")
                try:
                    if isinstance(path, Path) and path.exists():
                        path.unlink()
                    deleted_ids.append(str(item.get("id") or ""))
                except Exception as exc:
                    errors.append(str(exc))
        return {
            "artifact_type": at,
            "total_matched": len(rows),
            "keep_latest": keep_latest,
            "kept_count": len(keep),
            "delete_count": len(remove),
            "deleted_count": 0 if dry_run else len(deleted_ids),
            "dry_run": dry_run,
            "kept_ids": [str(x.get("id") or "") for x in keep[:25]],
            "delete_ids_preview": [str(x.get("id") or "") for x in remove[:50]],
            "errors": errors[:20],
        }

    with Session(engine) as db:
        try:
            rows = _collect_cleanup_rows(at, filters, db)
        except Exception as exc:
            return {
                "artifact_type": at,
                "total_matched": 0,
                "keep_latest": keep_latest,
                "kept_count": 0,
                "delete_count": 0,
                "deleted_count": 0,
                "dry_run": dry_run,
                "kept_ids": [],
                "delete_ids_preview": [],
                "errors": [str(exc)],
            }
        keep = rows[:keep_latest]
        remove = rows[keep_latest:]
        deleted_ids: list[str] = []
        errors: list[str] = []

        if not dry_run:
            if at == "uploaded_files":
                for item in remove:
                    rid = str(item.get("id") or "")
                    if not rid:
                        continue
                    try:
                        universal_agents_router.delete_uploaded_file(rid, db)
                        deleted_ids.append(rid)
                    except Exception as exc:
                        errors.append(str(exc))
            elif at == "agent_results":
                for item in remove:
                    rid = str(item.get("id") or "")
                    if not rid:
                        continue
                    try:
                        db.execute(_sql_text("DELETE FROM agent_result WHERE id = :id"), {"id": rid})
                        deleted_ids.append(rid)
                    except Exception as exc:
                        errors.append(str(exc))
                try:
                    db.commit()
                except Exception as exc:
                    db.rollback()
                    errors.append(str(exc))
            else:
                for item in remove:
                    row = item.get("_row")
                    rid = str(item.get("id") or "")
                    try:
                        if row is not None:
                            db.delete(row)
                            if rid:
                                deleted_ids.append(rid)
                    except Exception as exc:
                        errors.append(str(exc))
                try:
                    db.commit()
                except Exception as exc:
                    db.rollback()
                    errors.append(str(exc))

        return {
            "artifact_type": at,
            "total_matched": len(rows),
            "keep_latest": keep_latest,
            "kept_count": len(keep),
            "delete_count": len(remove),
            "deleted_count": 0 if dry_run else len(deleted_ids),
            "dry_run": dry_run,
            "kept_ids": [str(x.get("id") or "") for x in keep[:25]],
            "delete_ids_preview": [str(x.get("id") or "") for x in remove[:50]],
            "errors": errors[:20],
        }


def _tool_cleanup_artifacts(args: dict[str, Any]) -> dict[str, Any]:
    artifact_type = str(args.get("artifact_type") or "all").strip().lower() or "all"
    if artifact_type not in _CLEANUP_ARTIFACT_TYPES:
        raise HTTPException(400, f"artifact_type must be one of: {', '.join(sorted(_CLEANUP_ARTIFACT_TYPES))}")
    keep_latest = max(0, min(2000, int(args.get("keep_latest", 10) or 10)))
    dry_run = bool(args.get("dry_run", True))
    confirm = str(args.get("confirm") or "").strip()
    if not dry_run and confirm != "DELETE":
        raise HTTPException(400, "Destructive cleanup requires confirm='DELETE'")

    filters = _cleanup_filters(args)
    targets = (
        [x for x in sorted(_CLEANUP_ARTIFACT_TYPES) if x != "all"]
        if artifact_type == "all"
        else [artifact_type]
    )
    per_type = [
        _cleanup_one_type(t, keep_latest=keep_latest, dry_run=dry_run, filters=filters)
        for t in targets
    ]

    return {
        "ok": True,
        "artifact_type": artifact_type,
        "mode": "dry_run" if dry_run else "delete",
        "keep_latest": keep_latest,
        "filters": filters,
        "per_type": per_type,
        "summary": {
            "types": len(per_type),
            "total_matched": sum(int(r.get("total_matched") or 0) for r in per_type),
            "total_to_delete": sum(int(r.get("delete_count") or 0) for r in per_type),
            "total_deleted": sum(int(r.get("deleted_count") or 0) for r in per_type),
            "error_count": sum(len(r.get("errors") or []) for r in per_type),
        },
    }


def _safe_workspace_path(rel: str) -> Path:
    candidate = (settings.ui_data_dir / str(rel or "")).resolve()
    root = settings.ui_data_dir.resolve()
    if not str(candidate).startswith(str(root)):
        raise HTTPException(400, "Path outside ui/data is not allowed")
    return candidate


def _tool_preview_workspace_file(args: dict[str, Any]) -> dict[str, Any]:
    rel = str(args.get("path") or "").strip()
    if not rel:
        raise HTTPException(400, "path is required")
    max_chars = max(500, min(200000, int(args.get("max_chars", 12000) or 12000)))

    path = _safe_workspace_path(rel)
    if not path.is_file():
        raise HTTPException(404, "File not found")
    if path.suffix.lower() not in _TEXT_EXTS:
        raise HTTPException(400, f"Preview not supported for extension {path.suffix}")

    text = path.read_text(encoding="utf-8", errors="replace")
    truncated = len(text) > max_chars
    if truncated:
        text = text[:max_chars]

    return {
        "path": str(path.relative_to(settings.ui_data_dir)),
        "size": path.stat().st_size,
        "chars": len(text),
        "truncated": truncated,
        "content": text,
    }


def _tool_get_app_map(args: dict[str, Any], *, tools: list[dict[str, Any]]) -> dict[str, Any]:
    refresh = bool(args.get("refresh"))
    if refresh:
        assistant_knowledge.ensure_app_map(tools, force=True)
    return assistant_knowledge.get_app_map()


def _tool_list_copilot_memory(args: dict[str, Any]) -> dict[str, Any]:
    query = str(args.get("query") or "")
    limit = max(1, min(100, int(args.get("limit", 12) or 12)))
    rows = assistant_knowledge.list_memory(limit=limit, query=query)
    return {"count": len(rows), "memory": rows}


def _tool_list_copilot_skills(args: dict[str, Any]) -> dict[str, Any]:
    query = str(args.get("query") or "")
    limit = max(1, min(100, int(args.get("limit", 12) or 12)))
    rows = assistant_knowledge.list_skills(limit=limit, query=query)
    return {"count": len(rows), "skills": rows}


def _tool_remember_lesson(args: dict[str, Any], *, session_id: str) -> dict[str, Any]:
    text = str(args.get("text") or "").strip()
    if not text:
        raise HTTPException(400, "text is required")
    kind = str(args.get("kind") or "lesson").strip() or "lesson"
    confidence = float(args.get("confidence", 0.7) or 0.7)
    tags = args.get("tags")
    if not isinstance(tags, list):
        tags = []
    row = assistant_knowledge.add_memory(
        text=text,
        source="assistant_tool",
        kind=kind,
        confidence=confidence,
        tags=[str(t) for t in tags],
        meta={"session_id": session_id},
    )
    return {"saved": True, "memory_id": row.get("id"), "kind": row.get("kind")}


def _tool_update_skill(args: dict[str, Any], *, session_id: str) -> dict[str, Any]:
    name = str(args.get("name") or "").strip()
    guidance = str(args.get("guidance") or "").strip()
    if not name:
        raise HTTPException(400, "name is required")
    if not guidance:
        raise HTTPException(400, "guidance is required")
    confidence = float(args.get("confidence", 0.75) or 0.75)
    tags = args.get("tags")
    if not isinstance(tags, list):
        tags = []
    row = assistant_knowledge.upsert_skill(
        name=name,
        guidance=guidance,
        source="assistant_tool",
        confidence=confidence,
        tags=[str(t) for t in tags],
        meta={"session_id": session_id},
    )
    return {"updated": True, "skill_id": row.get("id"), "name": row.get("name")}


def _tool_distill_successful_run_skills(args: dict[str, Any], *, force: bool = False) -> dict[str, Any]:
    limit = max(5, min(500, int(args.get("limit", 120) or 120)))
    do_force = bool(args.get("force")) or bool(force)
    result = assistant_knowledge.distill_skills_from_successful_runs(limit=limit, force=do_force)
    result["distillation_state"] = assistant_knowledge.get_distillation_state()
    return result


def _tool_refresh_copilot_familiarity(args: dict[str, Any], *, tools: list[dict[str, Any]]) -> dict[str, Any]:
    do_force = bool(args.get("force"))
    result = assistant_knowledge.familiarize_with_live_app(
        tool_specs=tools,
        force=do_force,
    )
    result["distillation_state"] = assistant_knowledge.get_distillation_state()
    return result


def _run_sub_agent(
    *,
    goal: str,
    model: str,
    provider: str,
    parent_model: str,
    parent_provider: str,
    parent_session_id: str,
) -> dict[str, Any]:
    requested_model = str(model or "").strip() or parent_model
    chosen_model = _canonical_model_id(requested_model)
    chosen_provider = str(provider or "").strip().lower() or _assistant_model_provider(chosen_model)
    if chosen_provider not in {"openai", "anthropic", "gemini", "grok", "mistral"}:
        chosen_provider = parent_provider
    key = _resolve_provider_key(chosen_provider)
    if not key:
        raise HTTPException(400, f"Missing API key for provider '{chosen_provider}'")

    supports_tools = chosen_provider in _SUPPORTED_ORCHESTRATION_PROVIDERS
    sub_tools = _tool_specs(include_sub_agent=False)
    assistant_knowledge.ensure_app_map(sub_tools, force=False)
    sub_system = (
        f"{_build_dynamic_system_prompt(goal, sub_tools)}\n"
        "\n"
        "You are a Shinobi Copilot sub-agent.\n"
        "- Solve only the assigned sub-goal.\n"
        "- Use tools when factual verification is needed.\n"
        "- Never claim actions were executed unless tool results confirm.\n"
        "- Return concise findings, assumptions, and recommended next action."
    )
    user = f"SUB-AGENT GOAL:\n{goal}"

    model_messages: list[dict[str, Any]] = [{"role": "user", "content": user}]
    trace: list[dict[str, Any]] = []
    client = LLMClient(provider=chosen_provider, api_key=key)
    text = ""
    tool_calls_used = 0

    if not supports_tools:
        resp = client.chat_completion(
            model=chosen_model,
            messages=[{"role": "system", "content": sub_system}] + model_messages,
            temperature=0,
            max_tokens=_DEFAULT_MAX_TOKENS,
            thinking=True,
        )
        text = _message_content_text(resp.choices[0].message).strip()
    else:
        for round_idx in range(_MAX_SUB_AGENT_TOOL_ROUNDS):
            resp = client.chat_completion(
                model=chosen_model,
                messages=[{"role": "system", "content": sub_system}] + model_messages,
                temperature=0,
                max_tokens=_DEFAULT_MAX_TOKENS,
                thinking=True,
                tools=sub_tools,
                tool_choice="auto",
            )
            message = resp.choices[0].message
            msg_text = _message_content_text(message)
            raw_tool_calls = getattr(message, "tool_calls", None) or []
            if raw_tool_calls:
                tool_calls = [_serialize_tool_call(tc) for tc in raw_tool_calls]
                model_messages.append({"role": "assistant", "content": msg_text, "tool_calls": tool_calls})
                for tc in tool_calls:
                    fn = tc.get("function") or {}
                    name = str(fn.get("name") or "")
                    args_raw = str(fn.get("arguments") or "{}")
                    tc_id = str(tc.get("id") or str(uuid.uuid4()))
                    try:
                        parsed_args = _parse_json_args(args_raw)
                        tool_result = _execute_tool(
                            name,
                            parsed_args,
                            ctx={
                                "session_id": parent_session_id,
                                "model": chosen_model,
                                "provider": chosen_provider,
                                "tools": sub_tools,
                                "sub_agent": True,
                            },
                        )
                        ok = True
                    except Exception as exc:
                        tool_result = {"ok": False, "error": str(exc)}
                        ok = False
                    tool_text = json.dumps(tool_result, ensure_ascii=False)
                    model_messages.append({"role": "tool", "tool_call_id": tc_id, "content": tool_text})
                    trace.append(
                        {
                            "round": round_idx + 1,
                            "tool": name,
                            "ok": ok,
                            "preview": tool_text[:600] + ("…" if len(tool_text) > 600 else ""),
                        }
                    )
                    tool_calls_used += 1
                continue
            text = msg_text.strip()
            break

    if not text:
        text = "Sub-agent returned empty output."

    artifact = assistant_knowledge.save_sub_agent_artifact(
        {
            "goal": goal,
            "provider": chosen_provider,
            "requested_model": requested_model,
            "model": chosen_model,
            "supports_tools": supports_tools,
            "tool_calls_used": tool_calls_used,
            "trace": trace[-80:],
            "output": text,
            "parent_session_id": parent_session_id,
        }
    )
    return {
        "ok": True,
        "goal": goal,
        "provider": chosen_provider,
        "requested_model": requested_model,
        "model": chosen_model,
        "output": text,
        "supports_tools": supports_tools,
        "tool_calls_used": tool_calls_used,
        "artifact": artifact,
    }


def _tool_spawn_sub_agent(args: dict[str, Any], *, model: str, provider: str, session_id: str) -> dict[str, Any]:
    goal = str(args.get("goal") or "").strip()
    if not goal:
        raise HTTPException(400, "goal is required")
    requested_model = str(args.get("model") or "").strip()
    requested_provider = str(args.get("provider") or "").strip().lower()
    return _run_sub_agent(
        goal=goal,
        model=requested_model,
        provider=requested_provider,
        parent_model=model,
        parent_provider=provider,
        parent_session_id=session_id,
    )


_TOOL_HANDLERS: dict[str, Callable[[dict[str, Any]], dict[str, Any]]] = {
    "list_universal_agents": _tool_list_universal_agents,
    "get_universal_agent": _tool_get_universal_agent,
    "list_pipelines": _tool_list_pipelines,
    "get_pipeline": _tool_get_pipeline,
    "create_pipeline": _tool_create_pipeline,
    "update_pipeline": _tool_update_pipeline,
    "list_recent_runs": _tool_list_recent_runs,
    "get_run": _tool_get_run,
    "analyze_run_failure": _tool_analyze_run_failure,
    "list_execution_logs": _tool_list_execution_logs,
    "get_execution_log": _tool_get_execution_log,
    "cleanup_artifacts": _tool_cleanup_artifacts,
    "preview_workspace_file": _tool_preview_workspace_file,
}


def _parse_json_args(raw: str) -> dict[str, Any]:
    txt = str(raw or "").strip()
    if not txt:
        return {}
    try:
        parsed = json.loads(txt)
    except Exception as exc:
        raise HTTPException(400, f"Invalid tool arguments JSON: {exc}") from exc
    if not isinstance(parsed, dict):
        raise HTTPException(400, "Tool arguments must be an object")
    return parsed


def _execute_tool(name: str, args: dict[str, Any], *, ctx: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    fn = _TOOL_HANDLERS.get(name)
    if not fn:
        tool_ctx = ctx or {}
        if name == "get_app_map":
            return _tool_get_app_map(args, tools=tool_ctx.get("tools") or _tool_specs())
        if name == "list_copilot_memory":
            return _tool_list_copilot_memory(args)
        if name == "list_copilot_skills":
            return _tool_list_copilot_skills(args)
        if name == "remember_lesson":
            return _tool_remember_lesson(args, session_id=str(tool_ctx.get("session_id") or ""))
        if name == "update_skill":
            return _tool_update_skill(args, session_id=str(tool_ctx.get("session_id") or ""))
        if name == "refresh_copilot_familiarity":
            return _tool_refresh_copilot_familiarity(args, tools=tool_ctx.get("tools") or _tool_specs())
        if name == "distill_successful_run_skills":
            return _tool_distill_successful_run_skills(args)
        if name == "spawn_sub_agent":
            return _tool_spawn_sub_agent(
                args,
                model=str(tool_ctx.get("model") or _DEFAULT_MODEL),
                provider=str(tool_ctx.get("provider") or "openai"),
                session_id=str(tool_ctx.get("session_id") or ""),
            )
        raise HTTPException(400, f"Unknown tool '{name}'")
    return fn(args)


def _canonical_model_id(model: str) -> str:
    raw = str(model or "").strip()
    if not raw:
        return raw
    return _MODEL_ALIASES.get(raw.lower(), raw)


def _assistant_model_provider(model: str) -> str:
    m = (model or "").lower()
    if m.startswith("gpt") or m.startswith("o"):
        return "openai"
    if m.startswith("grok"):
        return "grok"
    if m.startswith("gemini"):
        return "gemini"
    if m.startswith("claude"):
        return "anthropic"
    if m.startswith("mistral"):
        return "mistral"
    return "openai"


def _resolve_provider_key(provider: str) -> str:
    if provider == "openai":
        return os.environ.get("OPENAI_API_KEY", "")
    if provider == "grok":
        return (
            os.environ.get("GROK_API_KEY")
            or os.environ.get("XAI_API_KEY")
            or os.environ.get("xAi_API")
            or os.environ.get("XAI_API")
            or ""
        )
    if provider == "gemini":
        return os.environ.get("GEMINI_API_KEY", "")
    if provider == "anthropic":
        return os.environ.get("ANTHROPIC_API_KEY", "")
    if provider == "mistral":
        return os.environ.get("MISTRAL_API_KEY", "")
    return ""


def _model_catalog() -> list[dict[str, Any]]:
    raw = os.environ.get("ASSISTANT_MODEL_CATALOG_JSON", "").strip()
    if not raw:
        return list(_DEFAULT_MODEL_CATALOG)
    try:
        parsed = json.loads(raw)
    except Exception:
        return list(_DEFAULT_MODEL_CATALOG)
    if not isinstance(parsed, list):
        return list(_DEFAULT_MODEL_CATALOG)

    out: list[dict[str, Any]] = []
    for row in parsed:
        if not isinstance(row, dict):
            continue
        model_id = str(row.get("id") or "").strip()
        if not model_id:
            continue
        provider = str(row.get("provider") or _assistant_model_provider(model_id)).strip().lower()
        if provider not in {"openai", "anthropic", "gemini", "grok", "mistral"}:
            provider = _assistant_model_provider(model_id)
        out.append(
            {
                "id": model_id,
                "label": str(row.get("label") or model_id),
                "provider": provider,
                "description": str(row.get("description") or ""),
            }
        )
    return out or list(_DEFAULT_MODEL_CATALOG)


def _compact_json(payload: Any, cap: int = 12000) -> str:
    try:
        txt = json.dumps(payload, ensure_ascii=False, indent=2)
    except Exception:
        txt = str(payload)
    if len(txt) <= cap:
        return txt
    return txt[:cap] + "\n... [truncated]"


def _build_dynamic_system_prompt(user_message: str, tools: list[dict[str, Any]]) -> str:
    assistant_knowledge.ensure_app_map(tools, force=False)
    pack = assistant_knowledge.context_pack(user_message, memory_limit=10, skills_limit=10)
    app_map = pack.get("app_map") if isinstance(pack.get("app_map"), dict) else {}
    summary = app_map.get("summary") if isinstance(app_map.get("summary"), dict) else {}
    app_map_snippet = {
        "tools": (app_map.get("tools") or [])[:40] if isinstance(app_map.get("tools"), list) else [],
        "agents": (app_map.get("agents") or [])[:60] if isinstance(app_map.get("agents"), list) else [],
        "pipelines": (app_map.get("pipelines") or [])[:40] if isinstance(app_map.get("pipelines"), list) else [],
    }
    skill_count = len(pack.get("skills") or [])
    memory_count = len(pack.get("memory") or [])

    return (
        f"{SYSTEM_PROMPT}\n"
        "\n"
        "Autogenerated operating context (live app + learned knowledge):\n"
        f"- app_map_generated_at: {str(app_map.get('generated_at') or '')}\n"
        f"- agent_count: {summary.get('agent_count', 0)}\n"
        f"- pipeline_count: {summary.get('pipeline_count', 0)}\n"
        f"- run_count: {summary.get('run_count', 0)}\n"
        f"- retrieved_skill_entries: {skill_count}\n"
        f"- retrieved_memory_entries: {memory_count}\n"
        "\n"
        "When user asks for pipeline design/debugging, combine tool facts with learned skills/memory.\n"
        "Treat crm_pair/crm_call and pipeline run data as first-class context for recommendations.\n"
        "When user provides correction, update memory/skills so future answers improve.\n"
        "Prefer spawning a sub-agent when task decomposition or second-opinion reasoning helps.\n"
        "\n"
        "APP_MAP_SNIPPET:\n"
        f"{_compact_json(app_map_snippet, cap=14000)}\n"
        "\n"
        "RETRIEVED_SKILLS:\n"
        f"{_compact_json(pack.get('skills') or [], cap=10000)}\n"
        "\n"
        "RETRIEVED_MEMORY:\n"
        f"{_compact_json(pack.get('memory') or [], cap=10000)}\n"
    )


def _looks_like_correction(text: str) -> bool:
    msg = str(text or "").strip().lower()
    if not msg:
        return False
    if any(k in msg for k in _CORRECTION_HINTS):
        return True
    # "no, ..." / "this is wrong" / "not correct"
    return bool(re.match(r"^(no|nah|not really|this is wrong|that is wrong)\b", msg))


def _latest_assistant_display_message(session: dict[str, Any]) -> str:
    rows = session.get("messages")
    if not isinstance(rows, list):
        return ""
    for row in reversed(rows):
        if not isinstance(row, dict):
            continue
        if str(row.get("role") or "") == "assistant":
            return str(row.get("content") or "")
    return ""


def _auto_capture_correction(session: dict[str, Any], user_message: str) -> None:
    if not _looks_like_correction(user_message):
        return
    prev_assistant = _latest_assistant_display_message(session)
    if not prev_assistant:
        return
    assistant_knowledge.add_memory(
        kind="correction",
        source="user_feedback",
        confidence=0.85,
        tags=["correction", "pipeline", "debugging"],
        text=(
            "User indicated prior answer/tool plan was wrong.\n"
            f"Previous assistant answer:\n{prev_assistant}\n\n"
            f"User correction/request:\n{user_message}"
        ),
        meta={
            "session_id": str(session.get("id") or ""),
        },
    )
    assistant_knowledge.upsert_skill(
        name="Correction-driven pipeline refinement",
        guidance=(
            "When a user says the proposed pipeline/debugging answer was wrong, first summarize the mismatch, "
            "re-check live pipeline/run evidence via tools, then produce a corrected design with explicit assumptions."
        ),
        source="user_feedback",
        confidence=0.8,
        tags=["correction", "pipeline", "debugging"],
        meta={"session_id": str(session.get("id") or "")},
    )


def _chunk_text(text: str, size: int = 160) -> list[str]:
    txt = str(text or "")
    if not txt:
        return []
    return [txt[i:i + size] for i in range(0, len(txt), size)]


def _serialize_tool_call(tool_call: Any) -> dict[str, Any]:
    if isinstance(tool_call, dict):
        fn_raw = tool_call.get("function") if isinstance(tool_call.get("function"), dict) else {}
        return {
            "id": str(tool_call.get("id") or str(uuid.uuid4())),
            "type": "function",
            "function": {
                "name": str(fn_raw.get("name") or ""),
                "arguments": str(fn_raw.get("arguments") or "{}"),
            },
        }
    fn = getattr(tool_call, "function", None)
    return {
        "id": str(getattr(tool_call, "id", "") or str(uuid.uuid4())),
        "type": "function",
        "function": {
            "name": str(getattr(fn, "name", "") or ""),
            "arguments": str(getattr(fn, "arguments", "") or "{}"),
        },
    }


def _message_content_text(message: Any) -> str:
    content = getattr(message, "content", "")
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, dict):
                parts.append(str(item.get("text") or ""))
            else:
                parts.append(str(item))
        return "\n".join(p for p in parts if p).strip()
    return str(content)


def _recent_tool_evidence(model_messages: list[dict[str, Any]], *, max_items: int = 10, max_chars: int = 12000) -> str:
    rows: list[str] = []
    for msg in reversed(model_messages):
        if not isinstance(msg, dict):
            continue
        role = str(msg.get("role") or "")
        if role == "tool":
            content = str(msg.get("content") or "").strip()
            if not content:
                continue
            tc_id = str(msg.get("tool_call_id") or "")
            label = f"tool_result({tc_id})" if tc_id else "tool_result"
            rows.append(f"{label}:\n{content[:1800]}")
        elif role == "assistant":
            tcs = msg.get("tool_calls")
            if not isinstance(tcs, list) or not tcs:
                continue
            names: list[str] = []
            for tc in tcs[:8]:
                if not isinstance(tc, dict):
                    continue
                fn = tc.get("function") if isinstance(tc.get("function"), dict) else {}
                name = str(fn.get("name") or "").strip()
                if name:
                    names.append(name)
            if names:
                rows.append(f"tool_calls: {', '.join(names)}")
        if len(rows) >= max_items:
            break
    rows.reverse()
    blob = "\n\n".join(rows)
    return blob[:max_chars]


def _planner_critic_refine(
    *,
    client: LLMClient,
    model: str,
    user_message: str,
    draft: str,
    dynamic_system_prompt: str,
    model_messages: list[dict[str, Any]],
) -> tuple[str, dict[str, Any]]:
    original = str(draft or "").strip()
    if not original:
        return original, {"enabled": _PLANNER_CRITIC_ENABLED, "used": False, "reason": "empty_draft"}
    if not _PLANNER_CRITIC_ENABLED:
        return original, {"enabled": False, "used": False, "reason": "disabled"}

    evidence = _recent_tool_evidence(model_messages)
    critic_system = (
        f"{dynamic_system_prompt}\n"
        "\n"
        "You are the Planner+Critic final quality pass.\n"
        "- Critique the draft internally, then output only the improved final answer.\n"
        "- Keep claims grounded in available tool evidence and avoid unsupported certainty.\n"
        "- Prioritize actionable next steps and explicit assumptions where needed.\n"
        "- Keep the tone concise and practical.\n"
    )
    critic_user = (
        f"ORIGINAL_USER_REQUEST:\n{user_message}\n\n"
        f"DRAFT_RESPONSE:\n{original}\n\n"
        "RECENT_TOOL_EVIDENCE:\n"
        f"{evidence or '(no tool evidence captured for this turn)'}\n\n"
        "Return the best final response only."
    )
    resp = client.chat_completion(
        model=model,
        messages=[
            {"role": "system", "content": critic_system},
            {"role": "user", "content": critic_user},
        ],
        temperature=0,
        max_tokens=max(1024, min(_DEFAULT_MAX_TOKENS, _PLANNER_CRITIC_MAX_TOKENS)),
        thinking=True,
    )
    improved = _message_content_text(resp.choices[0].message).strip()
    if not improved:
        return original, {"enabled": True, "used": False, "reason": "empty_critic_output"}
    return improved, {
        "enabled": True,
        "used": True,
        "draft_chars": len(original),
        "final_chars": len(improved),
        "tool_evidence_chars": len(evidence),
    }


@router.get("/tools")
def list_tools():
    return [
        {
            "name": t["function"]["name"],
            "description": t["function"].get("description", ""),
        }
        for t in _tool_specs()
    ]


@router.get("/models")
def list_models():
    rows = []
    for row in _model_catalog():
        provider = str(row.get("provider") or _assistant_model_provider(str(row.get("id") or ""))).lower()
        rows.append(
            {
                "id": str(row.get("id") or ""),
                "label": str(row.get("label") or row.get("id") or ""),
                "provider": provider,
                "description": str(row.get("description") or ""),
                "ready": bool(_resolve_provider_key(provider)),
                "supports_tools": provider in _SUPPORTED_ORCHESTRATION_PROVIDERS,
            }
        )
    return rows


@router.get("/sessions")
def list_sessions(limit: int = 100):
    cap = max(1, min(500, int(limit)))
    out: list[dict[str, Any]] = []
    files = sorted(_SESSION_DIR.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)

    for path in files[:cap]:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        if not isinstance(data, dict):
            continue
        messages = data.get("messages") if isinstance(data.get("messages"), list) else []
        last_msg = ""
        if messages:
            try:
                last_msg = str(messages[-1].get("content") or "")[:180]
            except Exception:
                last_msg = ""
        out.append(
            {
                "id": data.get("id", path.stem),
                "title": data.get("title", "New Copilot Chat"),
                "created_at": data.get("created_at", ""),
                "updated_at": data.get("updated_at", ""),
                "message_count": len(messages),
                "last_message": last_msg,
            }
        )
    return out


@router.post("/sessions")
def create_session(req: SessionCreateIn):
    session = _default_session(req.title)
    _save_session(session)
    return session


@router.get("/sessions/{session_id}")
def get_session(session_id: str):
    session = _load_session(session_id)
    return {
        "id": session.get("id"),
        "title": session.get("title"),
        "created_at": session.get("created_at"),
        "updated_at": session.get("updated_at"),
        "messages": session.get("messages", []),
    }


@router.delete("/sessions/{session_id}")
def delete_session(session_id: str):
    path = _session_path(session_id)
    if not path.exists():
        raise HTTPException(404, "Session not found")
    path.unlink()
    return {"deleted": True, "session_id": session_id}


@router.post("/sessions/{session_id}/chat")
async def chat_session(session_id: str, req: ChatRequest):
    session = _load_session(session_id)
    user_message = req.message.strip()
    requested_model = (req.model or _DEFAULT_MODEL).strip() or _DEFAULT_MODEL
    model = _canonical_model_id(requested_model)
    model_alias_applied = requested_model != model

    provider = _assistant_model_provider(model)
    supports_tools = provider in _SUPPORTED_ORCHESTRATION_PROVIDERS

    api_key = _resolve_provider_key(provider)
    if not api_key:
        raise HTTPException(400, f"Missing API key for provider '{provider}'")

    _auto_capture_correction(session, user_message)
    _append_display_message(session, "user", user_message)
    _append_model_message(session, {"role": "user", "content": user_message})
    _save_session(session)

    execution_session_id = execution_logs.start_session(
        action="assistant_chat",
        source="backend",
        context={
            "assistant_session_id": session_id,
            "model": model,
            "requested_model": requested_model,
            "model_alias_applied": model_alias_applied,
            "provider": provider,
            "supports_tools": supports_tools,
            "user_message_chars": len(user_message),
        },
        status="running",
    )
    execution_logs.append_event(
        execution_session_id,
        "Assistant chat started",
        level="stage",
        status="running",
        data={
            "session_id": session_id,
            "model": model,
            "requested_model": requested_model,
            "model_alias_applied": model_alias_applied,
            "provider": provider,
            "supports_tools": supports_tools,
        },
    )

    async def stream():
        tools = _tool_specs()
        familiarity_boot = assistant_knowledge.familiarize_with_live_app(tool_specs=tools, force=False)
        distill_boot = assistant_knowledge.distill_skills_from_successful_runs(limit=120, force=False)
        assistant_knowledge.ensure_app_map(tools, force=False)
        dynamic_system_prompt = _build_dynamic_system_prompt(user_message, tools)
        client = LLMClient(provider=provider, api_key=api_key)

        try:
            yield _sse("execution_session", {"execution_session_id": execution_session_id})
            yield _sse("progress", {"msg": f"Thinking with {model} ({provider}) at max effort…"})
            if model_alias_applied:
                yield _sse(
                    "progress",
                    {
                        "msg": (
                            f"Requested model '{requested_model}' is mapped to '{model}' "
                            "for API compatibility."
                        )
                    },
                )
            if not familiarity_boot.get("skipped"):
                msg = (
                    f"Familiarized with app/CRM snapshot "
                    f"(memory +{int(familiarity_boot.get('updated_memory_entries', 0))}, "
                    f"skills +{int(familiarity_boot.get('updated_skill_entries', 0))})."
                )
                yield _sse("progress", {"msg": msg})
                execution_logs.append_event(
                    execution_session_id,
                    "Copilot familiarization refreshed",
                    level="info",
                    data=familiarity_boot,
                )
            if distill_boot.get("distilled", 0):
                yield _sse(
                    "progress",
                    {"msg": f"Distilled {int(distill_boot.get('distilled', 0))} new skills from successful runs."},
                )
                execution_logs.append_event(
                    execution_session_id,
                    "Copilot run distillation",
                    level="info",
                    data=distill_boot,
                )

            if not supports_tools:
                messages = [{"role": "system", "content": dynamic_system_prompt}] + list(session.get("model_messages") or [])
                resp = client.chat_completion(
                    model=model,
                    messages=messages,
                    temperature=0,
                    max_tokens=_DEFAULT_MAX_TOKENS,
                    thinking=True,
                )
                draft_text = _message_content_text(resp.choices[0].message).strip()
                if not draft_text:
                    draft_text = "I couldn't produce a response. Please try again with more detail."
                yield _sse("progress", {"msg": "Running planner + critic quality pass…"})
                try:
                    final_text, reviewer_meta = _planner_critic_refine(
                        client=client,
                        model=model,
                        user_message=user_message,
                        draft=draft_text,
                        dynamic_system_prompt=dynamic_system_prompt,
                        model_messages=list(session.get("model_messages") or []),
                    )
                except Exception as exc:
                    final_text = draft_text
                    reviewer_meta = {
                        "enabled": True,
                        "used": False,
                        "reason": f"critic_error:{exc}",
                    }

                _append_model_message(session, {"role": "assistant", "content": final_text})
                _append_display_message(
                    session,
                    "assistant",
                    final_text,
                    {
                        "provider": provider,
                        "model": model,
                        "tools_used": False,
                        "planner_critic": bool(reviewer_meta.get("used")),
                    },
                )
                _save_session(session)
                for chunk in _chunk_text(final_text):
                    yield _sse("stream", {"text": chunk})
                yield _sse("done", {"content": final_text})
                execution_logs.append_event(
                    execution_session_id,
                    "Planner+Critic pass",
                    level="info",
                    data=reviewer_meta,
                )
                execution_logs.finish_session(
                    execution_session_id,
                    status="success",
                    report={
                        "model": model,
                        "requested_model": requested_model,
                        "model_alias_applied": model_alias_applied,
                        "provider": provider,
                        "assistant_session_id": session_id,
                        "assistant_message_chars": len(final_text),
                        "tools_used": False,
                        "planner_critic_used": bool(reviewer_meta.get("used")),
                    },
                )
                return

            for round_idx in range(req.max_tool_rounds):
                messages = [{"role": "system", "content": dynamic_system_prompt}] + list(session.get("model_messages") or [])
                resp = client.chat_completion(
                    model=model,
                    messages=messages,
                    temperature=0,
                    max_tokens=_DEFAULT_MAX_TOKENS,
                    thinking=True,
                    tools=tools,
                    tool_choice="auto",
                )
                message = resp.choices[0].message
                text = _message_content_text(message)
                raw_tool_calls = getattr(message, "tool_calls", None) or []

                if raw_tool_calls:
                    tool_calls = [_serialize_tool_call(tc) for tc in raw_tool_calls]
                    _append_model_message(
                        session,
                        {
                            "role": "assistant",
                            "content": text,
                            "tool_calls": tool_calls,
                        },
                    )
                    _save_session(session)

                    for tc in tool_calls:
                        fn = tc.get("function") or {}
                        name = str(fn.get("name") or "")
                        args_raw = str(fn.get("arguments") or "{}")
                        tc_id = str(tc.get("id") or str(uuid.uuid4()))

                        yield _sse("tool_call", {"name": name, "arguments": args_raw})
                        execution_logs.append_event(
                            execution_session_id,
                            f"Tool call: {name}",
                            level="info",
                            data={"tool": name, "arguments": args_raw},
                        )
                        log_buffer.emit(f"[ASSISTANT] tool_call {name}")

                        try:
                            parsed_args = _parse_json_args(args_raw)
                            tool_result = await asyncio.to_thread(
                                _execute_tool,
                                name,
                                parsed_args,
                                ctx={
                                    "session_id": session_id,
                                    "model": model,
                                    "provider": provider,
                                    "tools": tools,
                                },
                            )
                            ok = True
                        except HTTPException as exc:
                            tool_result = {"ok": False, "error": str(exc.detail)}
                            ok = False
                        except Exception as exc:
                            tool_result = {"ok": False, "error": str(exc)}
                            ok = False

                        tool_result_text = json.dumps(tool_result, ensure_ascii=False)
                        _append_model_message(
                            session,
                            {
                                "role": "tool",
                                "tool_call_id": tc_id,
                                "content": tool_result_text,
                            },
                        )

                        _append_display_message(
                            session,
                            "tool",
                            f"{name}: {'ok' if ok else 'error'}",
                            {
                                "tool": name,
                                "ok": ok,
                            },
                        )
                        _save_session(session)

                        yield _sse(
                            "tool_result",
                            {
                                "name": name,
                                "ok": ok,
                                "preview": (tool_result_text[:1200] + "…") if len(tool_result_text) > 1200 else tool_result_text,
                            },
                        )
                        execution_logs.append_event(
                            execution_session_id,
                            f"Tool result: {name}",
                            level="info" if ok else "error",
                            data={"tool": name, "ok": ok},
                            error="" if ok else str(tool_result.get("error") or ""),
                        )

                    yield _sse("progress", {"msg": f"Continuing after tools (round {round_idx + 1})…"})
                    continue

                draft_text = text.strip()
                if not draft_text:
                    draft_text = "I couldn't produce a response. Please try again with more detail."
                yield _sse("progress", {"msg": "Running planner + critic quality pass…"})
                try:
                    final_text, reviewer_meta = _planner_critic_refine(
                        client=client,
                        model=model,
                        user_message=user_message,
                        draft=draft_text,
                        dynamic_system_prompt=dynamic_system_prompt,
                        model_messages=list(session.get("model_messages") or []),
                    )
                except Exception as exc:
                    final_text = draft_text
                    reviewer_meta = {
                        "enabled": True,
                        "used": False,
                        "reason": f"critic_error:{exc}",
                    }

                _append_model_message(session, {"role": "assistant", "content": final_text})
                _append_display_message(
                    session,
                    "assistant",
                    final_text,
                    {
                        "provider": provider,
                        "model": model,
                        "tools_used": True,
                        "planner_critic": bool(reviewer_meta.get("used")),
                    },
                )
                _save_session(session)

                for chunk in _chunk_text(final_text):
                    yield _sse("stream", {"text": chunk})
                yield _sse("done", {"content": final_text})
                execution_logs.append_event(
                    execution_session_id,
                    "Planner+Critic pass",
                    level="info",
                    data=reviewer_meta,
                )

                execution_logs.finish_session(
                    execution_session_id,
                    status="success",
                    report={
                        "model": model,
                        "requested_model": requested_model,
                        "model_alias_applied": model_alias_applied,
                        "provider": provider,
                        "assistant_session_id": session_id,
                        "assistant_message_chars": len(final_text),
                        "tools_used": True,
                        "planner_critic_used": bool(reviewer_meta.get("used")),
                    },
                )
                log_buffer.emit(f"[ASSISTANT] done ({len(final_text):,} chars)")
                return

            raise RuntimeError("Reached max tool rounds without final answer")

        except Exception as exc:
            err = str(exc)
            execution_logs.finish_session(
                execution_session_id,
                status="failed",
                error=err,
                report={
                    "model": model,
                    "requested_model": requested_model,
                    "model_alias_applied": model_alias_applied,
                    "assistant_session_id": session_id,
                },
            )
            log_buffer.emit(f"[ASSISTANT] error: {err}")
            yield _sse("error", {"msg": err})

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
