from datetime import datetime
from sqlmodel import Field, SQLModel


class AppStateKV(SQLModel, table=True):
    __tablename__ = "app_state_kv"

    key: str = Field(primary_key=True)
    value_json: str = ""
    updated_at: datetime = Field(default_factory=datetime.utcnow, index=True)
