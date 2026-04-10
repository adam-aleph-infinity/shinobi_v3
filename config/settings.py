"""Central configuration for the pipeline."""
import os
from dataclasses import dataclass, field
from typing import Optional, Dict, Any, Tuple
from dotenv import load_dotenv


@dataclass
class PipelineConfig:
    """Pipeline configuration with layered loading: defaults -> .env -> CLI overrides."""
    # API Keys
    openai_api_key: str = ""
    elevenlabs_api_key: str = ""
    gemini_api_key: str = ""
    grok_api_key: str = ""
    mistral_api_key: str = ""

    # LLM settings
    llm_provider: str = "openai"  # "openai" | "grok" | "gemini"
    voting_model: str = "gpt-4o-mini"
    merge_model: str = "gpt-4o"

    # Audio chunking
    chunk_max_duration_seconds: int = 1400
    chunk_target_seconds: int = 720
    chunk_overlap_seconds: int = 20

    # Processing
    confidence_threshold: float = 0.3
    voting_batch_size: int = 50

    # Audio preprocessing
    voice_isolation: bool = False
    vad_trim: bool = False
    audio_restore: bool = False
    isolation_device: str = "cpu"

    # Output
    verbose: bool = True


def load_config(cli_overrides: Optional[Dict[str, Any]] = None) -> PipelineConfig:
    """Load config: defaults -> env vars -> CLI overrides."""
    load_dotenv()
    config = PipelineConfig()

    env_map = {
        "OPENAI_API_KEY": "openai_api_key",
        "ELEVENLABS_API_KEY": "elevenlabs_api_key",
        "GEMINI_API_KEY": "gemini_api_key",
        "MISTRAL_API_KEY": "mistral_api_key",
    }
    for env_key, attr in env_map.items():
        val = os.environ.get(env_key)
        if val:
            setattr(config, attr, val)

    # Grok has multiple possible env var names
    config.grok_api_key = (
        config.grok_api_key
        or os.environ.get("GROK_API_KEY", "")
        or os.environ.get("XAI_API_KEY", "")
        or os.environ.get("xAi_API", "")
        or os.environ.get("XAI_API", "")
    )

    if cli_overrides:
        for key, val in cli_overrides.items():
            if val is not None and hasattr(config, key):
                setattr(config, key, val)

    return config
