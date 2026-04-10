from datetime import datetime
from typing import Optional
from sqlmodel import Field, SQLModel


class SessionAnalysis(SQLModel, table=True):
    id: str = Field(primary_key=True)
    job_id: str
    pair_slug: str
    call_id: str
    agent: str
    customer: str
    score: int = 0
    analysis_md: str = ""
    improvement_items: str = ""  # JSON-encoded list
    prompt_used: str = ""
    model: str = "gpt-4o"
    created_at: datetime = Field(default_factory=datetime.utcnow)
