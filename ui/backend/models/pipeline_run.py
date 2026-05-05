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
    status: str = Field(default="running", index=True)  # running | done | error
    run_origin: str = Field(default="", index=True)     # local | webhook — stored at creation, shared across VMs via DB
    note_sent: bool = Field(default=False, index=True)  # True once a CRM note was successfully pushed for this run
    note_sent_at: Optional[datetime] = Field(default=None, index=True)  # timestamp of the successful push
    # Review queue: set when confidence check flags a note before auto-push
    review_required: bool = Field(default=False, index=True)
    review_status: Optional[str] = Field(default=None, index=True)  # pending | approved | rejected
    review_note: Optional[str] = None
    reviewed_at: Optional[datetime] = None
    canvas_json: str = ""    # JSON canvas snapshot {nodes, edges, stages}
    steps_json: str = ""     # JSON [{agent_id, agent_name, status, content, error_msg}]
    log_json: str = ""       # JSON [{ts, text, level}]
