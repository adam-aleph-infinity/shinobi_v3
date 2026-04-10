from datetime import datetime
from typing import Optional
from sqlmodel import SQLModel, Field


class CallMarker(SQLModel, table=True):
    __tablename__ = "call_marker"

    id: str = Field(primary_key=True)
    agent: str = Field(index=True)
    customer: str = Field(index=True)
    call_id: str = Field(index=True)
    marker_type: str          # red_flag | exchange | bank | milestone | warning | info
    emoji: str                # 🚩 💱 🏦 ✅ ⚠️ ℹ️
    label: str
    description: str = ""
    timestamp_s: Optional[float] = None
    timestamp_label: str = ""
    deep_dive_run_id: str = Field(index=True, default="")
    model: str = ""
    created_at: datetime = Field(default_factory=datetime.utcnow)
