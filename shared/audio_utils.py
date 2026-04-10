"""Audio utility functions shared across stages."""
import tempfile
from pathlib import Path
from typing import List, Dict, Any, Optional

import soundfile as sf


def get_audio_duration(audio_path: str) -> float:
    """Return duration of audio in seconds."""
    info = sf.info(audio_path)
    if not info or not info.samplerate:
        return 0.0
    return info.frames / info.samplerate


def slice_audio_to_chunks(
    audio_path: str,
    chunk_seconds: int = 720,
    overlap_seconds: int = 20,
    temp_dir: str | Path | None = None,
) -> List[Dict[str, Any]]:
    """Slice audio into overlapping chunks, returning paths and offsets."""
    info = sf.info(audio_path)
    if not info or not info.samplerate:
        raise ValueError("Unable to read audio info for chunking")

    sr = info.samplerate
    total_frames = info.frames
    chunk_frames = int(chunk_seconds * sr)
    overlap_frames = int(overlap_seconds * sr)

    temp_dir = Path(temp_dir or tempfile.mkdtemp())
    temp_dir.mkdir(parents=True, exist_ok=True)

    chunks = []
    start_frame = 0
    idx = 0
    stem = Path(audio_path).stem

    while start_frame < total_frames:
        end_frame = min(total_frames, start_frame + chunk_frames)
        data, _ = sf.read(audio_path, start=start_frame, stop=end_frame)
        chunk_path = temp_dir / f"{stem}_chunk_{idx:03d}.wav"
        sf.write(chunk_path, data, sr)
        chunks.append({
            "path": chunk_path,
            "offset": start_frame / sr,
            "duration": (end_frame - start_frame) / sr,
        })
        if end_frame >= total_frames:
            break
        start_frame = end_frame - overlap_frames
        idx += 1

    return chunks
