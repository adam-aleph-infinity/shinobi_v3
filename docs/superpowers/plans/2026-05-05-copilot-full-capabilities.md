# Copilot Full-Capability Expansion Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 8 missing tools to the Shinobi Copilot so it can do everything an end user can do — delete agents, list pipeline folders, read/write source files, inspect webhook events, push notes to CRM, and trigger pipeline runs — matching Claude Code's capability level.

**Architecture:** All tool specs and handlers live in `ui/backend/routers/assistant.py`. New tools follow the exact same pattern as existing ones: a `_tool_<name>(args)` function + an entry in `_tool_specs()` + an entry in `_TOOL_HANDLERS`. For `trigger_pipeline_run` we add an internal bypass token (config.py + pipelines.py) so the copilot can call the existing SSE run endpoint without cookie auth.

**Tech Stack:** Python 3.12, FastAPI, SQLModel, httpx (async HTTP), Anthropic tool-call spec format.

---

## File map

| File | Change |
|---|---|
| `ui/backend/routers/assistant.py` | Add 8 tool specs to `_tool_specs()`, 8 handler functions, register in `_TOOL_HANDLERS` |
| `ui/backend/config.py` | Add `copilot_internal_token: str = ""` field |
| `ui/backend/routers/pipelines.py` | Add internal token bypass to `_require_can_run_pipeline` |

---

## Task 1: `delete_universal_agent` + `list_pipeline_folders`

**Files:**
- Modify: `ui/backend/routers/assistant.py`

### Step 1 — Add handler functions

In `assistant.py`, immediately after `_tool_list_agent_folders` (currently around line 2148), insert:

```python
def _tool_delete_universal_agent(args: dict[str, Any]) -> dict[str, Any]:
    agent_id = str(args.get("agent_id") or "").strip()
    if not agent_id:
        raise HTTPException(400, "agent_id is required")
    f, data = universal_agents_router._find_file(agent_id)
    name = str(data.get("name") or agent_id)
    f.unlink()
    return {"ok": True, "deleted": True, "agent_id": agent_id, "name": name}


def _tool_list_pipeline_folders(args: dict[str, Any]) -> dict[str, Any]:
    folders = pipelines_router._load_folders()
    return {"count": len(folders), "folders": folders}
```

### Step 2 — Add tool specs

In `_tool_specs()`, inside the `tools: list[...]` before the `]` that closes the list (around line 930), add after the `list_agent_folders` spec block:

```python
        {
            "type": "function",
            "function": {
                "name": "delete_universal_agent",
                "description": "Permanently delete a universal agent by ID. Always confirm with the user before calling this.",
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
                "name": "list_pipeline_folders",
                "description": "List all existing pipeline folders.",
                "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
            },
        },
```

### Step 3 — Register in `_TOOL_HANDLERS`

In the `_TOOL_HANDLERS` dict (around line 2380), add two entries:

```python
    "delete_universal_agent": _tool_delete_universal_agent,
    "list_pipeline_folders": _tool_list_pipeline_folders,
```

### Step 4 — Smoke test

```bash
cd /Users/adamleeperelman/Documents/AI/shinobi_v3
source .venv/bin/activate
python -c "from ui.backend.routers.assistant import _tool_specs, _TOOL_HANDLERS; names = {t['function']['name'] for t in _tool_specs()}; assert 'delete_universal_agent' in names; assert 'list_pipeline_folders' in names; assert 'delete_universal_agent' in _TOOL_HANDLERS; assert 'list_pipeline_folders' in _TOOL_HANDLERS; print('OK')"
```

Expected: `OK`

### Step 5 — Commit

```bash
git add ui/backend/routers/assistant.py
git commit -m "feat(copilot): add delete_universal_agent and list_pipeline_folders tools"
```

---

## Task 2: Wire `write_source_file` (admin+)

The implementation already exists at line 1752 of `assistant.py`. It just needs a tool spec and a `_TOOL_HANDLERS` entry, gated to admin+ users.

**Files:**
- Modify: `ui/backend/routers/assistant.py`

### Step 1 — Add tool spec

In `_tool_specs()`, in the role-gated block after `if role in _SUPER_ADMIN_ROLES:` (around line 956), add a new gated block for `_ADMIN_ROLES` **before** the super_admin block:

```python
    if role in _ADMIN_ROLES:
        tools.append(
            {
                "type": "function",
                "function": {
                    "name": "write_source_file",
                    "description": (
                        "Write content to any source file in the project with automatic .copilot_bak backup. "
                        "Use relative path from project root, e.g. ui/backend/routers/assistant.py. "
                        "Always read the file first with read_source_file before writing. "
                        "Confirm with the user before writing to backend or frontend source files."
                    ),
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "path": {"type": "string", "description": "Relative path from project root"},
                            "content": {"type": "string", "description": "Full new file content"},
                        },
                        "required": ["path", "content"],
                        "additionalProperties": False,
                    },
                },
            }
        )
```

### Step 2 — Register in `_TOOL_HANDLERS`

In `_TOOL_HANDLERS`, add:

```python
    "write_source_file": _tool_write_source_file,
```

### Step 3 — Smoke test

```bash
python -c "
from ui.backend.routers.assistant import _tool_specs, _TOOL_HANDLERS
names_admin = {t['function']['name'] for t in _tool_specs(user_role='admin')}
names_user = {t['function']['name'] for t in _tool_specs(user_role='')}
assert 'write_source_file' in names_admin, 'missing for admin'
assert 'write_source_file' not in names_user, 'should be hidden for non-admin'
assert 'write_source_file' in _TOOL_HANDLERS, 'missing from TOOL_HANDLERS'
print('OK')
"
```

Expected: `OK`

### Step 4 — Commit

```bash
git add ui/backend/routers/assistant.py
git commit -m "feat(copilot): expose write_source_file tool for admin users"
```

---

## Task 3: Webhook event visibility (`list_webhook_events`, `get_webhook_event`, `list_rejected_webhooks`)

**Files:**
- Modify: `ui/backend/routers/assistant.py`

### Step 1 — Add handler functions

Add after `_tool_list_pipeline_folders` (from Task 1):

```python
def _tool_list_webhook_events(args: dict[str, Any]) -> dict[str, Any]:
    from ui.backend.routers import webhooks as _wh
    limit = max(1, min(100, int(args.get("limit", 20) or 20)))
    inbox = _wh.settings.ui_data_dir / "_webhooks" / "inbox"
    inbox.mkdir(parents=True, exist_ok=True)
    files = sorted(inbox.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)[:limit]
    out: list[dict[str, Any]] = []
    for fp in files:
        try:
            data = json.loads(fp.read_text(encoding="utf-8"))
        except Exception:
            continue
        payload = data.get("payload") if isinstance(data.get("payload"), dict) else {}
        out.append({
            "event_id": str(data.get("event_id") or ""),
            "received_at": str(data.get("received_at") or ""),
            "webhook_type": str(data.get("webhook_type") or ""),
            "call_id": str(payload.get("call_id") or ""),
            "account_id": str(payload.get("account_id") or ""),
            "agent": str(payload.get("agent") or ""),
            "file": fp.name,
        })
    return {"count": len(out), "events": out}


def _tool_get_webhook_event(args: dict[str, Any]) -> dict[str, Any]:
    event_id = str(args.get("event_id") or "").strip()
    filename = str(args.get("filename") or "").strip()
    if not event_id and not filename:
        raise HTTPException(400, "Provide event_id or filename")
    inbox = settings.ui_data_dir / "_webhooks" / "inbox"
    # Try exact filename first, then glob for event_id
    if filename:
        candidate = inbox / filename
        if not candidate.is_file():
            raise HTTPException(404, "Webhook event file not found")
        files = [candidate]
    else:
        files = list(inbox.glob("*.json"))
    for fp in files:
        try:
            data = json.loads(fp.read_text(encoding="utf-8"))
        except Exception:
            continue
        if event_id and str(data.get("event_id") or "") != event_id:
            continue
        return {"ok": True, "file": fp.name, "event": data}
    raise HTTPException(404, "Webhook event not found")


def _tool_list_rejected_webhooks(args: dict[str, Any]) -> dict[str, Any]:
    limit = max(1, min(200, int(args.get("limit", 20) or 20)))
    rejections_file = settings.ui_data_dir / "_webhooks" / "rejections.json"
    if not rejections_file.exists():
        return {"count": 0, "rejections": []}
    try:
        raw = json.loads(rejections_file.read_text(encoding="utf-8"))
        items = raw.get("items") if isinstance(raw, dict) else raw
        if not isinstance(items, list):
            items = []
    except Exception:
        return {"count": 0, "rejections": []}
    # Sort newest first
    items = sorted(items, key=lambda x: str(x.get("received_at") or ""), reverse=True)[:limit]
    out = []
    for r in items:
        out.append({
            "id": str(r.get("id") or r.get("rejection_id") or ""),
            "received_at": str(r.get("received_at") or ""),
            "reason": str(r.get("reason") or ""),
            "message": str(r.get("message") or ""),
            "call_id": str(r.get("call_id") or ""),
            "webhook_type": str(r.get("webhook_type") or ""),
        })
    return {"count": len(out), "rejections": out}
```

### Step 2 — Add tool specs

In `_tool_specs()` tools list before the closing `]`, add:

```python
        {
            "type": "function",
            "function": {
                "name": "list_webhook_events",
                "description": (
                    "List recent webhook ingestion events received by this server (call-ended payloads from CRM). "
                    "Use to track what calls have been received and when."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "limit": {"type": "integer", "minimum": 1, "maximum": 100, "default": 20},
                    },
                    "additionalProperties": False,
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "get_webhook_event",
                "description": "Get the full payload of a specific webhook event by event_id or filename.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "event_id": {"type": "string", "default": ""},
                        "filename": {"type": "string", "default": "", "description": "Filename as returned by list_webhook_events"},
                    },
                    "additionalProperties": False,
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "list_rejected_webhooks",
                "description": (
                    "List webhooks that were rejected or failed to process. "
                    "Use to diagnose why a call didn't trigger a pipeline run."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "limit": {"type": "integer", "minimum": 1, "maximum": 200, "default": 20},
                    },
                    "additionalProperties": False,
                },
            },
        },
```

### Step 3 — Register in `_TOOL_HANDLERS`

```python
    "list_webhook_events": _tool_list_webhook_events,
    "get_webhook_event": _tool_get_webhook_event,
    "list_rejected_webhooks": _tool_list_rejected_webhooks,
```

### Step 4 — Smoke test

```bash
python -c "
from ui.backend.routers.assistant import _tool_specs, _TOOL_HANDLERS
names = {t['function']['name'] for t in _tool_specs()}
for n in ('list_webhook_events', 'get_webhook_event', 'list_rejected_webhooks'):
    assert n in names, f'missing spec: {n}'
    assert n in _TOOL_HANDLERS, f'missing handler: {n}'
print('OK')
"
```

Expected: `OK`

### Step 5 — Commit

```bash
git add ui/backend/routers/assistant.py
git commit -m "feat(copilot): add webhook event visibility tools"
```

---

## Task 4: `push_note_to_crm`

**Files:**
- Modify: `ui/backend/routers/assistant.py`

### Step 1 — Add handler function

Add after `_tool_create_note` (currently around line 2103):

```python
def _tool_push_note_to_crm(args: dict[str, Any]) -> dict[str, Any]:
    from ui.backend.routers.notes import send_note_to_crm_internal as _push
    note_id = str(args.get("note_id") or "").strip()
    account_id = str(args.get("account_id") or "").strip()
    run_id = str(args.get("run_id") or "").strip()
    if not note_id:
        raise HTTPException(400, "note_id is required")
    with Session(engine) as db:
        result = _push(note_id=note_id, account_id=account_id, run_id=run_id, db=db)
    return {"ok": True, "note_id": note_id, "result": result}
```

### Step 2 — Add tool spec

In `_tool_specs()` tools list:

```python
        {
            "type": "function",
            "function": {
                "name": "push_note_to_crm",
                "description": (
                    "Push an existing note (by note_id) to the CRM. "
                    "Use list_notes to find the note_id first. "
                    "Requires CRM_PUSH_ENABLED=true in server config. "
                    "Always confirm with the user before pushing."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "note_id": {"type": "string", "description": "UUID of the note to push"},
                        "account_id": {"type": "string", "default": "", "description": "CRM account_id; auto-resolved from agent+customer if omitted"},
                        "run_id": {"type": "string", "default": "", "description": "Optional pipeline run_id to associate with this push"},
                    },
                    "required": ["note_id"],
                    "additionalProperties": False,
                },
            },
        },
```

### Step 3 — Register in `_TOOL_HANDLERS`

```python
    "push_note_to_crm": _tool_push_note_to_crm,
```

### Step 4 — Smoke test

```bash
python -c "
from ui.backend.routers.assistant import _tool_specs, _TOOL_HANDLERS
names = {t['function']['name'] for t in _tool_specs()}
assert 'push_note_to_crm' in names
assert 'push_note_to_crm' in _TOOL_HANDLERS
print('OK')
"
```

Expected: `OK`

### Step 5 — Commit

```bash
git add ui/backend/routers/assistant.py
git commit -m "feat(copilot): add push_note_to_crm tool"
```

---

## Task 5: `trigger_pipeline_run` (internal token bypass)

This is the most involved task. It requires:
1. Adding `copilot_internal_token` to settings
2. Adding an internal bypass in `_require_can_run_pipeline`
3. Adding an async `_tool_trigger_pipeline_run` to assistant.py
4. Registering it in `_TOOL_HANDLERS`

The tool makes an `httpx` async streaming POST to the local pipeline run endpoint, reads SSE events until it sees `pipeline_start` (which contains `run_id`), then returns immediately. The pipeline continues executing in the background on the server.

**Files:**
- Modify: `ui/backend/config.py`
- Modify: `ui/backend/routers/pipelines.py`
- Modify: `ui/backend/routers/assistant.py`

### Step 1 — Add config field

In `ui/backend/config.py`, after `dev_sync_auth_token: str = ""`, add:

```python
    copilot_internal_token: str = ""   # set COPILOT_INTERNAL_TOKEN in .env to enable trigger_pipeline_run
```

### Step 2 — Add bypass to `_require_can_run_pipeline` in `pipelines.py`

The function currently lives at lines 78-79 of `ui/backend/routers/pipelines.py`:

```python
def _require_can_run_pipeline(request: Request) -> dict[str, Any]:
    return user_profiles.require_permission(request, "can_run_pipelines")
```

Replace with:

```python
def _require_can_run_pipeline(request: Request) -> dict[str, Any]:
    token = request.headers.get("x-copilot-token", "")
    if token and settings.copilot_internal_token and token == settings.copilot_internal_token:
        return {
            "email": "copilot@internal",
            "name": "Copilot",
            "is_admin": True,
            "permissions": {
                "can_view": True,
                "can_run_pipelines": True,
                "can_edit_pipelines": True,
                "can_create_pipelines": True,
                "can_manage_jobs": True,
                "can_manage_live_jobs": True,
                "can_manage_users": False,
            },
        }
    return user_profiles.require_permission(request, "can_run_pipelines")
```

### Step 3 — Add async handler function in `assistant.py`

Add `import httpx` to the imports at the top of `assistant.py` (after the existing imports, but only inside the function to keep it lazy — see below).

Add after `_tool_push_note_to_crm`:

```python
async def _tool_trigger_pipeline_run(args: dict[str, Any]) -> dict[str, Any]:
    import httpx as _httpx

    pipeline_id = str(args.get("pipeline_id") or "").strip()
    if not pipeline_id:
        raise HTTPException(400, "pipeline_id is required")

    # Validate pipeline exists before attempting HTTP call
    _, pdef = pipelines_router._find_file(pipeline_id)

    token = settings.copilot_internal_token
    if not token:
        raise HTTPException(
            400,
            "COPILOT_INTERNAL_TOKEN is not configured. "
            "Set it in .env to enable trigger_pipeline_run. "
            "Alternatively use run_shell_command (super_admin) to trigger a run manually."
        )

    body = {
        "sales_agent": str(args.get("sales_agent") or ""),
        "customer": str(args.get("customer") or ""),
        "call_id": str(args.get("call_id") or ""),
        "run_origin": "webhook",  # skip pipeline lock acquisition
        "force": bool(args.get("force", False)),
    }

    base_url = settings.crm_webhook_internal_base_url.rstrip("/")
    url = f"{base_url}/pipelines/{pipeline_id}/run"
    run_id: str = ""

    try:
        async with _httpx.AsyncClient(timeout=15.0) as client:
            async with client.stream(
                "POST",
                url,
                json=body,
                headers={"x-copilot-token": token},
            ) as resp:
                if resp.status_code != 200:
                    body_text = await resp.aread()
                    raise HTTPException(
                        resp.status_code,
                        f"Pipeline run endpoint returned {resp.status_code}: {body_text[:500]}",
                    )
                async for line in resp.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    try:
                        event = json.loads(line[5:].strip())
                    except Exception:
                        continue
                    event_data = event.get("data") or {}
                    candidate = str(event_data.get("run_id") or "")
                    if candidate:
                        run_id = candidate
                        break
                    # Stop after pipeline_start or on error; don't consume the whole stream
                    if event.get("type") in {"pipeline_start", "pipeline_error", "error"}:
                        break
    except _httpx.RequestError as exc:
        raise HTTPException(500, f"Could not reach pipeline run endpoint: {exc}") from exc

    if not run_id:
        raise HTTPException(500, "Pipeline run started but run_id was not returned in the first SSE events")

    return {
        "ok": True,
        "run_id": run_id,
        "pipeline_id": pipeline_id,
        "pipeline_name": str(pdef.get("name") or pipeline_id),
        "sales_agent": body["sales_agent"],
        "customer": body["customer"],
        "call_id": body["call_id"],
        "message": f"Pipeline started. Use get_run('{run_id}') to check progress.",
    }
```

### Step 4 — Add tool spec

In `_tool_specs()` tools list:

```python
        {
            "type": "function",
            "function": {
                "name": "trigger_pipeline_run",
                "description": (
                    "Trigger a pipeline to run for a specific agent/customer/call. "
                    "Returns immediately with a run_id; the pipeline executes in the background. "
                    "Use get_run(run_id) to check progress. "
                    "Requires COPILOT_INTERNAL_TOKEN to be set in .env. "
                    "Always confirm with the user before triggering a run."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "pipeline_id": {"type": "string"},
                        "sales_agent": {"type": "string", "default": "", "description": "Sales agent name"},
                        "customer": {"type": "string", "default": "", "description": "Customer name"},
                        "call_id": {"type": "string", "default": "", "description": "Call ID"},
                        "force": {"type": "boolean", "default": False, "description": "Bypass step cache and re-run all steps"},
                    },
                    "required": ["pipeline_id"],
                    "additionalProperties": False,
                },
            },
        },
```

### Step 5 — Register in `_execute_tool` (not `_TOOL_HANDLERS`)

`_tool_trigger_pipeline_run` is `async` — it can't go in `_TOOL_HANDLERS` (which holds sync functions). Add it to `_execute_tool` in the `if not fn:` block alongside the other context-sensitive tools:

```python
        if name == "trigger_pipeline_run":
            import asyncio as _asyncio
            return _asyncio.get_event_loop().run_until_complete(
                _tool_trigger_pipeline_run(args)
            )
```

Wait — `_execute_tool` is called from within an async context (the chat endpoint uses `asyncio.to_thread`). Using `run_until_complete` inside a running event loop will fail. Instead, register it as a sync wrapper:

Add a sync wrapper after `_tool_trigger_pipeline_run`:

```python
def _tool_trigger_pipeline_run_sync(args: dict[str, Any]) -> dict[str, Any]:
    import asyncio as _asyncio
    try:
        loop = _asyncio.get_event_loop()
        if loop.is_running():
            # We're inside asyncio.to_thread — create a new loop in this thread
            new_loop = _asyncio.new_event_loop()
            try:
                return new_loop.run_until_complete(_tool_trigger_pipeline_run(args))
            finally:
                new_loop.close()
        return loop.run_until_complete(_tool_trigger_pipeline_run(args))
    except Exception as exc:
        raise exc
```

Then register the sync wrapper in `_TOOL_HANDLERS`:

```python
    "trigger_pipeline_run": _tool_trigger_pipeline_run_sync,
```

### Step 6 — Set token in `.env.example`

In `.env.example`, add a documentation line (look for the end of the file):

```
# Copilot internal token — enables trigger_pipeline_run tool.
# Generate with: python -c "import secrets; print(secrets.token_hex(32))"
COPILOT_INTERNAL_TOKEN=
```

### Step 7 — Smoke test (without a running server)

```bash
python -c "
from ui.backend.config import settings
from ui.backend.routers.assistant import _tool_specs, _TOOL_HANDLERS
names = {t['function']['name'] for t in _tool_specs()}
assert 'trigger_pipeline_run' in names
assert 'trigger_pipeline_run' in _TOOL_HANDLERS
from ui.backend.routers.pipelines import _require_can_run_pipeline
print('imports OK')
"
```

Expected: `imports OK`

### Step 8 — Commit

```bash
git add ui/backend/config.py ui/backend/routers/pipelines.py ui/backend/routers/assistant.py .env.example
git commit -m "feat(copilot): add trigger_pipeline_run tool with internal token bypass"
```

---

## Task 6: Version bump + deploy

**Files:**
- Modify: `ui/frontend/lib/version.ts`
- Modify: `ui/frontend/package.json`

### Step 1 — TypeScript check

```bash
cd ui/frontend && npx tsc --noEmit
```

Expected: no errors.

### Step 2 — Bump version

In `ui/frontend/lib/version.ts`, bump the patch version (e.g. `6.2.149` → `6.2.150`).
In `ui/frontend/package.json`, set `"version"` to the same value.

### Step 3 — Final commit

```bash
git add ui/frontend/lib/version.ts ui/frontend/package.json
git commit -m "feat(copilot): full-capability expansion — 8 new tools (v6.2.150)"
```

### Step 4 — Deploy to dev

```bash
bash deploy/deploy-dev.sh
```

### Step 5 — Live verification (after dev deploy)

Open the Copilot dock and verify each tool works:

1. **list_pipeline_folders** → "List all pipeline folders"
2. **delete_universal_agent** → "Show me agent [X] then delete it" (use a test agent)
3. **list_webhook_events** → "Show me recent webhook events"
4. **list_rejected_webhooks** → "Are there any rejected webhooks?"
5. **push_note_to_crm** → (only works if CRM_PUSH_ENABLED=true; verify error message otherwise)
6. **write_source_file** → Login as admin, ask copilot to "read then write a test comment to a small config file"
7. **trigger_pipeline_run** → Set COPILOT_INTERNAL_TOKEN in .env, restart server, ask copilot to trigger a known pipeline

---

## Tool capability summary (after this plan)

| Tool | Available to | Status |
|---|---|---|
| `list_universal_agents` | all | ✅ existing |
| `get_universal_agent` | all | ✅ existing |
| `create_universal_agent` | all | ✅ existing |
| `update_universal_agent` | all | ✅ existing |
| `delete_universal_agent` | all | 🆕 Task 1 |
| `list_agent_folders` | all | ✅ existing |
| `create_agent_folder` | all | ✅ existing |
| `list_pipelines` | all | ✅ existing |
| `get_pipeline` | all | ✅ existing |
| `create_pipeline` | all | ✅ existing |
| `update_pipeline` | all | ✅ existing |
| `delete_pipeline` | all | ✅ existing |
| `search_pipelines` | all | ✅ existing |
| `create_pipeline_folder` | all | ✅ existing |
| `list_pipeline_folders` | all | 🆕 Task 1 |
| `list_recent_runs` | all | ✅ existing |
| `get_run` | all | ✅ existing |
| `get_run_artifact` | all | ✅ existing |
| `analyze_run_failure` | all | ✅ existing |
| `trigger_pipeline_run` | all (needs token) | 🆕 Task 5 |
| `list_webhook_events` | all | 🆕 Task 3 |
| `get_webhook_event` | all | 🆕 Task 3 |
| `list_rejected_webhooks` | all | 🆕 Task 3 |
| `list_notes` | all | ✅ existing |
| `create_note` | all | ✅ existing |
| `push_note_to_crm` | all | 🆕 Task 4 |
| `query_db` | all | ✅ existing |
| `search_crm_context` | all | ✅ existing |
| `set_context_bar` | all | ✅ existing |
| `preview_workspace_file` | all | ✅ existing |
| `read_source_file` | all (currently ungated) | ✅ existing |
| `write_source_file` | admin+ | 🆕 Task 2 |
| `run_shell_command` | super_admin | ✅ existing |
| `list_execution_logs` | all | ✅ existing |
| `get_execution_log` | all | ✅ existing |
| `cleanup_artifacts` | all | ✅ existing |
| `spawn_sub_agent` | all | ✅ existing |
| `get_app_map` | all | ✅ existing |
| `list_copilot_memory` | all | ✅ existing |
| `remember_lesson` | all | ✅ existing |
| `refresh_copilot_familiarity` | all | ✅ existing |
