from datetime import datetime
from typing import Optional
from sqlmodel import Field, SQLModel


class UploadedFile(SQLModel, table=True):
    __tablename__ = "uploaded_file"

    id: str = Field(primary_key=True)
    provider: str = Field(index=True)          # gemini | anthropic
    provider_file_id: str = ""                 # Gemini file.name or Anthropic file.id
    provider_file_uri: str = ""                # Gemini URI (for display only)
    content_hash: str = Field(index=True)      # SHA-256 prefix for dedup
    input_key: str = ""                        # {key} variable name
    source: str = ""                           # transcript | merged_transcript | …
    sales_agent: str = Field(default="", index=True)
    customer: str = Field(default="", index=True)
    call_id: str = Field(default="", index=True)
    chars: int = 0
    created_at: datetime = Field(default_factory=datetime.utcnow)
    expires_at: Optional[datetime] = None      # None = no expiry (Anthropic)
