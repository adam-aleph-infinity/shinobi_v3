"""Transcript service — reads pipeline output directories."""
import json
from pathlib import Path
from typing import Optional

from ui.backend.config import settings

# Engine preference order when falling back to raw transcripts
_ENGINE_PREFERENCE = [
    "final_merged", "merged", "elevenlabs_original", "elevenlabs_enhanced",
    "deepgram", "assembly_ai", "whisper_large", "whisper_large_v3_turbo",
]


def get_job_dir(job_id: str) -> Optional[Path]:
    # Primary: look up manifest_path from DB (job dirs are named {call_id}_{hash}, not by UUID)
    try:
        from ui.backend.database import engine
        from sqlmodel import Session as _DBSession
        from ui.backend.models.job import Job as _JobModel
        _root = Path(__file__).parent.parent.parent.parent
        with _DBSession(engine) as _db:
            _job = _db.get(_JobModel, job_id)
            if _job and _job.manifest_path:
                manifest = _root / _job.manifest_path
                if manifest.exists():
                    return manifest.parent
    except Exception:
        pass
    # Fallback: search output_dir for a directory named job_id
    for d in settings.output_dir.rglob(job_id):
        if d.is_dir():
            return d
    return None


def get_transcript_sources(job_id: str) -> dict:
    job_dir = get_job_dir(job_id)
    if not job_dir:
        return {}
    transcripts_dir = job_dir / "02_transcripts"
    if not transcripts_dir.exists():
        return {}
    sources = {}
    for f in sorted(transcripts_dir.glob("*.json")):
        try:
            data = json.loads(f.read_text())
            words = data.get("words", [])
            segs = data.get("segments", [])
            text = data.get("text", "") or " ".join(w.get("word", "") for w in words)
            sources[f.stem] = {
                "engine": f.stem,
                "word_count": len(words) or len(text.split()),
                "segment_count": len(segs),
                "text_preview": text[:500],
                "path": str(f),
            }
        except Exception:
            pass
    return sources


def list_engine_transcripts(job_id: str) -> list[str]:
    """Return engine names from 02_transcripts (raw JSON outputs)."""
    job_dir = get_job_dir(job_id)
    if not job_dir:
        return []
    tx_dir = job_dir / "02_transcripts"
    if not tx_dir.exists():
        return []
    return [f.stem for f in sorted(tx_dir.glob("*.json"))]


def list_srt_variants(job_id: str) -> list[str]:
    """Return SRT variant names from 04_processed."""
    job_dir = get_job_dir(job_id)
    if not job_dir:
        return []
    processed = job_dir / "04_processed"
    if not processed.exists():
        return []
    return [f.stem for f in processed.glob("*.srt")]


def _json_to_srt(json_path: Path) -> Optional[str]:
    """Convert a 02_transcripts JSON file to SRT-like text."""
    try:
        data = json.loads(json_path.read_text())
        segments = data.get("segments", [])
        words = data.get("words", [])
        lines: list[str] = []

        if segments:
            for i, seg in enumerate(segments, 1):
                start = _fmt(seg.get("start", 0))
                end = _fmt(seg.get("end", 0))
                spk = seg.get("speaker", "")
                text = seg.get("text", "").strip()
                prefix = f"[{spk}]: " if spk else ""
                lines += [str(i), f"{start} --> {end}", f"{prefix}{text}", ""]
        elif words:
            chunk = 12
            for i in range(0, len(words), chunk):
                grp = words[i:i + chunk]
                start = _fmt(grp[0].get("start", 0))
                end = _fmt(grp[-1].get("end", 0))
                text = " ".join(w.get("word", "") for w in grp)
                lines += [str(i // chunk + 1), f"{start} --> {end}", text, ""]
        else:
            text = data.get("text", "")
            if not text:
                return None
            lines = ["1", "00:00:00,000 --> 99:59:59,000", text, ""]

        return "\n".join(lines) if lines else None
    except Exception:
        return None


def get_final_srt(job_id: str, variant: str = "final") -> Optional[dict]:
    job_dir = get_job_dir(job_id)
    if not job_dir:
        return None

    # 1. Try requested variant in 04_processed
    srt_path = job_dir / "04_processed" / f"{variant}.srt"
    if not srt_path.exists():
        # 2. Try any SRT in 04_processed
        srts = list((job_dir / "04_processed").glob("*.srt")) if (job_dir / "04_processed").exists() else []
        if srts:
            srt_path = srts[0]
        else:
            # 3. Fall back to best available engine JSON in 02_transcripts
            tx_dir = job_dir / "02_transcripts"
            if tx_dir.exists():
                # Try preferred engines first, then any
                candidates = [tx_dir / f"{e}.json" for e in _ENGINE_PREFERENCE]
                candidates += sorted(tx_dir.glob("*.json"))
                for cand in candidates:
                    if cand.exists():
                        srt_text = _json_to_srt(cand)
                        if srt_text:
                            return {
                                "srt_content": srt_text,
                                "entry_count": srt_text.count(" --> "),
                                "path": str(cand),
                                "variant": cand.stem,
                            }
            return None

    content = srt_path.read_text(encoding="utf-8")
    return {
        "srt_content": content,
        "entry_count": content.count(" --> "),
        "path": str(srt_path),
        "variant": srt_path.stem,
    }


def get_engine_srt(job_id: str, engine: str) -> Optional[str]:
    """Get raw text from a specific engine transcript."""
    job_dir = get_job_dir(job_id)
    if not job_dir:
        return None
    f = job_dir / "02_transcripts" / f"{engine}.json"
    if not f.exists():
        return None
    data = json.loads(f.read_text())
    segs = data.get("segments", [])
    if segs:
        lines = []
        for i, s in enumerate(segs, 1):
            spk = s.get("speaker", "?")
            text = s.get("text", "").strip()
            start = _fmt(s.get("start", 0))
            end = _fmt(s.get("end", 0))
            lines += [str(i), f"{start} --> {end}", f"[{spk}]: {text}", ""]
        return "\n".join(lines)
    words = data.get("words", [])
    return " ".join(w.get("word", "") for w in words)


def _fmt(s: float) -> str:
    h = int(s // 3600); m = int((s % 3600) // 60)
    sec = int(s % 60); ms = int((s % 1) * 1000)
    return f"{h:02d}:{m:02d}:{sec:02d},{ms:03d}"
