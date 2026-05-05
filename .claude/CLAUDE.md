# Shinobi V3 — Claude Code Session Context

> Auto-loaded at session start. Keep this current. Detailed coordination rules are in AGENTS.md.

## ⚡ Do This First, Every Session

Before reading the task or touching any file, call the MCP tool:

```
bootstrap({ name: "claude" })
```

This registers me, shows what Codex is currently doing, any locks it holds, and pending tasks left for me. Replaces manually reading `llm_talk.txt` and `state.json`.

Then before editing any file:
```
lock_acquire({ resource: "relative/path/to/file", reason: "why" })
```

When done:
```
lock_release({ resource: "relative/path/to/file" })
```

Use `coordination_status()` anytime to see the full picture. Locks auto-expire after 300s so a crash won't deadlock Codex.

## What this app does

Sales intelligence platform for a trading/finance CRM operation.
- Ingests call recordings via webhooks from CRM systems (brtcrm.io, mlbcrm.io, sfxcrm.io)
- Transcribes audio (ElevenLabs Scribe v2)
- Runs AI pipelines (chains of LLM agents) on transcripts
- Generates notes, persona profiles, compliance scores
- Pushes results back to CRM

## My role (Claude)

- Backend logic: `ui/backend/routers/` — especially `pipelines.py`, `history.py`, `notes.py`
- Live table UI: `ui/frontend/app/live/page.tsx`
- Pipeline canvas UI: `ui/frontend/app/pipeline/page.tsx`
- Bug fixes, architecture, data model changes
- See `AGENTS.md` for full ownership matrix

## Key files to know

```
ui/backend/
  main.py              App startup, background service init
  config.py            All env var settings (pydantic-settings)
  database.py          DB init + safe migrations (SQLite ↔ Postgres)
  models/
    pipeline_run.py    Core run model (id, status, steps_json, note_sent, note_sent_at)
  routers/
    pipelines.py       Pipeline CRUD + run execution (~9000 lines)
    history.py         Global run list + compact mode
    notes.py           Note generation + CRM push
    webhooks.py        Webhook ingestion + live dispatcher
    personas.py        Persona profiles

ui/frontend/
  app/live/page.tsx    Live job monitor (table + cards, bulk actions)
  app/pipeline/page.tsx Pipeline canvas editor + run view
  lib/version.ts       VERSION constant — bump before every commit
  package.json         version field — keep in sync with version.ts
```

## Data flow

```
CRM webhook → /webhooks/call-ended
  → transcription job (ElevenLabs)
  → pipeline run (chain of LLM agents)
  → artifact saved (note / persona / compliance)
  → optional CRM push
```

## Compact mode gotcha

`/api/history/runs?compact=1` strips steps_json down to only `{agent_name, state, start_time, end_time, note_id, note_call_id}`.
The `note_id` field MUST be preserved in compact mode — the live table uses it for bulk note sending.

## Run status values

Success: `done`, `completed`, `success`, `ok`, `finished`, `cached`
Failed: anything else that is terminal (not `queued`, `running`, `retrying`, `preparing`)

## Version bump procedure

```bash
# 1. Edit ui/frontend/lib/version.ts  → bump VERSION
# 2. Edit ui/frontend/package.json    → bump "version" field (same number)
# 3. Commit + push + deploy
```

## Before every frontend commit

```bash
cd ui/frontend && npx tsc --noEmit
```

## Deploy

```bash
bash deploy/deploy-dev.sh   # dev VM first
bash deploy/deploy.sh       # prod (only after user approves)
```

## Multi-agent coordination

- Check `.agents/state.json` before touching shared files
- Post to `llm_talk.txt` if you need Codex to hold
- See `AGENTS.md` for full protocol
