from datetime import datetime
from sqlmodel import Field, SQLModel


class AgentResult(SQLModel, table=True):
    __tablename__ = "agent_result"

    id: str = Field(primary_key=True)
    agent_id: str = Field(index=True)
    agent_name: str = ""
    sales_agent: str = Field(default="", index=True)
    customer: str = Field(default="", index=True)
    call_id: str = Field(default="", index=True)  # empty = pair-level result
    # Pipeline-aware cache dimensions (blank/-1 for non-pipeline runs)
    pipeline_id: str = Field(default="", index=True)
    pipeline_step_index: int = Field(default=-1, index=True)
    input_fingerprint: str = Field(default="", index=True)
    content: str = ""
    model: str = ""
    created_at: datetime = Field(default_factory=datetime.utcnow)
