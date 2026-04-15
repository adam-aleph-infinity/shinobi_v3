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
    """Apply incremental schema migrations (idempotent). SQLite-only DDL hacks."""
    if _DATABASE_URL:
        return  # PostgreSQL — SQLModel.metadata.create_all handles everything
    from sqlalchemy import text
    with engine.connect() as conn:
        for ddl in [
            "ALTER TABLE crm_pair ADD COLUMN ftd_at TEXT",
        ]:
            try:
                conn.execute(text(ddl))
                conn.commit()
            except Exception:
                pass  # column already exists


def create_db():
    SQLModel.metadata.create_all(engine)
    _migrate()


def get_session():
    with Session(engine) as session:
        yield session
