# Shinobi V3 — Shared Agent Conventions

> Single source of truth for all LLM agents working in this repo.
> Referenced by `CLAUDE.md` (Claude Code), `AGENTS.md` (Codex + future agents), and `.claude/CLAUDE.md`.

---

## Project Overview

Sales intelligence platform for a trading/finance CRM operation.

- Ingests call recordings via CRM webhooks (brtcrm.io, mlbcrm.io, sfxcrm.io)
- Transcribes audio (ElevenLabs Scribe v2)
- Runs AI pipelines (chains of LLM agents) on transcripts
- Generates notes, persona profiles, compliance scores
- Pushes results back to CRM

---

## Stack

| Layer | Technology |
|---|---|
| Backend | FastAPI + SQLModel + Pydantic Settings (Python, port 8000) |
| Frontend | Next.js 14 App Router, Tailwind, SWR, Radix UI, @xyflow/react (port 3000) |
| DB local | SQLite `ui/data/app.db` |
| DB prod | PostgreSQL via `DATABASE_URL` |
| LLMs | OpenAI (primary), Anthropic, Google Gemini, xAI/Grok |
| Transcription | ElevenLabs Scribe v2 |
| Audio helpers | librosa, soundfile, scipy |
| Infra | GCP e2-standard-4, IAP SSH |
| Dev domain | shinobi.aleph-infinity.com |
| Prod domain | shinobi.prod.aleph-infinity.com |

---

## Agents in This Repo

| Agent | Tool | Primary strengths |
|---|---|---|
| **Claude** | Claude Code (Anthropic CLI) | Backend logic, multi-file refactors, architecture, pipeline/live UI |
| **Codex** | OpenAI Codex CLI | Focused edits, deploy scripts, endpoint work, code review, boilerplate |
| *(future)* | — | Add here when onboarded |

---

## File Ownership

Ownership means: you resolve conflicts. Both agents may **read** anything.

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

### Shared — acquire lock before writing
- `ui/backend/database.py`
- `ui/backend/models/pipeline_run.py`
- `ui/backend/main.py`
- `ui/frontend/package.json`

---

## Rules of Engagement

### Never edit the same file simultaneously
Use MCP `lock_acquire` / `lock_release` before touching any file, especially shared ones. Locks auto-expire after 300s on crash.

```
lock_acquire({ resource: "path/to/file", reason: "why" })
# ... do work ...
lock_release({ resource: "path/to/file" })
```

### Prefer different concerns
- Claude → complex multi-file logic, architecture decisions, pipeline/canvas UI
- Codex → focused single-file edits, tests, deploy scripts, review of Claude's output
- Future agents → assign a lane here when onboarded

### Use git worktrees for true parallel work
When two agents need simultaneous isolation:
```bash
git worktree add .trees/agent-name-feature -b agent-name/feature
```
Worktrees go in `.trees/` which is gitignored.

### Always check before editing
```
bootstrap({ name: "claude|codex" })   # see what the other agent is doing
coordination_status()                  # full picture: locks, tasks, recent events
```

---

## MCP Coordination (summary)

Full tool reference is in `AGENTS.md`. Quick cheat-sheet:

| Action | Tool |
|---|---|
| Session start | `bootstrap({ name: "..." })` |
| Grab a file | `lock_acquire({ resource, reason })` |
| Release a file | `lock_release({ resource })` |
| See full state | `coordination_status()` |
| Create task for other agent | `task_create({ title, description })` |
| Complete a task | `task_complete({ task_id, output })` |
| Share a note | `memory_set({ key, value, namespace })` |

Human-judgment items (deploy to prod, unresolved conflicts, questions for Adam) go in `llm_talk.txt`.

---

## Version Bump — Required Before Every Commit

```bash
# 1. ui/frontend/lib/version.ts   → bump VERSION string
# 2. ui/frontend/package.json     → bump "version" field (same number)
```

Always bump both. Always include in the same commit as the change.

---

## Before Every Frontend Commit

```bash
cd ui/frontend && npx tsc --noEmit
```

Fix all type errors before committing.

---

## Deploy Sequence

```bash
bash deploy/deploy-dev.sh    # dev VM — always first
# wait for Adam to approve
bash deploy/deploy.sh        # prod — only after approval
```

---

## Hard Rules (all agents)

1. Never commit secrets (`.env`, `.env.crm`, API keys)
2. Never skip `tsc --noEmit` before a frontend commit
3. Never push to `main` directly — always dev → approval → prod
4. Always `lock_acquire` shared files before writing
5. Always bump version before committing
6. Always `lock_release` when done

---

## Run Status Values

| Bucket | Values |
|---|---|
| Success | `done`, `completed`, `success`, `ok`, `finished`, `cached` |
| In-flight | `queued`, `running`, `retrying`, `preparing` |
| Failed | any terminal value not in the above two rows |

---

## Project-Specific Conventions (fill in)

### Hebrew / English handling
<!-- Adam to fill in: field names, UTF-8 BOM policy, RTL display notes -->

### CRM patterns
<!-- Adam to fill in: brtcrm / mlbcrm / sfxcrm push format, field mapping, retry logic -->

### GCP deploy notes
<!-- Adam to fill in: IAP SSH command, instance name, startup check -->

### n8n / automation patterns
<!-- Adam to fill in: if/when n8n is used alongside this stack -->

### Data gotchas
- `/api/history/runs?compact=1` strips `steps_json` — only `{agent_name, state, start_time, end_time, note_id, note_call_id}` survive. `note_id` must be preserved (live table uses it for bulk note sending).
