from pathlib import Path
from sqlmodel import SQLModel, create_engine, Session

# Canonical DB location: ui/database/shinobi.db
DB_PATH = Path(__file__).parent.parent.parent / "ui" / "database" / "shinobi.db"
DB_PATH.parent.mkdir(parents=True, exist_ok=True)

engine = create_engine(f"sqlite:///{DB_PATH}", echo=False)


def create_db():
    SQLModel.metadata.create_all(engine)


def get_session():
    with Session(engine) as session:
        yield session
