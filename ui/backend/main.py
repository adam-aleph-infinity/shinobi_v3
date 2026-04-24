import sys
from pathlib import Path
from datetime import datetime, timezone

# Ensure shinobi_v3 root is on path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

# Load .env so pipeline threads can read OPENAI_API_KEY, GEMINI_API_KEY, etc.
from dotenv import load_dotenv
load_dotenv(Path(__file__).parent.parent.parent / ".env")

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from ui.backend.config import settings
from ui.backend.database import create_db
from ui.backend.models.crm import CRMPair, CRMCall          # noqa: F401 — registers tables
from ui.backend.models.call_marker import CallMarker        # noqa: F401 — registers table
from ui.backend.models.comparison_file import ComparisonFile  # noqa: F401 — registers table
from ui.backend.models.note import Note                     # noqa: F401 — registers table
from ui.backend.models.agent_result import AgentResult      # noqa: F401 — registers table
from ui.backend.models.uploaded_file import UploadedFile    # noqa: F401 — registers table
from ui.backend.models.pipeline_run import PipelineRun      # noqa: F401 — registers table
from ui.backend.routers import crm, jobs, personas, logs, workspace, execution_logs
from ui.backend.routers import transcription_process, final_transcript
from ui.backend.routers.agent_stats import router as agent_stats_router
from ui.backend.routers.sync import router as sync_router
from ui.backend.routers.agent_comparison import router as agent_comparison_router
from ui.backend.routers.full_persona_agent import router as full_persona_agent_router
from ui.backend.routers.persona_agents import router as persona_agents_router
from ui.backend.routers.notes import router as notes_router
from ui.backend.routers.populate import router as populate_router
from ui.backend.routers.universal_agents import router as universal_agents_router
from ui.backend.routers.pipelines import router as pipelines_router
from ui.backend.routers.history import router as history_router
from ui.backend.services import log_buffer
from ui.backend.version import APP_VERSION

app = FastAPI(title="Shinobi V3 API", version=APP_VERSION)

_cors_origins = list({settings.frontend_origin, "http://localhost:3000", "http://localhost:3001"})
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Routers ────────────────────────────────────────────────────────────────────
app.include_router(crm.router)
app.include_router(jobs.router)
app.include_router(personas.router)
app.include_router(logs.router)
app.include_router(execution_logs.router)
app.include_router(workspace.router)
app.include_router(transcription_process.router)
app.include_router(final_transcript.router)
app.include_router(agent_stats_router)
app.include_router(sync_router)
app.include_router(agent_comparison_router)
app.include_router(full_persona_agent_router)
app.include_router(persona_agents_router)
app.include_router(notes_router)
app.include_router(populate_router)
app.include_router(universal_agents_router)
app.include_router(pipelines_router)
app.include_router(history_router)


@app.on_event("startup")
async def on_startup():
    import asyncio
    import shutil
    from datetime import datetime
    from sqlalchemy import text, inspect as _sa_inspect
    from sqlmodel import Session, select
    from ui.backend.database import engine, _DATABASE_URL
    from ui.backend.models.job import Job, JobStatus
    from ui.backend.models.crm import CRMPair
    from ui.backend.services import job_runner

    # One-time migration: copy old SQLite DB (SQLite only, skipped when using PostgreSQL)
    if not _DATABASE_URL:
        from ui.backend.database import DB_PATH  # type: ignore[attr-defined]  # noqa: F401
        old_db = settings.data_dir / "shinobi_ui.db"
        if not DB_PATH.exists() and old_db.exists():
            DB_PATH.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(old_db, DB_PATH)
            print(f"[startup] Migrated DB: {old_db} → {DB_PATH}")

    create_db()  # creates any missing tables

    # Safe migrations — add new columns if they don't exist yet
    with engine.connect() as conn:
        for stmt in [
            "ALTER TABLE job ADD COLUMN batch_id TEXT",
            "ALTER TABLE persona ADD COLUMN temperature REAL NOT NULL DEFAULT 0.3",
            "ALTER TABLE persona ADD COLUMN script_path TEXT",
            "ALTER TABLE persona ADD COLUMN persona_agent_id TEXT",
            "ALTER TABLE persona ADD COLUMN sections_json TEXT",
            "ALTER TABLE persona ADD COLUMN score_json TEXT",
            "ALTER TABLE comparison_file ADD COLUMN file_type TEXT NOT NULL DEFAULT 'transcript'",
            "ALTER TABLE agent_result ADD COLUMN pipeline_id TEXT",
            "ALTER TABLE agent_result ADD COLUMN pipeline_step_index INTEGER NOT NULL DEFAULT -1",
            "ALTER TABLE agent_result ADD COLUMN input_fingerprint TEXT",
        ]:
            try:
                conn.execute(text(stmt))
                conn.commit()
            except Exception:
                pass  # column already exists
        try:
            cols = {c["name"] for c in _sa_inspect(conn).get_columns("agent_result")}
            missing = [
                c for c in ("pipeline_id", "pipeline_step_index", "input_fingerprint")
                if c not in cols
            ]
            if missing:
                print(
                    "[startup] WARNING: agent_result missing columns "
                    f"{', '.join(missing)} — running in legacy cache compatibility mode"
                )
        except Exception:
            pass

    # Backfill persona_agent_id for existing personas that don't have it yet
    async def _backfill_persona_agent_id():
        import json as _json
        from ui.backend.config import settings as _settings
        presets_dir = _settings.ui_data_dir / "_persona_presets"
        if not presets_dir.exists():
            return
        presets_data = []
        for f in sorted(presets_dir.glob("*.json")):
            try:
                presets_data.append(_json.loads(f.read_text()))
            except Exception:
                continue
        if not presets_data:
            return
        with Session(engine) as db:
            from ui.backend.models.persona import Persona as _Persona
            orphans = db.exec(
                select(_Persona).where(_Persona.persona_agent_id == None)  # noqa: E711
            ).all()
            if not orphans:
                return
            updated = 0
            for p in orphans:
                for preset in presets_data:
                    sp = preset.get("system_prompt", "")
                    if sp and (p.prompt_used or "").startswith(sp):
                        p.persona_agent_id = preset["name"]
                        db.add(p)
                        updated += 1
                        break
            if updated:
                db.commit()
                print(f"[startup] Backfilled persona_agent_id for {updated} personas")

    asyncio.create_task(_backfill_persona_agent_id())

    # Normalize section headings in old personas
    async def _normalize_old_personas():
        import asyncio as _aio
        from ui.backend.routers.personas import _smart_normalize_sections
        from ui.backend.models.persona import Persona as _Persona
        with Session(engine) as db:
            candidates = db.exec(
                select(_Persona).where(_Persona.content_md != None)  # noqa: E711
            ).all()
            needs_norm = [
                p for p in candidates
                if p.content_md and not any(
                    line.startswith("##") or line.startswith("# ")
                    for line in p.content_md.split("\n")
                )
            ]
        if not needs_norm:
            return
        print(f"[startup] Normalizing {len(needs_norm)} persona(s) with no ## headers…")
        _loop = _aio.get_running_loop()
        updated = 0
        for p in needs_norm:
            try:
                normalized = await _loop.run_in_executor(
                    None, _smart_normalize_sections, p.content_md
                )
                if normalized != p.content_md:
                    with Session(engine) as db:
                        fresh = db.get(_Persona, p.id)
                        if fresh:
                            fresh.content_md = normalized
                            db.add(fresh)
                            db.commit()
                    updated += 1
                    print(f"[startup] Normalized {p.id[:8]} ({p.agent})")
            except Exception as e:
                print(f"[startup] Normalize failed for {p.id[:8]}: {e}")
        print(f"[startup] Section normalization complete — {updated}/{len(needs_norm)} updated")

    asyncio.create_task(_normalize_old_personas())

    # Merge alias agent rows in crm_pair table (e.g. Ron Silver-re10 → Ron Silver)
    async def _merge_alias_pairs():
        from ui.backend.services.crm_service import _load_aliases, _auto_detect_re_aliases
        from ui.backend.models.crm import CRMPair
        from sqlalchemy import text, func as sa_func
        file_aliases = _load_aliases()
        # Auto-detect Re-variant aliases from current DB agent names
        with Session(engine) as db:
            all_agents = [r[0] for r in db.exec(
                select(CRMPair.agent).distinct()
            ).all() if r[0]]
        auto_aliases = _auto_detect_re_aliases(all_agents)
        aliases = {**auto_aliases, **file_aliases}  # file entries take priority
        if not aliases:
            return
        with Session(engine) as db:
            for alias_name, primary_name in aliases.items():
                alias_rows = db.exec(select(CRMPair).where(CRMPair.agent == alias_name)).all()
                if not alias_rows:
                    continue
                merged = 0
                for alias_row in alias_rows:
                    primary_id = f"{alias_row.crm_url}::{alias_row.account_id}::{primary_name}"
                    primary_row = db.get(CRMPair, primary_id)
                    if primary_row:
                        primary_row.call_count = (primary_row.call_count or 0) + (alias_row.call_count or 0)
                        primary_row.total_duration_s = (primary_row.total_duration_s or 0) + (alias_row.total_duration_s or 0)
                        # Take non-zero deposit values from alias if primary has $0
                        for field in ("net_deposits", "total_deposits", "total_withdrawals"):
                            pv = float(getattr(primary_row, field) or 0)
                            av = float(getattr(alias_row, field) or 0)
                            if pv == 0 and av != 0:
                                setattr(primary_row, field, av)
                        db.add(primary_row)
                    else:
                        # No primary row — rename alias row to primary
                        new_row = CRMPair(
                            id=primary_id,
                            crm_url=alias_row.crm_url,
                            account_id=alias_row.account_id,
                            agent=primary_name,
                            customer=alias_row.customer,
                            call_count=alias_row.call_count,
                            total_duration_s=alias_row.total_duration_s,
                            net_deposits=alias_row.net_deposits,
                            total_deposits=alias_row.total_deposits,
                            total_withdrawals=alias_row.total_withdrawals,
                            last_synced_at=alias_row.last_synced_at,
                        )
                        db.add(new_row)
                    db.delete(alias_row)
                    merged += 1
                db.commit()
                if merged:
                    print(f"[startup] Merged {merged} alias rows: {alias_name} → {primary_name}")

    asyncio.create_task(_merge_alias_pairs())

    # Mark orphaned pipeline runs as error — any run still "running" when the
    # server starts was interrupted (crash / restart) and can never resume.
    # Without this, the frontend sees status="running" forever and shows orange.
    with engine.connect() as conn:
        try:
            import json as _json
            from ui.backend.models.pipeline_run import PipelineRun as _PR
            with Session(engine) as db:
                orphans = db.exec(
                    select(_PR).where(_PR.status == "running")
                ).all()
                for run in orphans:
                    # Flip any "loading" steps to "error"
                    try:
                        rss = _json.loads(run.steps_json) if run.steps_json else []
                        for s in rss:
                            if s.get("state") == "running" or s.get("status") == "loading":
                                s["state"] = "failed"
                                s["status"] = "error"
                                s["error_msg"] = "interrupted by server restart"
                        run.steps_json = _json.dumps(rss)
                    except Exception:
                        pass
                    run.status = "error"
                    db.add(run)
                    print(f"[startup] Marked orphaned pipeline run {run.id[:8]} as error")
                if orphans:
                    db.commit()
        except Exception as e:
            print(f"[startup] Pipeline run cleanup failed: {e}")

    log_buffer.install()

    # Seed crm_pair in background — only when DB is empty
    async def _seed_crm_bg():
        from sqlalchemy import func
        from ui.backend.services.crm_service import _load_local, seed_db
        loop = asyncio.get_running_loop()
        with Session(engine) as db:
            existing = db.exec(select(func.count(CRMPair.id))).one()
        if existing > 0:
            print(f"[startup] DB already has {existing} CRM pairs — skipping cache seed")
            return
        raw = await loop.run_in_executor(None, _load_local)
        if raw:
            def _do():
                with Session(engine) as db:
                    return seed_db(raw, db)
            n = await loop.run_in_executor(None, _do)
            print(f"[startup] Seeded {n} CRM pairs into DB from JSON cache")

    asyncio.create_task(_seed_crm_bg())

    # Reconcile CRM financial fields from index.json into active DB (SQLite/Postgres).
    # This prevents stale DB deposits when index has newer values.
    async def _reconcile_crm_financials_bg():
        from ui.backend.models.crm import CRMPair

        if not settings.index_file.exists():
            return

        loop = asyncio.get_running_loop()

        def _to_float(v):
            try:
                if v is None:
                    return None
                if isinstance(v, (int, float)):
                    return float(v)
                s = str(v).strip().replace(",", "")
                return float(s) if s else None
            except Exception:
                return None

        def _do():
            try:
                import json as _json
                rows = _json.loads(settings.index_file.read_text(encoding="utf-8"))
            except Exception:
                return 0, 0, 0

            if not isinstance(rows, list) or not rows:
                return 0, 0, 0

            updated = created = seen = 0
            now = datetime.now(timezone.utc)

            with Session(engine) as db:
                for p in rows:
                    if not isinstance(p, dict):
                        continue
                    crm_url = str(p.get("crm") or p.get("crm_url") or "").strip()
                    account_id = str(p.get("account_id") or "").strip()
                    agent = str(p.get("agent") or "").strip()
                    customer = str(p.get("customer") or "").strip()
                    if not crm_url or not account_id or not agent:
                        continue

                    nd = _to_float(p.get("net_deposits"))
                    td = _to_float(p.get("total_deposits"))
                    tw = _to_float(p.get("total_withdrawals"))
                    ftd_at = p.get("ftd_at")
                    if nd is None and td is None and tw is None and ftd_at is None:
                        continue

                    seen += 1
                    row_id = f"{crm_url}::{account_id}::{agent}"
                    pair = db.get(CRMPair, row_id)
                    if pair is None:
                        pair = CRMPair(
                            id=row_id,
                            crm_url=crm_url,
                            account_id=account_id,
                            agent=agent,
                            customer=customer,
                            call_count=int(p.get("total_calls") or p.get("recorded_calls") or 0),
                            total_duration_s=int(p.get("total_duration_s") or 0),
                            net_deposits=nd if nd is not None else 0.0,
                            total_deposits=td if td is not None else 0.0,
                            total_withdrawals=tw if tw is not None else 0.0,
                            ftd_at=ftd_at if ftd_at is not None else None,
                            last_synced_at=now,
                        )
                        db.add(pair)
                        created += 1
                        continue

                    changed = False
                    if nd is not None and float(pair.net_deposits or 0) != nd:
                        pair.net_deposits = nd
                        changed = True
                    if td is not None and float(pair.total_deposits or 0) != td:
                        pair.total_deposits = td
                        changed = True
                    if tw is not None and float(pair.total_withdrawals or 0) != tw:
                        pair.total_withdrawals = tw
                        changed = True
                    if ftd_at is not None and pair.ftd_at != ftd_at:
                        pair.ftd_at = ftd_at
                        changed = True

                    if changed:
                        pair.last_synced_at = now
                        db.add(pair)
                        updated += 1

                if updated or created:
                    db.commit()

            return updated, created, seen

        try:
            updated, created, seen = await loop.run_in_executor(None, _do)
            if updated or created:
                print(
                    f"[startup] Reconciled CRM financials from index — "
                    f"{updated} updated, {created} created (checked {seen} rows)"
                )
        except Exception as e:
            print(f"[startup] CRM financial reconcile failed: {e}")

    asyncio.create_task(_reconcile_crm_financials_bg())

    # Re-queue orphaned jobs from previous server runs
    loop = asyncio.get_running_loop()
    with Session(engine) as db:
        stale = db.exec(
            select(Job).where(Job.status.in_([JobStatus.running, JobStatus.pending]))
        ).all()
        for job in stale:
            if job.status == JobStatus.running:
                job.status = JobStatus.pending
                job.pct = 0
                job.stage = 0
                job.message = ""
                db.add(job)
                print(f"[startup] Reset running→pending: {job.id[:8]} ({job.call_id})")
        db.commit()
        pending = db.exec(select(Job).where(Job.status == JobStatus.pending)).all()
        for job in pending:
            job_runner.submit_job(job, loop)
            print(f"[startup] Re-queued pending job {job.id[:8]} ({job.call_id})")


@app.get("/health")
def health():
    return {"status": "ok", "version": APP_VERSION}


@app.get("/time")
def server_time():
    now_utc = datetime.now(timezone.utc)
    now_vm = datetime.now().astimezone()
    return {
        "now_utc": now_utc.isoformat(timespec="seconds"),
        "now_vm": now_vm.isoformat(timespec="seconds"),
        "tz": str(now_vm.tzinfo) if now_vm.tzinfo else "unknown",
    }
