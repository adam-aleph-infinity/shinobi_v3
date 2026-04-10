"""Audio service — S3 downloads and local file management.

All data is stored in and read from ui/data/ exclusively.

Call data hierarchy:
  ui/data/{Agent}/{Customer}/
    manifest.json                   ← pair metadata (crm, account_id)
    calls.json                      ← full call list from CRM
    {call_id}/
      audio/
        original/                   ← downloaded from S3
          {call_id}.wav
        processed/                  ← pipeline-generated audio variants
          enhanced/
            {call_id}_enhanced.wav
          converted/
            {call_id}_converted.wav
          <variant>/                ← extensible for future variants
      transcribed/                  ← all transcript data
        final/                      ← merged / voted output
          transcript.srt
          transcript.txt
          voted_words.json
        {source}/                   ← full | speaker_0 | speaker_1 | merged
          {engine}/                 ← elevenlabs_original, mlx_whisper, …
            original.json           ← transcript of original audio
            enhanced.json
            converted.json

Pipeline output in data/output/ is the write target of the pipeline.
On first access the service auto-imports relevant files into ui/data/.
After that, data/output/ is never read again for that call.
"""
import json
import shutil
import subprocess
import sys
import wave
from datetime import datetime
from pathlib import Path
from typing import Optional

sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent))

from shared.crm_download import s3_download, slugify, load_aws_env, S3_BUCKETS
from ui.backend.config import settings

UI_DATA         = settings.ui_data_dir    # ui/data/
AGENTS_DIR      = settings.agents_dir    # ui/data/agents/ — per-agent data
LEGACY_DATA     = settings.data_dir       # data/  (legacy audio, read-only)
PIPELINE_OUTPUT = settings.output_dir     # data/output/  (pipeline write target)

_SKIP_DIRS       = {"audio", "_sync_tmp"}  # not call_id dirs inside a pair dir
_AUDIO_EXTS      = {".wav", ".mp3", ".m4a"}
_SOURCE_LABELS   = {
    "full": "Full Audio", "speaker_0": "Speaker 0",
    "speaker_1": "Speaker 1", "merged": "Merged",
}


# ── Path helpers ───────────────────────────────────────────────────────────────

def _pair_dir(agent: str, customer: str) -> Path:
    return AGENTS_DIR / agent / customer


def _find_pair_dir(agent: str, customer: str) -> Optional[Path]:
    """New hierarchy first, then legacy slugified fallback (read-only)."""
    new = _pair_dir(agent, customer)
    if new.exists():
        return new
    a_slug, c_slug = slugify(agent), slugify(customer)
    suffix = f"_{a_slug}_{c_slug}"
    if LEGACY_DATA.exists():
        for d in LEGACY_DATA.iterdir():
            if d.is_dir() and d.name.endswith(suffix):
                return d
    return None


def _call_dir(agent: str, customer: str, call_id: str) -> Path:
    return _pair_dir(agent, customer) / str(call_id)


def get_call_meta(pair_slug: str, call_id: str) -> dict:
    """Return {duration_s, started_at} for a call from calls.json, or empty dict."""
    parts = pair_slug.split("/", 1)
    if len(parts) != 2:
        return {}
    pair_dir = _pair_dir(parts[0], parts[1])
    calls_path = pair_dir / "calls.json"
    if not calls_path.exists():
        return {}
    try:
        for c in json.loads(calls_path.read_text()):
            if str(c.get("call_id", "")) == str(call_id):
                return {"duration_s": c.get("duration_s"), "started_at": c.get("started_at")}
    except Exception:
        pass
    return {}


def _call_audio_original(agent: str, customer: str, call_id: str) -> Path:
    return _call_dir(agent, customer, call_id) / "audio" / "original"


def _call_audio_processed(agent: str, customer: str, call_id: str, variant: str) -> Path:
    return _call_dir(agent, customer, call_id) / "audio" / "processed" / variant


def _call_transcribed(agent: str, customer: str, call_id: str) -> Path:
    return _call_dir(agent, customer, call_id) / "transcribed"


def _is_call_dir(d: Path) -> bool:
    return d.is_dir() and d.name not in _SKIP_DIRS and not d.name.startswith(".")


def _find_original(pair_dir: Path, call_id: str) -> Optional[Path]:
    """Find original audio — new hierarchy first, legacy flat fallback."""
    cid = str(call_id)
    for ext in _AUDIO_EXTS:
        p = pair_dir / cid / "audio" / "original" / f"{cid}{ext}"
        if p.exists():
            return p
    for ext in _AUDIO_EXTS:
        p = pair_dir / "audio" / f"{cid}{ext}"
        if p.exists():
            return p
    return None


def _enumerate_downloaded(pair_dir: Path) -> dict[str, Path]:
    """Return {call_id: original_path} for all locally stored originals."""
    result: dict[str, Path] = {}
    for d in pair_dir.iterdir():
        if not _is_call_dir(d):
            continue
        orig_dir = d / "audio" / "original"
        if orig_dir.exists():
            for ext in _AUDIO_EXTS:
                p = orig_dir / f"{d.name}{ext}"
                if p.exists():
                    result[d.name] = p
                    break
    # Legacy flat audio/ dir
    legacy = pair_dir / "audio"
    if legacy.exists():
        for f in legacy.iterdir():
            if f.suffix.lower() in _AUDIO_EXTS and f.stem not in result:
                result[f.stem] = f
    return result


# ── Migration: legacy flat → per-call structure ─────────────────────────────

def migrate_pair_to_new_structure(agent: str, customer: str) -> int:
    """Move legacy flat audio/{call_id}.wav → {call_id}/audio/original/{call_id}.wav."""
    pair_dir = _pair_dir(agent, customer)
    legacy_audio = pair_dir / "audio"
    if not legacy_audio.exists():
        return 0
    moved = 0
    for f in list(legacy_audio.iterdir()):
        if f.suffix.lower() not in _AUDIO_EXTS:
            continue
        cid = f.stem
        dest_dir = pair_dir / cid / "audio" / "original"
        dest = dest_dir / f.name
        if dest.exists():
            f.unlink()
            moved += 1
            continue
        dest_dir.mkdir(parents=True, exist_ok=True)
        shutil.move(str(f), str(dest))
        moved += 1
    try:
        legacy_audio.rmdir()
    except OSError:
        pass
    return moved


def _maybe_migrate(pair_dir: Path):
    """Silently migrate legacy flat audio/ on first access."""
    if (pair_dir / "audio").exists():
        migrate_pair_to_new_structure(pair_dir.parent.name, pair_dir.name)


# ── Pipeline → ui/data import ─────────────────────────────────────────────────

def _save_engine_transcripts(transcripts_dir: Path, agent: str, customer: str,
                              call_id: str, source: str,
                              force_audio_type: Optional[str] = None) -> int:
    """Copy engine JSON files from a pipeline 02_transcripts/ dir into
    ui/data/{agent}/{customer}/{call_id}/transcribed/{source}/{engine}/{audio_type}.json

    force_audio_type: if set, overrides the audio_type inferred from filename
    (needed when the job was run on a processed variant — converted/enhanced).
    """
    if not transcripts_dir.exists():
        return 0
    count = 0
    for f in sorted(transcripts_dir.glob("*.json")):
        engine_name = f.stem
        base_engine = engine_name
        audio_type = force_audio_type or "original"
        # Always strip engine-name suffixes to get base engine
        for suffix in ("_enhanced", "_converted", "_original"):
            if engine_name.endswith(suffix):
                base_engine = engine_name[: -len(suffix)]
                if not force_audio_type:
                    audio_type = suffix.lstrip("_")
                break
        dest = (_call_transcribed(agent, customer, str(call_id))
                / source / base_engine / f"{audio_type}.json")
        dest.parent.mkdir(parents=True, exist_ok=True)
        if not dest.exists():
            shutil.copy2(str(f), str(dest))
            count += 1
    return count


def save_pipeline_output_to_call(agent: str, customer: str,
                                  call_id: str, job_dir: Path) -> dict:
    """Import all pipeline outputs from job_dir into ui/data/{agent}/{customer}/{call_id}/."""
    cid = str(call_id)
    copied = {"audio": 0, "transcripts": 0}

    # ── Processed audio variants ──────────────────────────────────────────────
    pre_dir = job_dir / "01_preprocessed"
    if pre_dir.exists():
        for f in pre_dir.glob("*.wav"):
            for suffix, variant in [("_enhanced", "enhanced"), ("_converted", "converted")]:
                if f.stem.endswith(suffix):
                    dest_dir = _call_audio_processed(agent, customer, cid, variant)
                    dest_dir.mkdir(parents=True, exist_ok=True)
                    dest = dest_dir / f.name
                    if not dest.exists():
                        shutil.copy2(str(f), str(dest))
                        copied["audio"] += 1
                    break

    # ── Final / merged transcript ─────────────────────────────────────────────
    final_dir = job_dir / "04_processed"
    if final_dir.exists():
        dest_final = _call_transcribed(agent, customer, cid) / "final"
        dest_final.mkdir(parents=True, exist_ok=True)
        for src, dst in [("final.srt", "transcript.srt"),
                         ("text_only.txt", "transcript.txt"),
                         ("voted_words.json", "voted_words.json")]:
            fp = final_dir / src
            if fp.exists() and not (dest_final / dst).exists():
                shutil.copy2(str(fp), str(dest_final / dst))
                copied["transcripts"] += 1

    # Detect which audio variant this job processed (original / enhanced / converted)
    # so transcripts are saved as elevenlabs/converted.json instead of elevenlabs/original.json
    audio_variant: Optional[str] = None
    manifest_path = job_dir / "manifest.json"
    if manifest_path.exists():
        try:
            m = json.loads(manifest_path.read_text())
            ap = Path(m.get("audio_path", ""))
            stem = ap.stem.lower()
            if stem.endswith("_converted"):
                audio_variant = "converted"
            elif stem.endswith("_enhanced"):
                audio_variant = "enhanced"
        except Exception:
            pass

    # ── Engine transcripts ────────────────────────────────────────────────────
    sub_runs = job_dir / "sub_runs"
    if sub_runs.exists():
        # Batch / multi-mode pipeline: sub-runs per source
        for sub_run in sorted(sub_runs.iterdir()):
            if not sub_run.is_dir():
                continue
            sn = sub_run.name
            if sn.startswith("refined_speaker_0"):
                source = "speaker_0"
            elif sn.startswith("refined_speaker_1"):
                source = "speaker_1"
            else:
                source = "full"
            copied["transcripts"] += _save_engine_transcripts(
                sub_run / "02_transcripts", agent, customer, cid, source,
                force_audio_type=audio_variant)
    else:
        # Flat pipeline: single 02_transcripts/ directory
        copied["transcripts"] += _save_engine_transcripts(
            job_dir / "02_transcripts", agent, customer, cid, "full",
            force_audio_type=audio_variant)

    # ── Merged engine transcripts ─────────────────────────────────────────────
    merged_dir = job_dir / "merged" / "02_transcripts"
    if merged_dir.exists():
        copied["transcripts"] += _save_engine_transcripts(
            merged_dir, agent, customer, cid, "merged",
            force_audio_type=audio_variant)

    return copied


def _find_pair_for_job(job_dir: Path, call_id: str) -> Optional[tuple[str, str]]:
    """Determine (agent, customer) for a pipeline job directory.
    Strategy: audio_path under ui/data/ → scan ui/data/ call dirs → speakers list."""
    cid = str(call_id)
    m_path = job_dir / "manifest.json"
    if m_path.exists():
        try:
            m = json.loads(m_path.read_text())
            # 1. audio_path under agents_dir/ → parse directly
            audio_path = m.get("audio_path", "")
            if audio_path:
                ap = Path(audio_path)
                try:
                    rel = ap.relative_to(AGENTS_DIR)
                    parts = rel.parts
                    if len(parts) >= 2:
                        return (parts[0], parts[1])
                except ValueError:
                    pass
        except Exception:
            pass

    # 2. Scan agents_dir/ for a pair that already has this call_id dir
    if AGENTS_DIR.exists():
        for agent_dir in AGENTS_DIR.iterdir():
            if not agent_dir.is_dir() or agent_dir.name.startswith("."):
                continue
            for cust_dir in agent_dir.iterdir():
                if not cust_dir.is_dir() or cust_dir.name.startswith("."):
                    continue
                if (cust_dir / cid).is_dir():
                    return (agent_dir.name, cust_dir.name)

    return None


def _is_synced(agent: str, customer: str, call_id: str) -> bool:
    """True if this call already has any transcribed or processed data in ui/data/."""
    cid = str(call_id)
    trans = _call_transcribed(agent, customer, cid)
    if trans.exists() and any(trans.iterdir()):
        return True
    proc = _call_dir(agent, customer, cid) / "audio" / "processed"
    if proc.exists() and any(proc.rglob("*")):
        return True
    return False


def _auto_sync_call(call_id: str):
    """Scan pipeline output for jobs matching call_id and import into ui/data/."""
    if not PIPELINE_OUTPUT.exists():
        return
    cid = str(call_id)

    def _try_sync(job_dir: Path):
        pair = _find_pair_for_job(job_dir, cid)
        if pair and not _is_synced(pair[0], pair[1], cid):
            save_pipeline_output_to_call(pair[0], pair[1], cid, job_dir)

    for top in sorted(PIPELINE_OUTPUT.iterdir()):
        if not top.is_dir():
            continue
        if top.name.split("_")[0] == cid:
            _try_sync(top)
        else:
            for pair_d in top.iterdir():
                if not pair_d.is_dir():
                    continue
                for job_d in pair_d.iterdir():
                    if job_d.is_dir() and job_d.name.split("_")[0] == cid:
                        _try_sync(job_d)


def sync_all_pipeline_output() -> dict:
    """Import all pipeline output into ui/data/. Safe to run multiple times."""
    results: dict = {"synced": 0, "skipped": 0, "errors": []}
    if not PIPELINE_OUTPUT.exists():
        return results

    def _try_job(job_dir: Path):
        cid = job_dir.name.split("_")[0]
        pair = _find_pair_for_job(job_dir, cid)
        if not pair:
            results["skipped"] += 1
            return
        try:
            save_pipeline_output_to_call(pair[0], pair[1], cid, job_dir)
            results["synced"] += 1
        except Exception as e:
            results["errors"].append(f"{job_dir.name}: {e}")

    for top in sorted(PIPELINE_OUTPUT.iterdir()):
        if not top.is_dir():
            continue
        if (top / "manifest.json").exists():
            _try_job(top)
        else:
            for pair_d in top.iterdir():
                if not pair_d.is_dir():
                    continue
                for job_d in pair_d.iterdir():
                    if job_d.is_dir() and (job_d / "manifest.json").exists():
                        _try_job(job_d)
    return results


# ── Pipeline status (ui/data only) ────────────────────────────────────────────

def get_file_statuses() -> dict[str, str]:
    """Return {call_id: 'raw'|'enhanced'|'transcribed'} from ui/data/agents/ only."""
    statuses: dict[str, str] = {}
    if not AGENTS_DIR.exists():
        return statuses
    try:
        for final_dir in AGENTS_DIR.rglob("transcribed/final"):
            if final_dir.is_dir() and any(final_dir.iterdir()):
                call_id = final_dir.parent.parent.name
                statuses[call_id] = "transcribed"
        for source_dir in AGENTS_DIR.rglob("transcribed/*"):
            if source_dir.is_dir() and source_dir.name != "final":
                call_id = source_dir.parent.parent.name
                if call_id not in statuses:
                    statuses[call_id] = "transcribed"
        for proc in AGENTS_DIR.rglob("audio/processed"):
            if proc.is_dir() and any(proc.rglob("*")):
                call_id = proc.parent.parent.name
                if call_id not in statuses:
                    statuses[call_id] = "enhanced"
    except Exception:
        pass
    return statuses


def _call_status(pair_dir: Path, call_id: str) -> str:
    """Check status of a single call dir — O(1) path checks, no rglob."""
    call_dir = pair_dir / call_id
    transcribed = call_dir / "transcribed"
    if transcribed.exists():
        final = transcribed / "final"
        if final.exists() and any(final.iterdir()):
            return "transcribed"
        if any(d for d in transcribed.iterdir() if d.is_dir()):
            return "transcribed"
    processed = call_dir / "audio" / "processed"
    if processed.exists() and any(processed.iterdir()):
        return "enhanced"
    return "raw"


# ── Core audio helpers ─────────────────────────────────────────────────────────

def list_local_audio(crm_url: str, agent: str, customer: str) -> dict[str, dict]:
    pair_dir = _find_pair_dir(agent, customer)
    if not pair_dir:
        return {}
    _maybe_migrate(pair_dir)
    return {cid: {"call_id": cid, "path": str(p), "size_bytes": p.stat().st_size, "exists": True}
            for cid, p in _enumerate_downloaded(pair_dir).items()}


def get_audio_path(crm_url: str, agent: str, customer: str, call_id: str) -> Optional[Path]:
    pair_dir = _find_pair_dir(agent, customer)
    if not pair_dir:
        return None
    _maybe_migrate(pair_dir)
    return _find_original(pair_dir, call_id)


def get_audio_file_info(path: str) -> dict:
    p = Path(path)
    if not p.exists():
        return {}
    info: dict = {"size_bytes": p.stat().st_size, "format": p.suffix.lstrip(".").upper(),
                  "filename": p.name}
    if p.suffix.lower() == ".wav":
        try:
            with wave.open(str(p), "rb") as w:
                ch = w.getnchannels()
                fr = w.getframerate()
                nf = w.getnframes()
                info["channels"]          = ch
                info["channel_type"]      = "Stereo" if ch == 2 else "Mono"
                info["sample_rate_hz"]    = fr
                info["sample_rate_label"] = f"{fr / 1000:.1f} kHz"
                info["duration_s"]        = round(nf / fr, 2) if fr else None
                info["bit_depth"]         = w.getsampwidth() * 8
        except Exception:
            pass
    return info


# ── Audio versions (ui/data only, auto-syncs from pipeline on first access) ────

def get_audio_versions(slug: str, call_id: str) -> list[dict]:
    parts = slug.split("/", 1)
    if len(parts) != 2:
        return []
    agent, customer = parts
    cid = str(call_id)

    # Auto-import processed audio from pipeline output if not yet in ui/data
    pair_dir = _find_pair_dir(agent, customer)
    if pair_dir:
        _maybe_migrate(pair_dir)
        proc_dir = pair_dir / cid / "audio" / "processed"
        if not proc_dir.exists() or not any(proc_dir.rglob("*")):
            _auto_sync_call(cid)

    versions: list[dict] = []
    pair_dir = _find_pair_dir(agent, customer)
    if not pair_dir:
        return versions

    # Original
    for ext in _AUDIO_EXTS:
        p = pair_dir / cid / "audio" / "original" / f"{cid}{ext}"
        if p.exists():
            versions.append({"label": "Original", "path": str(p), "type": "original"})
            break

    # Processed variants (enhanced, converted, …)
    processed_dir = pair_dir / cid / "audio" / "processed"
    if processed_dir.exists():
        for vd in sorted(processed_dir.iterdir()):
            if not vd.is_dir():
                continue
            vname = vd.name
            for ext in _AUDIO_EXTS:
                p = vd / f"{cid}_{vname}{ext}"
                if p.exists():
                    versions.append({"label": vname.title(), "path": str(p), "type": vname})
                    break

    return versions


# ── Transcript versions (ui/data only, auto-syncs from pipeline on first access) ──

def get_transcript_versions(call_id: str) -> list[dict]:
    """Return all transcript entries for a call from ui/data/.
    Auto-imports from data/output/ on first access."""
    cid = str(call_id)

    # Auto-import if not yet synced
    _auto_sync_call(cid)

    results: list[dict] = []

    if not AGENTS_DIR.exists():
        return results

    for agent_dir in sorted(AGENTS_DIR.iterdir()):
        if not agent_dir.is_dir() or agent_dir.name.startswith("."):
            continue
        for cust_dir in sorted(agent_dir.iterdir()):
            if not cust_dir.is_dir() or cust_dir.name.startswith("."):
                continue
            transcribed_dir = cust_dir / cid / "transcribed"
            if not transcribed_dir.exists():
                continue

            for entry in sorted(transcribed_dir.iterdir()):
                if not entry.is_dir():
                    continue
                name = entry.name

                if name == "llm_final":
                    # LLM voted / smoothed transcripts — final_transcript.txt is highest priority
                    for fname, label in [
                        ("final_transcript.txt", "Final"),
                        ("smoothed.txt", "LLM Smoothed"),
                        ("voted.txt",    "LLM Voted"),
                    ]:
                        fp = entry / fname
                        if fp.exists():
                            results.append({
                                "batch": "ui", "job_id": cid,
                                "source": "llm_final", "source_label": "LLM Final",
                                "label": label, "type": fname.split(".")[0],
                                "engine": None, "audio_type": None,
                                "format": "txt", "path": str(fp),
                            })
                elif name == "final":
                    # Final merged output
                    for fname, label, fmt in [
                        ("transcript.srt", "Final SRT",   "srt"),
                        ("transcript.txt", "Plain Text",  "txt"),
                        ("voted_words.json","Voted Words","json"),
                    ]:
                        fp = entry / fname
                        if fp.exists():
                            results.append({
                                "batch": "ui", "job_id": cid,
                                "source": "final", "source_label": "Final",
                                "label": label, "type": fname.split(".")[0],
                                "engine": None, "audio_type": None,
                                "format": fmt, "path": str(fp),
                            })
                else:
                    # Source dirs: full, speaker_0, speaker_1, merged
                    source = name
                    source_label = _SOURCE_LABELS.get(source, source.replace("_", " ").title())
                    for engine_dir in sorted(entry.iterdir()):
                        if not engine_dir.is_dir():
                            continue
                        engine = engine_dir.name
                        for f in sorted(engine_dir.glob("*.json")):
                            audio_type = f.stem  # original, enhanced, converted
                            label = f"{engine.replace('_', ' ').title()} ({audio_type})"
                            results.append({
                                "batch": "ui", "job_id": cid,
                                "source": source, "source_label": source_label,
                                "label": label, "type": "engine",
                                "engine": engine, "audio_type": audio_type,
                                "format": "json", "path": str(f),
                            })

    return results


# ── S3 / download ──────────────────────────────────────────────────────────────

def ensure_manifest(agent: str, customer: str, crm_url: str, account_id: str):
    pair_dir = _pair_dir(agent, customer)
    manifest = pair_dir / "manifest.json"
    if not manifest.exists() and crm_url and account_id:
        pair_dir.mkdir(parents=True, exist_ok=True)
        manifest.write_text(json.dumps({"agent": agent, "customer": customer,
                                        "crm": crm_url, "account_id": int(account_id)}, indent=2))


def list_s3_files(crm_url: str, account_id: str) -> list[dict]:
    load_aws_env()
    crm_host = crm_url.replace("https://", "").replace("http://", "").strip("/")
    bucket = S3_BUCKETS.get(crm_host)
    if not bucket:
        return []
    s3_prefix = f"callRecords/accounts/{account_id}/"
    result = subprocess.run(["aws", "s3", "ls", f"s3://{bucket}/{s3_prefix}"],
                            capture_output=True, text=True)
    if result.returncode != 0:
        return []
    files = []
    for line in result.stdout.strip().splitlines():
        parts = line.split()
        if len(parts) >= 4 and parts[3].endswith(".wav"):
            files.append({"call_id": parts[3][:-4], "size_bytes": int(parts[2]),
                          "date": f"{parts[0]}T{parts[1]}"})
    return sorted(files, key=lambda x: x["date"], reverse=True)


def download_calls(crm_url: str, agent: str, customer: str,
                   account_id: str, call_ids: Optional[list[str]] = None) -> dict:
    """Download call recordings into ui/data/{agent}/{customer}/{call_id}/audio/original/."""
    from ui.backend.services import log_buffer as _lb
    load_aws_env()
    crm_host = crm_url.replace("https://", "").replace("http://", "").strip("/")
    bucket = S3_BUCKETS.get(crm_host)
    if not bucket:
        _lb.emit(f"[ERROR] Download: no S3 bucket configured for {crm_host}")
        return {"error": f"No S3 bucket configured for {crm_host}", "downloaded": 0, "failed": 0}

    s3_prefix = f"callRecords/accounts/{account_id}/"

    if call_ids:
        downloaded = failed = skipped = 0
        total = len(call_ids)
        _lb.emit(f"⬇️  Download started — {total} call(s) · {agent} / {customer}")
        for i, call_id in enumerate(call_ids, 1):
            orig_dir = _call_audio_original(agent, customer, str(call_id))
            dest = orig_dir / f"{call_id}.wav"
            if dest.exists():
                skipped += 1
                downloaded += 1
                continue
            orig_dir.mkdir(parents=True, exist_ok=True)
            _lb.emit(f"⬇️  [{i}/{total}] Downloading {call_id}…")
            r = subprocess.run(
                ["aws", "s3", "cp", f"s3://{bucket}/{s3_prefix}{call_id}.wav", str(dest)],
                capture_output=True)
            if r.returncode == 0:
                downloaded += 1
                _lb.emit(f"✅ [{i}/{total}] {call_id} downloaded")
            else:
                failed += 1
                err = r.stderr.decode(errors="replace").strip().splitlines()[-1] if r.stderr else "unknown error"
                _lb.emit(f"[ERROR] [{i}/{total}] {call_id} failed: {err}")
        _lb.emit(f"✅ Download complete — {downloaded - skipped} new, {skipped} already had, {failed} failed")
        return {"downloaded": downloaded, "failed": failed}

    # Full sync
    _lb.emit(f"⬇️  Full sync started — {agent} / {customer} from s3://{bucket}/{s3_prefix}")
    tmp_dir = _pair_dir(agent, customer) / "_sync_tmp"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    downloaded, failed = s3_download(bucket, s3_prefix, tmp_dir)
    for f in list(tmp_dir.glob("*.wav")):
        cid = f.stem
        orig_dir = _call_audio_original(agent, customer, cid)
        orig_dir.mkdir(parents=True, exist_ok=True)
        dest = orig_dir / f.name
        if not dest.exists():
            shutil.move(str(f), str(dest))
        else:
            f.unlink()
    try:
        tmp_dir.rmdir()
    except OSError:
        pass
    _lb.emit(f"✅ Full sync complete — {downloaded} downloaded, {failed} failed")
    return {"downloaded": downloaded, "failed": failed}


# ── Audio Library API helpers ──────────────────────────────────────────────────

def list_all_pairs() -> list[dict]:
    pairs = []
    if not AGENTS_DIR.exists():
        return pairs
    for agent_dir in sorted(AGENTS_DIR.iterdir()):
        if not agent_dir.is_dir() or agent_dir.name.startswith("."):
            continue
        for cust_dir in sorted(agent_dir.iterdir()):
            if not cust_dir.is_dir() or cust_dir.name.startswith("."):
                continue
            _maybe_migrate(cust_dir)
            downloaded = _enumerate_downloaded(cust_dir)
            has_calls = (cust_dir / "calls.json").exists()
            if not downloaded and not has_calls:
                continue
            crm = ""
            for fname in ("manifest.json", "calls.json"):
                fp = cust_dir / fname
                if fp.exists():
                    try:
                        d = json.loads(fp.read_text())
                        crm = (d[0].get("crm", "") if isinstance(d, list) and d
                               else d.get("crm", "") if isinstance(d, dict) else "")
                        if crm:
                            break
                    except Exception:
                        pass
            total_size = sum(p.stat().st_size for p in downloaded.values())
            pairs.append({"slug": f"{agent_dir.name}/{cust_dir.name}",
                          "agent": agent_dir.name, "customer": cust_dir.name,
                          "crm": crm, "audio_count": len(downloaded),
                          "total_size_bytes": total_size})
    return pairs


def list_audio_files(slug: str) -> list[dict]:
    parts = slug.split("/", 1)
    if len(parts) != 2:
        return []
    agent, customer = parts
    pair_dir = _pair_dir(agent, customer)
    if not pair_dir.exists():
        return []
    _maybe_migrate(pair_dir)
    calls_meta: dict[str, dict] = {}
    calls_path = pair_dir / "calls.json"
    if calls_path.exists():
        try:
            for c in json.loads(calls_path.read_text()):
                cid = str(c.get("call_id", ""))
                if cid:
                    calls_meta[cid] = c
        except Exception:
            pass
    return [{"call_id": cid, "path": str(f), "size_bytes": f.stat().st_size,
             "modified": datetime.fromtimestamp(f.stat().st_mtime).isoformat(),
             "duration_s": calls_meta.get(cid, {}).get("duration_s"),
             "started_at": calls_meta.get(cid, {}).get("started_at"),
             "status": _call_status(pair_dir, cid)}
            for cid, f in sorted(_enumerate_downloaded(pair_dir).items())]


def _lookup_pair_meta(agent_name: str, customer_name: str) -> dict:
    for cache_path in [UI_DATA / "all_crm_agents_customers.json",
                       LEGACY_DATA / "all_crm_agents_customers.json"]:
        if not cache_path.exists():
            continue
        try:
            for p in json.loads(cache_path.read_text()):
                if (p.get("agent", "").lower() == agent_name.lower() and
                        p.get("customer", "").lower() == customer_name.lower()):
                    return {"crm_url": p.get("crm", ""),
                            "account_id": str(p.get("account_id", ""))}
        except Exception:
            pass
    return {}


def get_pair_calls(slug: str) -> dict:
    empty = {"calls": [], "has_metadata": False, "crm_url": "", "account_id": "",
             "agent": "", "customer": ""}
    parts = slug.split("/", 1)
    if len(parts) != 2:
        return empty
    agent_name, customer_name = parts[0], parts[1]
    pair_dir = _pair_dir(agent_name, customer_name)
    _maybe_migrate(pair_dir)

    crm_url = account_id = ""
    manifest_path = pair_dir / "manifest.json"
    if manifest_path.exists():
        try:
            m = json.loads(manifest_path.read_text())
            crm_url    = m.get("crm", "")
            account_id = str(m.get("account_id", ""))
        except Exception:
            pass
    if not crm_url or not account_id:
        meta = _lookup_pair_meta(agent_name, customer_name)
        crm_url    = crm_url    or meta.get("crm_url", "")
        account_id = account_id or meta.get("account_id", "")

    downloaded_files = _enumerate_downloaded(pair_dir)

    calls_path = pair_dir / "calls.json"
    if calls_path.exists():
        try:
            raw_calls = json.loads(calls_path.read_text())
            if not crm_url and raw_calls:
                crm_url = raw_calls[0].get("crm", "")
            raw_calls.sort(key=lambda c: c.get("started_at", "") or "", reverse=True)
            calls = []
            for c in raw_calls:
                cid = str(c.get("call_id", ""))
                is_dl = cid in downloaded_files
                f = downloaded_files.get(cid)
                variant_files: list[dict] = []
                if is_dl and f:
                    variant_files.append({"name": "original", "path": str(f), "size_bytes": f.stat().st_size})
                    proc = pair_dir / cid / "audio" / "processed"
                    if proc.exists():
                        for vd in sorted(proc.iterdir()):
                            if not vd.is_dir():
                                continue
                            for ext in _AUDIO_EXTS:
                                vp = vd / f"{cid}_{vd.name}{ext}"
                                if vp.exists():
                                    variant_files.append({"name": vd.name, "path": str(vp), "size_bytes": vp.stat().st_size})
                                    break
                calls.append({"call_id": cid,
                               "date": c.get("started_at", ""),
                               "duration_s": c.get("duration_s") or c.get("duration", 0),
                               "downloaded": is_dl,
                               "path": str(f) if f else None,
                               "size_bytes": f.stat().st_size if f else None,
                               "status": _call_status(pair_dir, cid) if is_dl else None,
                               "record_path": c.get("record_path", ""),
                               "variant_files": variant_files})
            return {"calls": calls, "has_metadata": True,
                    "crm_url": crm_url, "account_id": account_id,
                    "agent": agent_name, "customer": customer_name}
        except Exception:
            pass

    def _get_variant_files(cid: str, orig_path: Path) -> list[dict]:
        vfs = [{"name": "original", "path": str(orig_path), "size_bytes": orig_path.stat().st_size}]
        proc = pair_dir / cid / "audio" / "processed"
        if proc.exists():
            for vd in sorted(proc.iterdir()):
                if not vd.is_dir():
                    continue
                for ext in _AUDIO_EXTS:
                    vp = vd / f"{cid}_{vd.name}{ext}"
                    if vp.exists():
                        vfs.append({"name": vd.name, "path": str(vp), "size_bytes": vp.stat().st_size})
                        break
        return vfs

    calls = [{"call_id": cid, "date": datetime.fromtimestamp(f.stat().st_mtime).isoformat(),
               "duration_s": None, "downloaded": True, "path": str(f),
               "size_bytes": f.stat().st_size, "status": _call_status(pair_dir, cid),
               "record_path": "", "variant_files": _get_variant_files(cid, f)}
             for cid, f in sorted(downloaded_files.items(),
                                   key=lambda x: x[1].stat().st_mtime, reverse=True)]
    return {"calls": calls, "has_metadata": False,
            "crm_url": crm_url, "account_id": account_id,
            "agent": agent_name, "customer": customer_name}


def delete_variant_file(path: str) -> bool:
    """Delete a single processed audio variant file (must be inside UI_DATA)."""
    p = Path(path).resolve()
    if not str(p).startswith(str(UI_DATA.resolve())):
        return False
    if not p.exists():
        return False
    p.unlink()
    # Remove empty parent dir (e.g. processed/enhanced/) if nothing left
    try:
        parent = p.parent
        if parent.is_dir() and not any(parent.iterdir()):
            parent.rmdir()
    except OSError:
        pass
    return True


def delete_audio_file(slug: str, call_id: str) -> bool:
    parts = slug.split("/", 1)
    if len(parts) != 2:
        return False
    agent, customer = parts
    call_dir = _pair_dir(agent, customer) / str(call_id)
    if call_dir.exists():
        shutil.rmtree(call_dir)
        return True
    # Legacy fallback
    for ext in _AUDIO_EXTS:
        f = _pair_dir(agent, customer) / "audio" / f"{call_id}{ext}"
        if f.exists():
            f.unlink()
            return True
    return False


def list_voice_profiles() -> list[dict]:
    speakers: dict[str, dict] = {}
    if not AGENTS_DIR.exists():
        return []
    for agent_dir in sorted(AGENTS_DIR.iterdir()):
        if not agent_dir.is_dir() or agent_dir.name.startswith("."):
            continue
        for cust_dir in sorted(agent_dir.iterdir()):
            if not cust_dir.is_dir() or cust_dir.name.startswith((".", "_")) or cust_dir.name == "personas":
                continue
            agent, customer = agent_dir.name, cust_dir.name
            call_count = total_duration = 0
            crm_str = ""
            calls_path = cust_dir / "calls.json"
            if calls_path.exists():
                try:
                    raw = json.loads(calls_path.read_text())
                    if raw and isinstance(raw, list):
                        crm_str = raw[0].get("crm", "")
                        call_count = len(raw)
                        total_duration = sum(c.get("duration_s", 0) or 0 for c in raw)
                except Exception:
                    pass
            if call_count == 0:
                call_count = len(_enumerate_downloaded(cust_dir))
            slug = f"{agent}/{customer}"
            for name, role in [(agent, "agent"), (customer, "customer")]:
                if name not in speakers:
                    speakers[name] = {"name": name, "role": role, "pairs": [],
                                      "call_count": 0, "total_duration_s": 0, "crm": crm_str}
                speakers[name]["pairs"].append(slug)
                speakers[name]["call_count"] += call_count
                speakers[name]["total_duration_s"] += total_duration
    return sorted(speakers.values(), key=lambda s: (s["role"], s["name"]))


def get_transcription_jobs_for_pair(pair_slug: str, output_root: Path) -> list[dict]:
    jobs = []
    for job_dir in output_root.glob(f"*{pair_slug}*/*"):
        final_srt = job_dir / "04_processed" / "final.srt"
        manifest  = job_dir / "manifest.json"
        if final_srt.exists():
            meta = {}
            if manifest.exists():
                try:
                    meta = json.loads(manifest.read_text())
                except Exception:
                    pass
            jobs.append({"job_id": job_dir.name, "batch": job_dir.parent.name,
                         "final_srt": str(final_srt), "manifest": meta})
    return jobs
