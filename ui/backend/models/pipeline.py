import uuid
from datetime import datetime
from typing import Optional

from sqlmodel import Field, SQLModel


class Pipeline(SQLModel, table=True):
    __tablename__ = "pipeline"

    id: str = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    name: str = Field(index=True)
    description: Optional[str] = Field(default=None)
    scope: str = Field(default="per_pair")
    steps_json: Optional[str] = Field(default="[]")    # JSON list of PipelineStep dicts
    canvas_json: Optional[str] = Field(default="{}")   # JSON canvas layout dict
    folder: Optional[str] = Field(default=None, index=True)
    folder_id: Optional[str] = Field(default=None, index=True)  # FK to pipeline_folder.id
    workspace_user_email: Optional[str] = Field(default=None, index=True)
    workspace_user_name: Optional[str] = Field(default=None)
    locked_by_email: Optional[str] = Field(default=None)
    locked_by_name: Optional[str] = Field(default=None)
    locked_at: Optional[str] = Field(default=None)
    lock_reason: Optional[str] = Field(default=None)
    created_at: Optional[datetime] = Field(default_factory=datetime.utcnow)
    updated_at: Optional[datetime] = Field(default_factory=datetime.utcnow)
