"""In-app AI copilot chat with constrained tool access.

The assistant can inspect and operate on workflow data (agents/pipelines/runs/logs)
but cannot modify application source code.
"""
from __future__ import annotations

import json
import os
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlmodel import Session, select

from shared.llm_client import LLMClient
from ui.backend.config import settings
from ui.backend.database import engine
from ui.backend.models.pipeline_run import PipelineRun
from ui.backend.routers import pipelines as pipelines_router
from ui.backend.routers import universal_agents as universal_agents_router
from ui.backend.services import execution_logs, log_buffer

router = APIRouter(prefix="/assistant", tags=["assistant"])

_SESSION_DIR = settings.ui_data_dir / "_assistant_sessions"
_SESSION_DIR.mkdir(parents=True, exist_ok=True)

_TEXT_EXTS = {".json", ".txt", ".md", ".log", ".csv", ".srt"}

_DEFAULT_MODEL = os.environ.get("ASSISTANT_MODEL", "gpt-5.4")
_MAX_MODEL_MESSAGES = 80
_MAX_TOOL_ROUNDS = 12


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
)


class SessionCreateIn(BaseModel):
    title: str = ""


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=40000)
    model: str = ""
    max_tool_rounds: int = Field(default=6, ge=1, le=_MAX_TOOL_ROUNDS)


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


def _tool_specs() -> list[dict[str, Any]]:
    return [
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
    ]


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


def _execute_tool(name: str, args: dict[str, Any]) -> dict[str, Any]:
    fn = _TOOL_HANDLERS.get(name)
    if not fn:
        raise HTTPException(400, f"Unknown tool '{name}'")
    return fn(args)


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


def _chunk_text(text: str, size: int = 160) -> list[str]:
    txt = str(text or "")
    if not txt:
        return []
    return [txt[i:i + size] for i in range(0, len(txt), size)]


def _serialize_tool_call(tool_call: Any) -> dict[str, Any]:
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


@router.get("/tools")
def list_tools():
    return [
        {
            "name": t["function"]["name"],
            "description": t["function"].get("description", ""),
        }
        for t in _tool_specs()
    ]


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
    model = (req.model or _DEFAULT_MODEL).strip() or _DEFAULT_MODEL

    provider = _assistant_model_provider(model)
    if provider != "openai":
        raise HTTPException(
            400,
            (
                f"Assistant tool orchestration currently requires an OpenAI chat model. "
                f"Received model '{model}' (provider={provider})."
            ),
        )

    api_key = _resolve_provider_key(provider)
    if not api_key:
        raise HTTPException(400, f"Missing API key for provider '{provider}'")

    _append_display_message(session, "user", user_message)
    _append_model_message(session, {"role": "user", "content": user_message})
    _save_session(session)

    execution_session_id = execution_logs.start_session(
        action="assistant_chat",
        source="backend",
        context={
            "assistant_session_id": session_id,
            "model": model,
            "user_message_chars": len(user_message),
        },
        status="running",
    )
    execution_logs.append_event(
        execution_session_id,
        "Assistant chat started",
        level="stage",
        status="running",
        data={"session_id": session_id, "model": model},
    )

    async def stream():
        tools = _tool_specs()
        client = LLMClient(provider=provider, api_key=api_key)

        try:
            yield _sse("execution_session", {"execution_session_id": execution_session_id})
            yield _sse("progress", {"msg": f"Thinking with {model}…"})

            for round_idx in range(req.max_tool_rounds):
                messages = [{"role": "system", "content": SYSTEM_PROMPT}] + list(session.get("model_messages") or [])
                resp = client.chat_completion(
                    model=model,
                    messages=messages,
                    temperature=0,
                    max_tokens=8000,
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
                            tool_result = _execute_tool(name, parsed_args)
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

                final_text = text.strip()
                if not final_text:
                    final_text = "I couldn't produce a response. Please try again with more detail."

                _append_model_message(session, {"role": "assistant", "content": final_text})
                _append_display_message(session, "assistant", final_text)
                _save_session(session)

                for chunk in _chunk_text(final_text):
                    yield _sse("stream", {"text": chunk})
                yield _sse("done", {"content": final_text})

                execution_logs.finish_session(
                    execution_session_id,
                    status="success",
                    report={
                        "model": model,
                        "assistant_session_id": session_id,
                        "assistant_message_chars": len(final_text),
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
