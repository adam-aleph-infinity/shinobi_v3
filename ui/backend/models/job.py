from datetime import datetime
from enum import Enum
from typing import Optional
from sqlmodel import Field, SQLModel


class JobStatus(str, Enum):
    pending = "pending"
    running = "running"
    complete = "complete"
    failed = "failed"


class Job(SQLModel, table=True):
    id: str = Field(primary_key=True)
    status: JobStatus = Field(default=JobStatus.pending)
    audio_path: str
    pair_slug: str
    call_id: str
    speaker_a: str = "Ron"
    speaker_b: str = "Chris"
    stage: int = 0
    pct: int = 0
    message: str = ""
    manifest_path: Optional[str] = None
    error: Optional[str] = None
    extra_config: Optional[str] = None  # JSON: engines, noise_reduction, voice_isolation, etc.
    batch_id: Optional[str] = None      # groups jobs submitted together (UUID)
    created_at: datetime = Field(default_factory=datetime.utcnow)
    completed_at: Optional[datetime] = None
