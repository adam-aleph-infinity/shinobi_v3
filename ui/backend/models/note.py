from datetime import datetime
from typing import Optional
from sqlmodel import Field, SQLModel


class Note(SQLModel, table=True):
    id: str = Field(primary_key=True)
    agent: str
    customer: str
    call_id: str
    persona_agent_id: Optional[str] = None   # which persona agent config was used
    content_md: str = ""
    score_json: Optional[str] = None          # JSON-encoded per-section scores
    model: str = ""
    temperature: float = 0.0
    created_at: datetime = Field(default_factory=datetime.utcnow)
