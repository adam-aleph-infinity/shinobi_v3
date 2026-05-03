from datetime import datetime
from typing import Optional
from sqlmodel import Field, SQLModel


class PipelineRun(SQLModel, table=True):
    __tablename__ = "pipeline_run"

    id: str = Field(primary_key=True)
    pipeline_id: str = Field(default="", index=True)
    pipeline_name: str = ""
    sales_agent: str = Field(default="", index=True)
    customer: str = Field(default="", index=True)
    call_id: str = Field(default="", index=True)
    started_at: datetime = Field(default_factory=datetime.utcnow, index=True)
    finished_at: Optional[datetime] = None
    status: str = "running"  # running | done | error
    canvas_json: str = ""    # JSON canvas snapshot {nodes, edges, stages}
    steps_json: str = ""     # JSON [{agent_id, agent_name, status, content, error_msg}]
    log_json: str = ""       # JSON [{ts, text, level}]
