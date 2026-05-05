import uuid
from datetime import datetime
from typing import Optional

from sqlmodel import Field, SQLModel


class PipelineFolder(SQLModel, table=True):
    __tablename__ = "pipeline_folder"

    id: str = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    name: str = Field(index=True)
    description: Optional[str] = None
    color: Optional[str] = None          # hex e.g. "#4ade80", or None
    sort_order: int = Field(default=0, index=True)
    owner_email: Optional[str] = Field(default=None, index=True)  # None = shared/system
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)
