import uuid
from sqlmodel import Field, SQLModel


class ComparisonFile(SQLModel, table=True):
    __tablename__ = "comparison_file"

    id: str = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    agent: str = Field(index=True)
    customer: str = Field(index=True)
    file_type: str = "transcript"   # "transcript" | "landmarks"
    xai_file_id: str
    filename: str
    uploaded_at: str = ""
