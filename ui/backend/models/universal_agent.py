import uuid
from datetime import datetime
from typing import Optional

from sqlmodel import Field, SQLModel


class UniversalAgent(SQLModel, table=True):
    __tablename__ = "universal_agent"

    id: str = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    name: str = Field(index=True)
    description: Optional[str] = Field(default=None)
    agent_class: Optional[str] = Field(default=None, index=True)
    model: str = Field(default="gpt-5.4")
    temperature: float = Field(default=0.0)
    system_prompt: Optional[str] = Field(default=None)
    user_prompt: Optional[str] = Field(default=None)
    inputs_json: Optional[str] = Field(default="[]")         # JSON list of AgentInput dicts
    output_format: str = Field(default="markdown")
    artifact_type: Optional[str] = Field(default=None)
    artifact_class: Optional[str] = Field(default=None)
    output_schema: Optional[str] = Field(default=None)
    output_taxonomy_json: Optional[str] = Field(default="[]")  # JSON list of strings
    output_contract_mode: str = Field(default="soft")
    output_fit_strategy: str = Field(default="structured")
    artifact_name: Optional[str] = Field(default=None)
    output_response_mode: str = Field(default="wrap")
    output_target_type: str = Field(default="raw_text")
    output_template: Optional[str] = Field(default=None)
    output_placeholder: str = Field(default="response")
    output_previous_placeholder: str = Field(default="previous_response")
    tags_json: Optional[str] = Field(default="[]")            # JSON list of strings
    is_default: bool = Field(default=False, index=True)
    folder: Optional[str] = Field(default=None, index=True)
    workspace_user_email: Optional[str] = Field(default=None, index=True)
    workspace_user_name: Optional[str] = Field(default=None)
    locked_by_email: Optional[str] = Field(default=None)
    locked_by_name: Optional[str] = Field(default=None)
    locked_at: Optional[str] = Field(default=None)
    lock_reason: Optional[str] = Field(default=None)
    created_at: Optional[datetime] = Field(default_factory=datetime.utcnow)
    updated_at: Optional[datetime] = Field(default_factory=datetime.utcnow)
