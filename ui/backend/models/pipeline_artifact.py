from datetime import datetime
from sqlmodel import SQLModel, Field


class PipelineArtifact(SQLModel, table=True):
    __tablename__ = "pipeline_artifact"

    # Deterministic key: pipeline_id + agent/customer + call_id + step index
    id: str = Field(primary_key=True)
    pipeline_id: str = Field(index=True)
    sales_agent: str = Field(default="", index=True)
    customer: str = Field(default="", index=True)
    call_id: str = Field(default="", index=True)  # empty = pair-level artifact
    pipeline_step_index: int = Field(default=-1, index=True)
    agent_id: str = Field(default="", index=True)
    agent_name: str = ""
    result_id: str = Field(default="", index=True)
    input_fingerprint: str = Field(default="", index=True)
    model: str = ""
    source: str = ""  # done | cached_exact | cached_resume
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow, index=True)
