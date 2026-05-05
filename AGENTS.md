# Shinobi V3 — Multi-Agent Working Agreement

> **Before doing anything else, open and read `CONVENTIONS.md`** — it is the shared source of truth for all agents in this repo (ownership, stack, hard rules, version bump, parallel work rules).
> This file is auto-loaded by Codex CLI at session start. Claude Code loads `.claude/CLAUDE.md`.
> Both files reference the same MCP coordination server.

---

## ⚡ Session Start — Do This First, Every Time

Call the MCP tool **`bootstrap`** with your agent name before anything else:

```
bootstrap({ name: "codex" })       # Codex calls this
bootstrap({ name: "claude" })      # Claude calls this
```

This registers you, shows pending tasks, active locks held by the other agent, and recent decisions. It replaces reading `llm_talk.txt` manually.

Then check what the other agent is doing:
```
coordination_status()
```

If they hold a lock on a file you need → call `lock_check("path/to/file")` to confirm, then post a message to `llm_talk.txt` and wait for Adam to relay.

---

## MCP Coordination Tools

Both agents connect to the same **agent-orchestration MCP server** (SQLite-backed, runs locally). These tools replace the manual `state.json` + `llm_talk.txt` polling pattern.

### Starting work
```
bootstrap({ name: "claude|codex" })          # register + get state
lock_acquire({ resource: "ui/backend/routers/notes.py", reason: "adding bulk endpoint" })
```

### During work
```
task_create({ title: "...", description: "..." })   # create a task for the other agent
memory_set({ key: "last_deploy", value: "v6.2.139", namespace: "context" })
agent_heartbeat({ status: "busy" })                  # optional, for long ops
```

### Finishing work
```
lock_release({ resource: "ui/backend/routers/notes.py" })
task_complete({ task_id: "...", output: "summary of what was done" })
agent_heartbeat({ status: "idle" })
```

### Checking the other agent
```
coordination_status()          # who's active, what's locked, pending tasks
event_list({ limit: 20 })      # recent actions by both agents
agent_list()                   # registered agents + status
memory_get({ key: "...", namespace: "context" })   # read shared notes
```

---

## Agents

| Agent | Tool | Role |
|-------|------|------|
| **Claude** | Claude Code (Anthropic CLI) | Backend logic, live/pipeline UI, bug fixes, architecture |
| **Codex** | OpenAI Codex CLI | Infra ops, deploy scripts, endpoint work, frontend hooks |

---

## File Ownership

Ownership = you resolve conflicts in your files. Both agents may read anything.

### Claude owns
- `ui/backend/routers/history.py`
- `ui/backend/routers/pipelines.py`
- `ui/backend/routers/notes.py`
- `ui/frontend/app/live/page.tsx`
- `ui/frontend/app/pipeline/page.tsx`
- `ui/frontend/lib/version.ts`

### Codex owns
- `ui/backend/routers/webhooks.py`
- `deploy/deploy.sh`, `deploy/deploy-dev.sh`
- `ui/backend/routers/personas.py`
- `ui/frontend/app/settings/page.tsx`

### Shared (acquire lock before writing)
- `ui/backend/database.py`
- `ui/backend/models/pipeline_run.py`
- `ui/backend/main.py`
- `ui/frontend/package.json`

---

## Workflow

```
bootstrap()
→ lock_acquire(files you need)
→ do the work
→ bump version (lib/version.ts + package.json)
→ lock_release()
→ task_complete() or task_create() for the other agent
→ commit → push → deploy-dev → user approves → deploy prod
```

Always run `npx tsc --noEmit` in `ui/frontend` before any frontend commit.

---

## llm_talk.txt

Still used for anything that needs human judgment — production deploy approval, unresolved conflicts, questions for Adam. Append with format:

```
--- AGENT: <Claude|Codex> | <timestamp> ---
<message>
--- END ---
```

MCP memory/tasks handle everything else.

---

## Stack Quick Reference

| | |
|--|--|
| Backend | FastAPI + SQLModel (port 8000) |
| Frontend | Next.js 14 App Router, Tailwind, SWR (port 3000) |
| DB local | SQLite `ui/database/shinobi.db` |
| DB prod | PostgreSQL via `DATABASE_URL` |
| LLMs | OpenAI (primary), Anthropic, Gemini, xAI/Grok |
| Transcription | ElevenLabs Scribe v2 |
| Prod VM | GCP e2-standard-4, IAP SSH |
| Prod domain | shinobi.prod.aleph-infinity.com |
| Dev domain | shinobi.aleph-infinity.com |
| Dev start | `bash dev.sh` |
| Deploy dev | `bash deploy/deploy-dev.sh` |
| Deploy prod | `bash deploy/deploy.sh` |

---

## Hard Rules

1. Never commit secrets (`.env`, `.env.crm`, API keys)
2. Never skip `tsc --noEmit` before a frontend commit
3. Never push to `main` directly — always dev first
4. Always `lock_acquire` shared files before editing
5. Always bump version before committing
6. Always `lock_release` when done — locks auto-expire after 300s if you crash
