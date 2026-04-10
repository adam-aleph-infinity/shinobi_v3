"""I/O utility functions."""
import json
from pathlib import Path
from typing import Any


def read_transcript_file(file_path: str) -> str:
    """Read a transcript file and return its content."""
    with open(file_path, "r") as f:
        return f.read()


def write_json(data: Any, path: str | Path) -> None:
    """Write data to a JSON file."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, indent=2)


def read_json(path: str | Path) -> Any:
    """Read a JSON file."""
    with open(path) as f:
        return json.load(f)


def ensure_dir(path: str | Path) -> Path:
    """Ensure a directory exists and return the Path."""
    p = Path(path)
    p.mkdir(parents=True, exist_ok=True)
    return p
