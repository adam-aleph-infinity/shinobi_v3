from datetime import datetime
from typing import Optional

from sqlmodel import Field, SQLModel


class AppLog(SQLModel, table=True):
    __tablename__ = "app_log"

    id: Optional[int] = Field(default=None, primary_key=True)
    ts: datetime = Field(default_factory=datetime.utcnow, index=True)
    trace_id: str = Field(default="", index=True)
    service: str = Field(default="backend", index=True)  # backend | frontend
    source: str = Field(default="", index=True)          # http | sse | worker | ui
    component: str = Field(default="", index=True)       # router/service/provider
    category: str = Field(default="system", index=True)  # pipeline | llm | elevenlabs | auth | ...
    level: str = Field(default="info", index=True)       # debug | info | warn | error | audit
    message: str = ""
    user_email: str = Field(default="", index=True)
    job_id: str = Field(default="", index=True)
    context_json: str = ""
    error_body: str = ""
