# Shinobi V3 — Claude Code

> Shared rules live in [CONVENTIONS.md](CONVENTIONS.md). Read that first.
> My detailed session instructions are in [.claude/CLAUDE.md](.claude/CLAUDE.md) — Claude Code loads that automatically.

---

## What this is

Sales intelligence platform: CRM webhooks → transcription → AI pipelines → notes/personas → CRM push.

Backend: FastAPI + SQLModel. Frontend: Next.js 14 App Router + Tailwind + SWR.

---

## Claude's lane

- Complex multi-file refactors and architecture decisions
- Backend pipeline logic (`routers/pipelines.py`, `routers/notes.py`, `routers/history.py`)
- Live job monitor and pipeline canvas UI (`app/live/page.tsx`, `app/pipeline/page.tsx`)
- Data model changes, bug triage, planning

Focused edits, tests, deploy scripts, and code review → prefer Codex.

---

## Session start

```python
bootstrap({ name: "claude" })   # always first — registers me, shows locks + pending tasks
```

See [CONVENTIONS.md](CONVENTIONS.md) for the full workflow, file ownership, and hard rules.
