from datetime import datetime
from typing import Optional
from sqlmodel import Field, SQLModel


class Persona(SQLModel, table=True):
    id: str = Field(primary_key=True)
    type: str  # "agent_overall" | "customer" | "pair"
    agent: str = Field(index=True)
    customer: Optional[str] = Field(default=None, index=True)
    label: Optional[str] = None
    content_md: str = ""
    prompt_used: str = ""
    model: str = "gpt-5.4"
    temperature: float = 0.0
    transcript_paths: str = ""  # JSON-encoded list
    script_path: Optional[str] = None  # path to saved merged script used as LLM input
    version: int = 1
    parent_id: Optional[str] = Field(default=None, index=True)  # points to first version's id
    persona_agent_id: Optional[str] = Field(default=None, index=True)  # which persona agent (prompt) created this
    sections_json: Optional[str] = None     # JSON-encoded list of PersonaSection dicts
    score_json: Optional[str] = None        # JSON-encoded per-section scores {name: {score, reasoning}, _overall, _summary}
    created_at: datetime = Field(default_factory=datetime.utcnow, index=True)
