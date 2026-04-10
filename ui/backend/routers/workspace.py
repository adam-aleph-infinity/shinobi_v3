"""
Workspace router — exposes ui/data/ as a browsable file system.
All paths are relative to ui/data/ and sandboxed within it.
"""
import json
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse

from ui.backend.config import settings

router = APIRouter(prefix="/workspace", tags=["workspace"])

DATA_ROOT = settings.ui_data_dir   # ui/data/

TEXT_EXTS  = {".json", ".srt", ".txt", ".md", ".log", ".csv"}
AUDIO_EXTS = {".wav", ".mp3", ".m4a", ".ogg"}
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif"}

# Directories that live inside a pair dir but are NOT call_id subdirs
_PAIR_NON_CALL_DIRS = {"audio", "_sync_tmp"}


def _safe_path(rel: str) -> Path:
    p = (DATA_ROOT / rel).resolve()
    if not str(p).startswith(str(DATA_ROOT.resolve())):
        raise HTTPException(400, "Path outside data directory")
    return p


def _depth(p: Path) -> int:
    """Depth relative to DATA_ROOT. Root=0, Agent=1, Customer/Pair=2, Call=3."""
    return len(p.relative_to(DATA_ROOT).parts)


def _file_info(p: Path, root: Path) -> dict:
    stat = p.stat()
    ext = p.suffix.lower()
    kind = ("audio" if ext in AUDIO_EXTS else
            "text"  if ext in TEXT_EXTS  else
            "image" if ext in IMAGE_EXTS else
            "dir"   if p.is_dir() else "file")
    return {
        "name":     p.name,
        "path":     str(p.relative_to(root)),
        "type":     kind,
        "ext":      ext,
        "size":     stat.st_size if p.is_file() else None,
        "modified": datetime.fromtimestamp(stat.st_mtime).isoformat(),
        "is_dir":   p.is_dir(),
    }


def _call_summary(call_dir: Path) -> dict:
    """Return what's available inside a {call_id}/ directory."""
    orig_dir = call_dir / "audio" / "original"
    proc_dir = call_dir / "audio" / "processed"
    trans_dir = call_dir / "transcribed"

    has_original = False
    orig_size = None
    if orig_dir.exists():
        for f in orig_dir.iterdir():
            if f.is_file() and f.suffix.lower() in AUDIO_EXTS:
                has_original = True
                orig_size = f.stat().st_size
                break

    processed_variants: list[str] = []
    if proc_dir.exists():
        for vd in sorted(proc_dir.iterdir()):
            if vd.is_dir() and any(f.is_file() for f in vd.iterdir()):
                processed_variants.append(vd.name)

    # New nested structure: transcribed/{source}/{engine}/*.json
    # source dirs: full, speaker_0, speaker_1, merged, final
    transcript_engines: list[str] = []
    transcript_sources: list[str] = []
    has_final = False
    if trans_dir.exists():
        for source_dir in sorted(trans_dir.iterdir()):
            if not source_dir.is_dir():
                continue
            if source_dir.name == "final":
                has_final = any(source_dir.iterdir())
            else:
                # Source dir contains engine subdirs
                for engine_dir in sorted(source_dir.iterdir()):
                    if engine_dir.is_dir() and any(engine_dir.glob("*.json")):
                        if source_dir.name not in transcript_sources:
                            transcript_sources.append(source_dir.name)
                        if engine_dir.name not in transcript_engines:
                            transcript_engines.append(engine_dir.name)

    return {
        "kind":                 "call",
        "has_original":         has_original,
        "orig_size":            orig_size,
        "processed_variants":   processed_variants,
        "transcript_engines":   transcript_engines,
        "transcript_sources":   transcript_sources,
        "has_final_transcript": has_final,
    }


def _count_calls(pair_dir: Path) -> int:
    """Count call_id subdirectories in a pair (customer) dir."""
    if not pair_dir.exists():
        return 0
    return sum(1 for d in pair_dir.iterdir()
               if d.is_dir() and not d.name.startswith(".")
               and d.name not in _PAIR_NON_CALL_DIRS)


@router.get("")
def list_workspace():
    """List Agent folders in ui/data/agents/ with customer & call counts."""
    agents_root = settings.agents_dir
    entries = []
    if not agents_root.exists():
        return entries
    for p in sorted(agents_root.iterdir()):
        if p.name.startswith(".") or not p.is_dir():
            continue
        info = _file_info(p, DATA_ROOT)
        customers = [c for c in p.iterdir()
                     if c.is_dir() and not c.name.startswith(".")]
        total_calls = sum(_count_calls(c) for c in customers)
        info["kind"]           = "agent"
        info["customer_count"] = len(customers)
        info["file_count"]     = total_calls   # shows "N calls" in sidebar
        entries.append(info)
    return entries


@router.get("/browse")
def browse(path: str = Query("", description="Relative path within ui/data/")):
    """List files/folders at a given path with context-aware metadata."""
    p = _safe_path(path) if path else DATA_ROOT
    if not p.exists():
        raise HTTPException(404, f"Path not found: {path}")
    if p.is_file():
        raise HTTPException(400, "Path is a file, not a directory")

    entries = []
    parent_has_manifest = (p / "manifest.json").exists()   # we're in a pair dir

    for child in sorted(p.iterdir(), key=lambda x: (not x.is_dir(), x.name.lower())):
        if child.name.startswith("."):
            continue
        info = _file_info(child, DATA_ROOT)

        if child.is_dir():
            depth = _depth(child)

            if depth == 1:
                # Agent dir: show customer count
                customers = [c for c in child.iterdir()
                             if c.is_dir() and not c.name.startswith(".")]
                info["kind"]           = "agent"
                info["customer_count"] = len(customers)
                info["file_count"]     = sum(_count_calls(c) for c in customers)

            elif depth == 2:
                # Customer / pair dir: show call count + manifest metadata
                manifest = child / "manifest.json"
                if manifest.exists():
                    try:
                        m = json.loads(manifest.read_text())
                        info["agent"]    = m.get("agent", "")
                        info["customer"] = m.get("customer", "")
                        info["crm"]      = m.get("crm", "")
                        info["kind"]     = "pair"
                    except Exception:
                        info["kind"] = "folder"
                else:
                    info["kind"] = "folder"
                info["file_count"] = _count_calls(child)

            elif depth == 3 and parent_has_manifest and child.name not in _PAIR_NON_CALL_DIRS:
                # Call ID dir: show content summary badges
                info.update(_call_summary(child))
                info["size"] = info.get("orig_size")   # show original wav size

            else:
                # Deeper dirs (audio/, processed/, transcribed/, engine dirs, etc.)
                info["file_count"] = sum(1 for _ in child.iterdir()
                                         if not _.name.startswith("."))

        entries.append(info)

    parent_rel = str(p.relative_to(DATA_ROOT)) if p != DATA_ROOT else None
    return {
        "path":    str(p.relative_to(DATA_ROOT)) if p != DATA_ROOT else "",
        "parent":  str(Path(parent_rel).parent)
                   if parent_rel and Path(parent_rel).parent != Path(".") else None,
        "entries": entries,
    }


@router.get("/preview")
def preview(path: str = Query(...)):
    """Return text content of a previewable file (max 200KB)."""
    p = _safe_path(path)
    if not p.is_file():
        raise HTTPException(404, "File not found")
    if p.suffix.lower() not in TEXT_EXTS:
        raise HTTPException(400, f"Preview not supported for {p.suffix} files")
    content = p.read_bytes()[:2_000_000].decode("utf-8", errors="replace")
    return {"path": path, "content": content, "size": p.stat().st_size}


@router.get("/download")
def download(path: str = Query(...)):
    """Serve a file for download/playback."""
    p = _safe_path(path)
    if not p.is_file():
        raise HTTPException(404, "File not found")
    ext = p.suffix.lower()
    media = ("audio/wav"  if ext == ".wav" else
             "audio/mpeg" if ext == ".mp3" else
             "application/octet-stream")
    return FileResponse(str(p), media_type=media, filename=p.name,
                        headers={"Accept-Ranges": "bytes"})
