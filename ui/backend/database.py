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
    with engine.connect() as conn:
        # Column additions (run on both Postgres and SQLite)
        for ddl in [
            "ALTER TABLE pipeline_run ADD COLUMN run_origin TEXT NOT NULL DEFAULT ''",
        ]:
            try:
                conn.execute(text(ddl))
                conn.commit()
            except Exception:
                pass  # column already exists

        # SQLite-only column additions
        if not _DATABASE_URL:
            for ddl in [
                "ALTER TABLE crm_pair ADD COLUMN ftd_at TEXT",
            ]:
                try:
                    conn.execute(text(ddl))
                    conn.commit()
                except Exception:
                    pass  # column already exists

        # Indexes missing from SQLModel auto-create (safe to run on both Postgres + SQLite)
        for idx_ddl in [
            "CREATE INDEX IF NOT EXISTS ix_pipeline_run_started_at ON pipeline_run (started_at DESC)",
            "CREATE INDEX IF NOT EXISTS ix_pipeline_run_status ON pipeline_run (status)",
        ]:
            try:
                conn.execute(text(idx_ddl))
                conn.commit()
            except Exception:
                pass  # already exists or unsupported


def create_db():
    SQLModel.metadata.create_all(engine)
    _migrate()


def get_session():
    with Session(engine) as session:
        yield session
