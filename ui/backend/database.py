import os
from pathlib import Path
from sqlmodel import SQLModel, create_engine, Session

# If DATABASE_URL is set (e.g. postgresql://user:pass@host/db), use it.
# Otherwise fall back to the local SQLite file for local dev.
_DATABASE_URL = os.environ.get("DATABASE_URL")

if _DATABASE_URL:
    engine = create_engine(_DATABASE_URL, echo=False, pool_pre_ping=True)
else:
    DB_PATH = Path(__file__).parent.parent.parent / "ui" / "database" / "shinobi.db"
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    engine = create_engine(f"sqlite:///{DB_PATH}", echo=False)


def _migrate():
    """Apply incremental schema migrations (idempotent)."""
    from sqlalchemy import text

    def _exec_safe(conn, ddl: str) -> None:
        try:
            conn.execute(text(ddl))
            conn.commit()
        except Exception:
            try:
                conn.rollback()
            except Exception:
                pass

    with engine.connect() as conn:
        # Column additions (run on both Postgres and SQLite)
        for ddl in [
            "ALTER TABLE pipeline_run ADD COLUMN run_origin TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE pipeline_run ADD COLUMN note_sent BOOLEAN NOT NULL DEFAULT FALSE",
            "ALTER TABLE pipeline_run ADD COLUMN note_sent_at TIMESTAMP",
            "ALTER TABLE pipeline_run ADD COLUMN review_required BOOLEAN NOT NULL DEFAULT FALSE",
            "ALTER TABLE pipeline_run ADD COLUMN review_status TEXT",
            "ALTER TABLE pipeline_run ADD COLUMN review_note TEXT",
            "ALTER TABLE pipeline_run ADD COLUMN reviewed_at TIMESTAMP",
        ]:
            _exec_safe(conn, ddl)

        # SQLite-only column additions
        if not _DATABASE_URL:
            for ddl in [
                "ALTER TABLE crm_pair ADD COLUMN ftd_at TEXT",
            ]:
                _exec_safe(conn, ddl)

        # pipeline_folder indexes
        for idx_ddl in [
            "CREATE INDEX IF NOT EXISTS ix_pipeline_folder_owner_email ON pipeline_folder (owner_email)",
            "CREATE INDEX IF NOT EXISTS ix_pipeline_folder_sort_order ON pipeline_folder (sort_order)",
        ]:
            _exec_safe(conn, idx_ddl)

        # Seed pipeline_folder table from _pipelines_folders.json (one-time, idempotent)
        _seed_pipeline_folders(conn)

        # Seed universal_agent and pipeline tables from legacy JSON files (one-time, idempotent)
        _seed_universal_agents(conn)
        _seed_pipelines(conn)

        # Indexes missing from SQLModel auto-create (safe to run on both Postgres + SQLite)
        for idx_ddl in [
            "CREATE INDEX IF NOT EXISTS ix_pipeline_run_started_at ON pipeline_run (started_at DESC)",
            "CREATE INDEX IF NOT EXISTS ix_pipeline_run_status ON pipeline_run (status)",
            "CREATE INDEX IF NOT EXISTS ix_pipeline_run_run_origin ON pipeline_run (run_origin)",
            "CREATE INDEX IF NOT EXISTS ix_pipeline_run_note_sent ON pipeline_run (note_sent)",
            "CREATE INDEX IF NOT EXISTS ix_pipeline_run_note_sent_at ON pipeline_run (note_sent_at DESC)",
            "CREATE INDEX IF NOT EXISTS ix_pipeline_run_review_required ON pipeline_run (review_required)",
            "CREATE INDEX IF NOT EXISTS ix_pipeline_run_review_status ON pipeline_run (review_status)",
            "CREATE INDEX IF NOT EXISTS ix_pipeline_run_pipeline_agent_customer_started ON pipeline_run (pipeline_id, sales_agent, customer, started_at DESC)",
            "CREATE INDEX IF NOT EXISTS ix_pipeline_run_pipeline_agent_customer_call_started ON pipeline_run (pipeline_id, sales_agent, customer, call_id, started_at DESC)",
            "CREATE INDEX IF NOT EXISTS ix_note_call_id ON note (call_id)",
            "CREATE INDEX IF NOT EXISTS ix_note_agent_customer ON note (agent, customer)",
            "CREATE INDEX IF NOT EXISTS ix_note_agent_customer_call_id ON note (agent, customer, call_id)",
            "CREATE INDEX IF NOT EXISTS ix_persona_parent_id ON persona (parent_id)",
            "CREATE INDEX IF NOT EXISTS ix_persona_agent_customer ON persona (agent, customer)",
            "CREATE INDEX IF NOT EXISTS ix_persona_persona_agent_id ON persona (persona_agent_id)",
            "CREATE INDEX IF NOT EXISTS ix_job_status ON job (status)",
            "CREATE INDEX IF NOT EXISTS ix_job_pair_slug_call_status ON job (pair_slug, call_id, status)",
            "CREATE INDEX IF NOT EXISTS ix_job_created_at ON job (created_at DESC)",
            "CREATE INDEX IF NOT EXISTS ix_crm_pair_account_id ON crm_pair (account_id)",
            "CREATE INDEX IF NOT EXISTS ix_crm_pair_crm_account ON crm_pair (crm_url, account_id)",
            "CREATE INDEX IF NOT EXISTS ix_crm_call_account_id ON crm_call (account_id)",
            "CREATE INDEX IF NOT EXISTS ix_crm_call_crm_account ON crm_call (crm_url, account_id)",
            "CREATE INDEX IF NOT EXISTS ix_crm_call_account_call_id ON crm_call (account_id, call_id)",
            "CREATE INDEX IF NOT EXISTS ix_sessionanalysis_agent ON sessionanalysis (agent)",
            "CREATE INDEX IF NOT EXISTS ix_sessionanalysis_pair_slug ON sessionanalysis (pair_slug)",
            "CREATE INDEX IF NOT EXISTS ix_sessionanalysis_call_id ON sessionanalysis (call_id)",
            "CREATE INDEX IF NOT EXISTS ix_app_log_ts_desc ON app_log (ts DESC)",
            "CREATE INDEX IF NOT EXISTS ix_app_log_trace_id ON app_log (trace_id)",
            "CREATE INDEX IF NOT EXISTS ix_app_log_category_ts ON app_log (category, ts DESC)",
            "CREATE INDEX IF NOT EXISTS ix_app_log_level_ts ON app_log (level, ts DESC)",
            "CREATE INDEX IF NOT EXISTS ix_app_log_source_ts ON app_log (source, ts DESC)",
            "CREATE INDEX IF NOT EXISTS ix_app_log_component_ts ON app_log (component, ts DESC)",
            "CREATE INDEX IF NOT EXISTS ix_app_log_user_ts ON app_log (user_email, ts DESC)",
            "CREATE INDEX IF NOT EXISTS ix_app_log_job_ts ON app_log (job_id, ts DESC)",
        ]:
            _exec_safe(conn, idx_ddl)


def _seed_pipeline_folders(conn) -> None:
    """Seed pipeline_folder table from legacy _pipelines_folders.json. Idempotent."""
    import json
    import uuid as _uuid
    from datetime import datetime as _dt
    from pathlib import Path as _Path
    from sqlalchemy import text as _text

    # Verify table is accessible
    try:
        conn.execute(_text("SELECT 1 FROM pipeline_folder LIMIT 1"))
    except Exception:
        return  # table not ready

    try:
        from ui.backend.config import settings as _s
        folders_file = _s.ui_data_dir / "_pipelines_folders.json"
        if not folders_file.exists():
            return
        raw = json.loads(folders_file.read_text(encoding="utf-8"))
        if not isinstance(raw, list):
            return
    except Exception:
        return

    seen: set[str] = set()
    sort_idx = 0
    now = _dt.utcnow().isoformat()
    for item in raw:
        name = " ".join(str(item or "").strip().split())
        if not name or name.lower() in seen:
            continue
        seen.add(name.lower())
        try:
            conn.execute(
                _text(
                    "INSERT INTO pipeline_folder (id, name, description, color, sort_order, owner_email, created_at, updated_at) "
                    "VALUES (:id, :name, NULL, NULL, :sort_order, NULL, :created_at, :updated_at) "
                    "ON CONFLICT (id) DO NOTHING"
                ),
                {"id": str(_uuid.uuid4()), "name": name, "sort_order": sort_idx, "created_at": now, "updated_at": now},
            )
            conn.commit()
            sort_idx += 1
        except Exception:
            try:
                conn.rollback()
            except Exception:
                pass


def _seed_universal_agents(conn) -> None:
    """Seed universal_agent table from legacy _universal_agents/*.json.
    Runs on every startup — ON CONFLICT (id) DO NOTHING skips existing rows.
    Picks up new JSON files automatically without clearing the table."""
    import json
    from sqlalchemy import text as _text

    # Verify table is accessible
    try:
        conn.execute(_text("SELECT 1 FROM universal_agent LIMIT 1"))
    except Exception:
        return  # table not ready

    try:
        from ui.backend.config import settings as _s
        agent_dir = _s.ui_data_dir / "_universal_agents"
        if not agent_dir.exists():
            return
        for f in sorted(agent_dir.glob("*.json")):
            try:
                data = json.loads(f.read_text(encoding="utf-8"))
                if not isinstance(data, dict) or not data.get("id"):
                    continue
                conn.execute(
                    _text(
                        "INSERT INTO universal_agent ("
                        "  id, name, description, agent_class, model, temperature,"
                        "  system_prompt, user_prompt, inputs_json, output_format,"
                        "  artifact_type, artifact_class, output_schema, output_taxonomy_json,"
                        "  output_contract_mode, output_fit_strategy, artifact_name,"
                        "  output_response_mode, output_target_type, output_template,"
                        "  output_placeholder, output_previous_placeholder,"
                        "  tags_json, is_default, folder,"
                        "  workspace_user_email, workspace_user_name,"
                        "  locked_by_email, locked_by_name, locked_at, lock_reason,"
                        "  created_at, updated_at"
                        ") VALUES ("
                        "  :id, :name, :description, :agent_class, :model, :temperature,"
                        "  :system_prompt, :user_prompt, :inputs_json, :output_format,"
                        "  :artifact_type, :artifact_class, :output_schema, :output_taxonomy_json,"
                        "  :output_contract_mode, :output_fit_strategy, :artifact_name,"
                        "  :output_response_mode, :output_target_type, :output_template,"
                        "  :output_placeholder, :output_previous_placeholder,"
                        "  :tags_json, :is_default, :folder,"
                        "  :workspace_user_email, :workspace_user_name,"
                        "  :locked_by_email, :locked_by_name, :locked_at, :lock_reason,"
                        "  :created_at, :updated_at"
                        ") ON CONFLICT (id) DO NOTHING"
                    ),
                    {
                        "id": str(data.get("id", "")),
                        "name": str(data.get("name", "")),
                        "description": str(data.get("description") or ""),
                        "agent_class": str(data.get("agent_class") or ""),
                        "model": str(data.get("model") or "gpt-5.4"),
                        "temperature": float(data.get("temperature") or 0.0),
                        "system_prompt": str(data.get("system_prompt") or ""),
                        "user_prompt": str(data.get("user_prompt") or ""),
                        "inputs_json": json.dumps(data.get("inputs") or []),
                        "output_format": str(data.get("output_format") or "markdown"),
                        "artifact_type": str(data.get("artifact_type") or ""),
                        "artifact_class": str(data.get("artifact_class") or ""),
                        "output_schema": str(data.get("output_schema") or ""),
                        "output_taxonomy_json": json.dumps(data.get("output_taxonomy") or []),
                        "output_contract_mode": str(data.get("output_contract_mode") or "soft"),
                        "output_fit_strategy": str(data.get("output_fit_strategy") or "structured"),
                        "artifact_name": str(data.get("artifact_name") or ""),
                        "output_response_mode": str(data.get("output_response_mode") or "wrap"),
                        "output_target_type": str(data.get("output_target_type") or "raw_text"),
                        "output_template": str(data.get("output_template") or ""),
                        "output_placeholder": str(data.get("output_placeholder") or "response"),
                        "output_previous_placeholder": str(data.get("output_previous_placeholder") or "previous_response"),
                        "tags_json": json.dumps(data.get("tags") or []),
                        "is_default": bool(data.get("is_default")),
                        "folder": str(data.get("folder") or ""),
                        "workspace_user_email": str(data.get("workspace_user_email") or ""),
                        "workspace_user_name": str(data.get("workspace_user_name") or ""),
                        "locked_by_email": str(data.get("locked_by_email") or ""),
                        "locked_by_name": str(data.get("locked_by_name") or ""),
                        "locked_at": str(data.get("locked_at") or ""),
                        "lock_reason": str(data.get("lock_reason") or ""),
                        "created_at": str(data.get("created_at") or ""),
                        "updated_at": str(data.get("updated_at") or ""),
                    },
                )
                conn.commit()
            except Exception:
                try:
                    conn.rollback()
                except Exception:
                    pass
    except Exception:
        pass


def _seed_pipelines(conn) -> None:
    """Seed pipeline table from legacy _pipelines/*.json.
    Runs on every startup — ON CONFLICT (id) DO NOTHING skips existing rows."""
    import json
    from sqlalchemy import text as _text

    # Verify table is accessible
    try:
        conn.execute(_text("SELECT 1 FROM pipeline LIMIT 1"))
    except Exception:
        return  # table not ready

    try:
        from ui.backend.config import settings as _s
        pipeline_dir = _s.ui_data_dir / "_pipelines"
        if not pipeline_dir.exists():
            return
        for f in sorted(pipeline_dir.glob("*.json")):
            try:
                data = json.loads(f.read_text(encoding="utf-8"))
                if not isinstance(data, dict) or not data.get("id"):
                    continue
                conn.execute(
                    _text(
                        "INSERT INTO pipeline ("
                        "  id, name, description, scope,"
                        "  steps_json, canvas_json, folder, folder_id,"
                        "  workspace_user_email, workspace_user_name,"
                        "  locked_by_email, locked_by_name, locked_at, lock_reason,"
                        "  created_at, updated_at"
                        ") VALUES ("
                        "  :id, :name, :description, :scope,"
                        "  :steps_json, :canvas_json, :folder, :folder_id,"
                        "  :workspace_user_email, :workspace_user_name,"
                        "  :locked_by_email, :locked_by_name, :locked_at, :lock_reason,"
                        "  :created_at, :updated_at"
                        ") ON CONFLICT (id) DO NOTHING"
                    ),
                    {
                        "id": str(data.get("id", "")),
                        "name": str(data.get("name", "")),
                        "description": str(data.get("description") or ""),
                        "scope": str(data.get("scope") or "per_pair"),
                        "steps_json": json.dumps(data.get("steps") or []),
                        "canvas_json": json.dumps(data.get("canvas") or {}),
                        "folder": str(data.get("folder") or ""),
                        "folder_id": str(data.get("folder_id") or "") or None,
                        "workspace_user_email": str(data.get("workspace_user_email") or ""),
                        "workspace_user_name": str(data.get("workspace_user_name") or ""),
                        "locked_by_email": str(data.get("locked_by_email") or ""),
                        "locked_by_name": str(data.get("locked_by_name") or ""),
                        "locked_at": str(data.get("locked_at") or ""),
                        "lock_reason": str(data.get("lock_reason") or ""),
                        "created_at": str(data.get("created_at") or ""),
                        "updated_at": str(data.get("updated_at") or ""),
                    },
                )
                conn.commit()
            except Exception:
                try:
                    conn.rollback()
                except Exception:
                    pass
    except Exception:
        pass


def create_db():
    SQLModel.metadata.create_all(engine)
    _migrate()


def get_session():
    with Session(engine) as session:
        yield session
