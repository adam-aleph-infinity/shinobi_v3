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
    crm_push_enabled: bool = False
    crm_push_endpoint: str = "https://brtcrm.io/api/v1/accounts/{api_username}-incoming/"
    crm_push_api_username: str = ""
    crm_push_api_password: str = ""
    crm_push_api_key: str = ""
    crm_push_data_field: str = "note"
    crm_push_timeout_s: int = 20
    crm_webhook_enabled: bool = True
    crm_webhook_secret: str = ""
    crm_webhook_require_secret: bool = True
    crm_webhook_token_header: str = "x-webhook-token"
    crm_webhook_transcription_timeout_s: int = 900
    crm_webhook_transcription_poll_interval_s: float = 2.0
    elevenlabs_connect_timeout_s: float = 20.0
    elevenlabs_read_timeout_s: float = 180.0
    elevenlabs_retry_attempts: int = 3
    elevenlabs_retry_base_delay_s: float = 2.0
    elevenlabs_retry_max_delay_s: float = 30.0
    elevenlabs_retry_jitter_s: float = 0.5
    crm_webhook_internal_base_url: str = "http://127.0.0.1:8000"
    # Development mirror mode: show production live/webhook state read-only.
    live_mirror_enabled: bool = False
    live_mirror_base_url: str = ""
    live_mirror_timeout_s: int = 20
    live_mirror_auth_header: str = "x-api-token"
    live_mirror_auth_token: str = ""
    user_admin_emails: str = "adam@shinobigrp.com"
    user_seed_dev_viewer_emails: str = "eldad@shinobigrp.com"
    user_default_email: str = ""
    user_auto_provision_unknown: bool = True
    dev_sync_base_url: str = "https://shinobi.aleph-infinity.com"
    dev_sync_timeout_s: int = 25
    dev_sync_auth_header: str = "x-api-token"
    dev_sync_auth_token: str = ""

    model_config = {"env_file": str(Path(__file__).parent.parent.parent / ".env"), "extra": "ignore"}


settings = Settings()
