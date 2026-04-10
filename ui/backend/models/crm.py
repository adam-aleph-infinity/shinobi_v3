from typing import Optional
from datetime import datetime
from sqlmodel import SQLModel, Field


class CRMPair(SQLModel, table=True):
    __tablename__ = "crm_pair"

    id: str = Field(primary_key=True)            # "{crm_url}::{account_id}::{agent}"
    crm_url: str = Field(index=True)
    account_id: str
    agent: str = Field(index=True)
    customer: str = Field(index=True)
    call_count: int = Field(default=0)
    total_duration_s: int = Field(default=0)
    net_deposits: Optional[float] = Field(default=None)       # total_net_deposits from CRM API
    total_deposits: Optional[float] = Field(default=None)
    total_withdrawals: Optional[float] = Field(default=None)
    ftd_at: Optional[str] = Field(default=None)               # first-time deposit datetime (ISO str)
    last_synced_at: Optional[datetime] = Field(default=None)


class CRMCall(SQLModel, table=True):
    __tablename__ = "crm_call"

    id: str = Field(primary_key=True)            # "{crm_url}::{call_id}"
    crm_url: str = Field(index=True)
    call_id: str = Field(index=True)
    account_id: str
    agent: str = Field(index=True)
    customer: str = Field(index=True)
    duration_s: int = Field(default=0)           # from CRM API
    started_at: Optional[str] = Field(default=None)
    record_path: Optional[str] = Field(default=None)
    has_local_audio: bool = Field(default=False) # WAV file downloaded locally
    audio_duration_s: Optional[float] = Field(default=None)  # measured from WAV header
    synced_at: Optional[datetime] = Field(default=None)
