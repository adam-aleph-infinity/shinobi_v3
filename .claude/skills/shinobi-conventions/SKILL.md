---
name: shinobi-conventions
description: >
  Auto-apply when working on Shinobi V3: pipelines, webhooks, CRM push, transcription,
  pipeline canvas, live monitor, FastAPI backend, Next.js frontend, ElevenLabs, notes,
  personas, compliance scores, GCP deploy, multi-agent coordination (Claude + Codex).
triggers:
  - pipeline
  - webhook
  - transcription
  - elevenlabs
  - crm push
  - note
  - persona
  - compliance
  - canvas
  - live monitor
  - fastapi
  - sqlmodel
  - shinobi
  - pipelines.py
  - history.py
  - notes.py
  - webhooks.py
  - personas.py
  - live/page
  - pipeline/page
  - deploy-dev
  - deploy.sh
  - lock_acquire
  - bootstrap
---

# Shinobi V3 Conventions

Full details in [CONVENTIONS.md](../../../CONVENTIONS.md). This is the quick-reference version.

## Session start — always first

```python
bootstrap({ name: "claude" })
```

Check `coordination_status()` before touching any shared file.

## Before editing any file

```python
lock_acquire({ resource: "relative/path", reason: "why" })
```

Release when done:

```python
lock_release({ resource: "relative/path" })
```

## File ownership quick reference

| Owner | Files |
|---|---|
| Claude | `routers/history.py`, `routers/pipelines.py`, `routers/notes.py`, `app/live/page.tsx`, `app/pipeline/page.tsx`, `lib/version.ts` |
| Codex | `routers/webhooks.py`, `deploy/*.sh`, `routers/personas.py`, `app/settings/page.tsx` |
| Shared (lock first) | `database.py`, `models/pipeline_run.py`, `main.py`, `package.json` |

## Version bump — required before every commit

1. `ui/frontend/lib/version.ts` → bump `VERSION`
2. `ui/frontend/package.json` → bump `"version"` (same number)

## Frontend pre-commit check

```bash
cd ui/frontend && npx tsc --noEmit
```

## Run status buckets

- **Success**: `done`, `completed`, `success`, `ok`, `finished`, `cached`
- **In-flight**: `queued`, `running`, `retrying`, `preparing`
- **Failed**: any other terminal value

## Compact mode gotcha

`/api/history/runs?compact=1` strips `steps_json`. `note_id` must survive — live table depends on it for bulk sends.

## Deploy sequence

```bash
bash deploy/deploy-dev.sh   # dev first
# Adam approves
bash deploy/deploy.sh       # prod
```

## Hard rules

1. Never commit `.env` / `.env.crm` / API keys
2. Never skip `tsc --noEmit` before frontend commit
3. Never push to `main` directly
4. Always `lock_acquire` shared files
5. Always bump version
6. Always `lock_release` when done
