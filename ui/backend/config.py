from pathlib import Path
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    project_root: Path = Path(__file__).parent.parent.parent  # shinobi_v3/
    data_dir: Path = Path(__file__).parent.parent.parent / "data"          # legacy pipeline data
    output_dir: Path = Path(__file__).parent.parent.parent / "data" / "output"
    ui_data_dir: Path = Path(__file__).parent.parent / "data"              # ui/data/ — agent/customer hierarchy
    agents_dir: Path = Path(__file__).parent.parent / "data" / "agents"   # ui/data/agents/ — per-agent data
    index_file: Path = Path(__file__).parent.parent / "data" / "index.json"  # ui/data/index.json
    frontend_origin: str = "http://localhost:3000"   # override with FRONTEND_ORIGIN=https://... in .env

    model_config = {"env_file": str(Path(__file__).parent.parent.parent / ".env"), "extra": "ignore"}


settings = Settings()
