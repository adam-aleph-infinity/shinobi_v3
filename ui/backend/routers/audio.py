import importlib
import json
import re as _re
import threading
import uuid
from datetime import datetime

from fastapi import APIRouter, Body, HTTPException, Query
from fastapi.responses import FileResponse
from pathlib import Path

from ui.backend.config import settings
from ui.backend.services.audio_service import get_audio_path, list_local_audio, list_all_pairs, list_audio_files, list_voice_profiles, get_pair_calls, delete_audio_file, delete_variant_file, list_s3_files, ensure_manifest, get_audio_versions, get_transcript_versions, get_audio_file_info, migrate_pair_to_new_structure, sync_all_pipeline_output

router = APIRouter(prefix="/audio", tags=["audio"])

# In-memory DNA job tracker
_dna_jobs: dict[str, dict] = {}

# ── Whisper tiny model (lazy singleton for language detection) ────────────────
_whisper_tiny = None
_whisper_tiny_lock = threading.Lock()


def _get_whisper_tiny():
    global _whisper_tiny
    if _whisper_tiny is None:
        with _whisper_tiny_lock:
            if _whisper_tiny is None:
                from faster_whisper import WhisperModel
                _whisper_tiny = WhisperModel("tiny", device="cpu", compute_type="int8")
    return _whisper_tiny


def _generate_speaker_combined_plot(wav_path: str, speaker_label: str, output_png: str) -> bool:
    """Generate waveform + mel-spectrogram + pitch (F0) plot for a single speaker's audio.
    Returns True on success, False if librosa unavailable."""
    try:
        import numpy as np
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        import matplotlib.gridspec as gridspec
        import librosa
        import librosa.display
    except ImportError:
        return False

    y, sr = librosa.load(wav_path, sr=None, mono=True)
    if len(y) == 0:
        return False
    duration = len(y) / sr

    fig = plt.figure(figsize=(13, 8), facecolor="#0d0d0d")
    gs = gridspec.GridSpec(3, 1, hspace=0.45, figure=fig)

    # ── 1. Waveform ───────────────────────────────────────────────
    ax1 = fig.add_subplot(gs[0])
    ax1.set_facecolor("#111827")
    t = np.linspace(0, duration, len(y))
    ax1.fill_between(t, y, alpha=0.75, color="#6366f1", linewidth=0)
    ax1.set_title(f"{speaker_label}  —  Waveform", color="#e5e7eb", fontsize=9, loc="left", pad=5)
    ax1.set_xlim(0, duration)
    ax1.set_ylabel("Amplitude", color="#6b7280", fontsize=7)
    ax1.tick_params(colors="#4b5563", labelsize=7)
    for s in ax1.spines.values(): s.set_edgecolor("#1f2937")

    # ── 2. Mel spectrogram ────────────────────────────────────────
    ax2 = fig.add_subplot(gs[1])
    ax2.set_facecolor("#111827")
    n_fft = min(2048, len(y) // 4) if len(y) > 8 else 256
    hop = n_fft // 4
    fmax = min(sr // 2, 8000)
    n_mels = min(80, fmax // 100)   # avoid empty filters on low-SR audio
    S = librosa.feature.melspectrogram(y=y, sr=sr, n_mels=n_mels, n_fft=n_fft, hop_length=hop, fmax=fmax)
    # Use 95th-percentile as reference so long silences don't wash the plot to black
    ref_val = float(np.percentile(S[S > 0], 95)) if (S > 0).any() else float(S.max())
    S_db = librosa.power_to_db(S, ref=max(ref_val, 1e-10))
    librosa.display.specshow(S_db, sr=sr, hop_length=hop, x_axis="time", y_axis="mel",
                             ax=ax2, cmap="magma", fmax=min(sr//2, 8000), vmin=-40, vmax=0)
    ax2.set_title("Mel Spectrogram", color="#e5e7eb", fontsize=9, loc="left", pad=5)
    ax2.set_ylabel("Freq (Hz)", color="#6b7280", fontsize=7)
    ax2.tick_params(colors="#4b5563", labelsize=7)
    for s in ax2.spines.values(): s.set_edgecolor("#1f2937")

    # ── 3. Pitch (F0) contour ─────────────────────────────────────
    ax3 = fig.add_subplot(gs[2])
    ax3.set_facecolor("#111827")
    try:
        f0, voiced_flag, _ = librosa.pyin(
            y, sr=sr,
            fmin=librosa.note_to_hz("C2"),
            fmax=librosa.note_to_hz("C6"),
            hop_length=hop,
        )
        t_f0 = librosa.times_like(f0, sr=sr, hop_length=hop)
        voiced = voiced_flag.astype(bool)
        ax3.scatter(t_f0[voiced], f0[voiced], s=1.5, color="#818cf8", alpha=0.6, linewidths=0)
        # Running median line
        if voiced.sum() > 10:
            import scipy.ndimage
            f0_filled = np.where(voiced, f0, np.nan)
            # interpolate nans for smoothing
            nans = np.isnan(f0_filled)
            xp = np.where(~nans)[0]
            fp = f0_filled[~nans]
            if len(xp) > 1:
                f0_interp = np.interp(np.arange(len(f0_filled)), xp, fp)
                smooth = scipy.ndimage.uniform_filter1d(f0_interp, size=max(1, len(f0_interp)//80))
                ax3.plot(t_f0, np.where(~nans, smooth, np.nan), color="#a5b4fc", linewidth=1, alpha=0.8)
    except Exception:
        pass
    ax3.set_title("Pitch (F0) Contour", color="#e5e7eb", fontsize=9, loc="left", pad=5)
    ax3.set_xlabel("Time (s)", color="#6b7280", fontsize=7)
    ax3.set_ylabel("Hz", color="#6b7280", fontsize=7)
    ax3.set_xlim(0, duration)
    ax3.tick_params(colors="#4b5563", labelsize=7)
    for s in ax3.spines.values(): s.set_edgecolor("#1f2937")

    plt.savefig(output_png, dpi=130, bbox_inches="tight", facecolor="#0d0d0d")
    plt.close(fig)
    return True


def _ensure_speaker_plots(report_path: Path, speaker_label: str, speaker_id: str, output_root: Path, generate: bool = True) -> dict:
    """Return per-speaker combined plot path. If generate=True, regenerates when missing or stale."""
    safe = _re.sub(r"[^\w]", "_", speaker_label.lower()).strip("_")
    plots_dir = report_path.parent / "plots"
    png = plots_dir / f"speaker_{safe}_combined.png"
    if generate:
        plots_dir.mkdir(exist_ok=True)
        stale = png.exists() and report_path.stat().st_mtime > png.stat().st_mtime
        if not png.exists() or stale:
            refined_dir = report_path.parent / "refined"
            wav_candidates = list(refined_dir.glob(f"refined_{speaker_id.lower()}.wav")) if refined_dir.exists() else []
            if not wav_candidates:
                idx = speaker_id.split("_")[-1] if "_" in speaker_id else "0"
                wav_candidates = list(refined_dir.glob(f"refined_speaker_{idx}.wav")) if refined_dir.exists() else []
            if wav_candidates:
                _generate_speaker_combined_plot(str(wav_candidates[0]), speaker_label, str(png))
    if png.exists():
        return {"combined": str(png.relative_to(output_root))}
    return {}


# ── Voice attribute inference ────────────────────────────────────────────────

def _infer_gender(acoustics: dict) -> dict:
    """Estimate gender from multiple acoustic features.

    Uses pitch median (more robust than mean against high-pitched outliers),
    spectral centroid, and zero-crossing rate — all available from librosa
    even without Parselmouth installed.

    Adult male F0 median:    80–170 Hz  (most men: 100–155 Hz)
    Adult female F0 median: 155–280 Hz  (most women: 185–230 Hz)
    Overlap zone:           155–175 Hz  — resolved by spectral features
    """
    # Prefer median over mean: more robust against excited speech / pitch errors
    pitch = float(acoustics.get("pitch_median_hz") or acoustics.get("pitch_mean_hz") or 0)
    spectral = float(acoustics.get("spectral_centroid_hz") or 0)
    zcr = float(acoustics.get("zero_crossing_rate") or 0)

    if pitch <= 0:
        return {"gender": "unknown", "confidence": 0.0}

    # Pitch score: +2 = clearly male, +1.5 = likely male, -1.5/-2 = female
    if pitch < 120:
        pitch_score = 2.0
    elif pitch < 155:
        pitch_score = 1.5
    elif pitch < 180:
        pitch_score = 0.5   # overlap zone — resolved by spectral features
    elif pitch < 215:
        pitch_score = -1.5
    else:
        pitch_score = -2.0

    # Spectral centroid: male speech typically 800–1500 Hz, female 1400–2200 Hz
    spectral_score = 0.0
    if spectral > 0:
        if spectral < 1300:
            spectral_score = 0.8
        elif spectral < 1600:
            spectral_score = 0.0
        else:
            spectral_score = -0.8

    # Zero-crossing rate: females typically higher (more high-freq energy)
    zcr_score = 0.0
    if zcr > 0:
        if zcr < 0.08:
            zcr_score = 0.4
        elif zcr < 0.12:
            zcr_score = 0.0
        else:
            zcr_score = -0.4

    total = pitch_score + spectral_score + zcr_score
    # Map to gender + confidence: 0.55 base + slope so clear signals hit ~0.90+
    conf = round(min(0.97, 0.55 + abs(total) * 0.13), 2)
    return {"gender": "male" if total >= 0 else "female", "confidence": conf}


def _infer_age(acoustics: dict) -> dict:
    """Estimate age range from acoustic biomarkers (jitter, shimmer, HNR, pitch variance)."""
    jitter    = float(acoustics.get("jitter_local") or 0)
    shimmer   = float(acoustics.get("shimmer_local") or 0)
    hnr       = float(acoustics.get("hnr_db") or 0)
    pitch_std = float(acoustics.get("pitch_std_hz") or 0)
    score = 0.0
    # HNR: higher = clearer/younger vocal tract
    if hnr > 15:   score -= 1.0
    elif hnr < 7:  score += 2.0
    elif hnr < 11: score += 0.8
    # Jitter: cycle-to-cycle F0 irregularity increases with age
    if jitter > 0.025: score += 3.0
    elif jitter > 0.015: score += 1.5
    elif jitter > 0.009: score += 0.5
    # Shimmer: amplitude irregularity
    if shimmer > 0.06:  score += 2.0
    elif shimmer > 0.035: score += 1.0
    # High pitch variability → younger / more expressive
    if pitch_std > 60: score -= 0.5
    if score < 1.5:
        return {"age_range": "20–35", "label": "Young adult"}
    elif score < 3.5:
        return {"age_range": "35–55", "label": "Middle-aged"}
    else:
        return {"age_range": "55+", "label": "Senior"}


def _detect_language_cached(wav_path: str, cache_path: Path) -> dict:
    """Detect spoken language via faster-whisper tiny; result cached to JSON."""
    if cache_path.exists():
        try:
            return json.loads(cache_path.read_text())
        except Exception:
            pass
    result: dict = {"language": "unknown", "language_probability": 0.0, "top_languages": []}
    try:
        model = _get_whisper_tiny()
        # language detected from encoder (30-second window) — don't need to iterate segments
        segments, info = model.transcribe(wav_path, beam_size=1, language=None, vad_filter=False)
        del segments  # don't consume generator
        top = sorted(
            [(k, round(float(v), 3)) for k, v in (info.all_language_probs or {}).items()],
            key=lambda x: -x[1],
        )[:5]
        result = {
            "language": info.language or "unknown",
            "language_probability": round(float(info.language_probability), 3),
            "top_languages": top,
        }
    except Exception as e:
        result["error"] = str(e)
    try:
        cache_path.write_text(json.dumps(result))
    except Exception:
        pass
    return result


def _ensure_voice_attributes(
    report_path: Path, speaker_label: str, speaker_id: str, acoustics: dict,
    detect_language: bool = True,
) -> dict:
    """Return gender, age estimate, and language detection for a speaker (cached).

    If detect_language=False, only returns cached language result (no Whisper inference).
    """
    safe = _re.sub(r"[^\w]", "_", speaker_label.lower()).strip("_")
    gender = _infer_gender(acoustics)
    age    = _infer_age(acoustics)
    lang_cache = report_path.parent / f"lang_{safe}.json"
    if lang_cache.exists():
        try:
            lang = json.loads(lang_cache.read_text())
        except Exception:
            lang = None
    elif detect_language:
        wav_path: str | None = None
        refined_dir = report_path.parent / "refined"
        if refined_dir.exists():
            idx = speaker_id.split("_")[-1] if "_" in speaker_id else "0"
            wavs = list(refined_dir.glob(f"refined_speaker_{idx}.wav"))
            if wavs:
                wav_path = str(wavs[0])
        lang = (_detect_language_cached(wav_path, lang_cache)
                if wav_path else {"language": "unknown", "language_probability": 0.0, "top_languages": []})
    else:
        lang = None
    return {"gender": gender, "age": age, "language": lang}


@router.get("/file/{call_id}")
def serve_audio(
    call_id: str,
    crm_url: str = Query(...),
    agent: str = Query(""),
    customer: str = Query(""),
):
    path = get_audio_path(crm_url, agent, customer, call_id)
    if not path:
        raise HTTPException(404, f"Audio file not found for call_id={call_id}")
    return FileResponse(
        path=str(path),
        media_type="audio/wav",
        headers={"Accept-Ranges": "bytes"},
    )


@router.get("/path/{call_id}")
def get_path(
    call_id: str,
    crm_url: str = Query(...),
    agent: str = Query(""),
    customer: str = Query(""),
):
    """Return local filesystem path for a downloaded audio file."""
    path = get_audio_path(crm_url, agent, customer, call_id)
    if not path:
        raise HTTPException(404, f"Audio file not found for call_id={call_id}")
    return {"path": str(path)}


@router.get("/status")
def audio_status(
    crm_url: str = Query(...),
    agent: str = Query(""),
    customer: str = Query(""),
):
    local = list_local_audio(crm_url, agent, customer)
    return local


@router.get("/pairs")
def get_pairs():
    """List all pair directories with downloaded audio."""
    try:
        return list_all_pairs()
    except Exception as e:
        raise HTTPException(500, str(e))


@router.get("/files")
def get_files(slug: str = Query(...)):
    """List audio files for a pair with pipeline status."""
    try:
        return list_audio_files(slug)
    except Exception as e:
        raise HTTPException(500, str(e))


@router.get("/calls")
def get_calls(slug: str = Query(...)):
    """All calls for a pair merged with local download status, sorted by date."""
    try:
        return get_pair_calls(slug)
    except Exception as e:
        raise HTTPException(500, str(e))


@router.delete("/file/{call_id}")
def remove_file(call_id: str, slug: str = Query(...)):
    """Delete a downloaded audio file (entire call directory)."""
    deleted = delete_audio_file(slug, call_id)
    if not deleted:
        raise HTTPException(404, "File not found")
    return {"deleted": True}


@router.delete("/variant")
def remove_variant(path: str = Query(...)):
    """Delete a single processed audio variant file (restricted to ui/data)."""
    deleted = delete_variant_file(path)
    if not deleted:
        raise HTTPException(404, "File not found or access denied")
    return {"deleted": True}


@router.get("/serve")
def serve_audio_path(path: str = Query(...)):
    """Serve any audio file by absolute path (restricted to project data dirs)."""
    p = Path(path).resolve()
    allowed = [settings.ui_data_dir.resolve(), settings.data_dir.resolve()]
    if not any(str(p).startswith(str(d)) for d in allowed):
        raise HTTPException(403, "Access denied")
    if not p.exists():
        raise HTTPException(404, "File not found")
    media = {".wav": "audio/wav", ".mp3": "audio/mpeg", ".m4a": "audio/mp4"}
    return FileResponse(path=str(p), media_type=media.get(p.suffix.lower(), "audio/wav"),
                        headers={"Accept-Ranges": "bytes"})


@router.get("/versions/{call_id}")
def get_versions(call_id: str, slug: str = Query(...)):
    """Return all available audio versions (original/converted/enhanced) for a call."""
    try:
        return get_audio_versions(slug, call_id)
    except Exception as e:
        raise HTTPException(500, str(e))


@router.get("/file-info")
def file_info(path: str = Query(...)):
    """Return technical metadata for an audio file."""
    p = Path(path).resolve()
    allowed = [settings.ui_data_dir.resolve(), settings.data_dir.resolve()]
    if not any(str(p).startswith(str(d)) for d in allowed):
        raise HTTPException(403, "Access denied")
    return get_audio_file_info(path)


@router.get("/transcripts/{call_id}")
def get_transcripts(call_id: str):
    """List all transcript files for a call_id across all pipeline jobs."""
    try:
        return get_transcript_versions(call_id)
    except Exception as e:
        raise HTTPException(500, str(e))


@router.get("/transcript-content")
def get_transcript_content(path: str = Query(...)):
    """Return text content of a transcript file (restricted to data dirs)."""
    p = Path(path).resolve()
    allowed = [settings.ui_data_dir.resolve(), settings.data_dir.resolve()]
    if not any(str(p).startswith(str(d)) for d in allowed):
        raise HTTPException(403, "Access denied")
    if not p.exists():
        raise HTTPException(404, "File not found")
    return {"content": p.read_text(encoding="utf-8", errors="replace"),
            "format": p.suffix.lstrip(".")}


@router.get("/s3-files")
def get_s3_files(
    crm_url: str = Query(...),
    account_id: str = Query(...),
    agent: str = Query(""),
    customer: str = Query(""),
):
    """List WAV files available in S3 for an account (no download)."""
    try:
        files = list_s3_files(crm_url, account_id)
        if agent and customer:
            ensure_manifest(agent, customer, crm_url, account_id)
        return files
    except Exception as e:
        raise HTTPException(500, str(e))


@router.get("/voice-profiles")
def get_voice_profiles():
    """Aggregate per-speaker stats from all pairs."""
    try:
        return list_voice_profiles()
    except Exception as e:
        raise HTTPException(500, str(e))


@router.get("/voice-dna")
def get_voice_dna(name: str = Query(..., description="Speaker name to look up")):
    """Return all voice DNA analyses for the given speaker name."""
    output_root = settings.ui_data_dir   # base for plot URL relativization & serving
    search_root = settings.agents_dir    # where per-agent voice DNA reports live
    results = []
    name_lower = name.lower()
    for report_path in sorted(search_root.rglob("voice_dna_report.json")):
        try:
            data = json.loads(report_path.read_text())
        except Exception:
            continue
        meta = data.get("metadata", {})
        speakers = [s.lower() for s in meta.get("speakers", [])]
        if not any(name_lower in s for s in speakers):
            continue
        plots_dir = report_path.parent / "plots"
        plot_urls: dict[str, str] = {}
        for fname in ("voice_dna_analysis.png", "spectrogram_detail.png", "speaker_timeline.png"):
            p = plots_dir / fname
            if p.exists():
                rel = str(p.relative_to(output_root))
                plot_urls[fname.replace(".png", "").replace("voice_dna_", "")] = rel
        # Extract per-speaker data and build per-speaker plots
        speaker_data = None
        speaker_id = None
        speaker_plots: dict[str, str] = {}
        for src_info in data.get("sources", {}).values():
            for spk in src_info.get("speakers", []):
                if name_lower in spk.get("speaker_label", "").lower():
                    speaker_id = spk.get("speaker_id", "")
                    speaker_data = {k: v for k, v in spk.items()
                                    if k not in ("embedding", "mfcc_means", "sample_segments")}
                    # Read existing per-speaker plots (never generate in GET — use DNA run for that)
                    speaker_plots = _ensure_speaker_plots(report_path, spk["speaker_label"], speaker_id, output_root, generate=False)
                    break
            if speaker_data:
                break
        voice_attributes = (
            _ensure_voice_attributes(report_path, spk["speaker_label"], speaker_id, speaker_data, detect_language=False)
            if speaker_data else {}
        )
        audio_path = meta.get("audio_path", "")
        call_id = Path(audio_path).stem if audio_path else report_path.parent.parent.name
        results.append({
            "call_id":          call_id,
            "job_dir":          report_path.parent.parent.name,
            "batch":            report_path.parent.parent.parent.name,
            "speakers":         meta.get("speakers", []),
            "plots":            plot_urls,
            "speaker_plots":    speaker_plots,
            "acoustics":        speaker_data,
            "speaker_id":       speaker_id,
            "voice_attributes": voice_attributes,
            "generated_at":     data.get("generated_at", ""),
        })
    return results


@router.get("/voice-dna-cross-call")
def get_voice_dna_cross_call(name: str = Query(..., description="Speaker name")):
    """Aggregate acoustic features across all calls for a speaker, for comparison charts."""
    search_root = settings.agents_dir    # where per-agent voice DNA reports live
    rows = []
    name_lower = name.lower()
    for report_path in sorted(search_root.rglob("voice_dna_report.json")):
        try:
            data = json.loads(report_path.read_text())
        except Exception:
            continue
        meta = data.get("metadata", {})
        speakers = [s.lower() for s in meta.get("speakers", [])]
        if not any(name_lower in s for s in speakers):
            continue
        audio_path = meta.get("audio_path", "")
        call_id = Path(audio_path).stem if audio_path else report_path.parent.parent.name
        generated_at = data.get("generated_at", "")
        date_str = generated_at[:10] if generated_at else ""
        for src_info in data.get("sources", {}).values():
            for spk in src_info.get("speakers", []):
                if name_lower in spk.get("speaker_label", "").lower():
                    rows.append({
                        "call_id": call_id,
                        "date": date_str,
                        "pitch_mean_hz": spk.get("pitch_mean_hz", 0),
                        "pitch_std_hz": spk.get("pitch_std_hz", 0),
                        "pitch_range_hz": spk.get("pitch_range_hz", 0),
                        "spectral_centroid_hz": spk.get("spectral_centroid_hz", 0),
                        "speaking_rate_est": spk.get("speaking_rate_est", 0),
                        "total_speaking_time_s": spk.get("total_speaking_time_s", 0),
                        "energy_rms": spk.get("energy_rms", 0),
                        "hnr_db": spk.get("hnr_db", 0),
                        "jitter_local": spk.get("jitter_local", 0),
                        "shimmer_local": spk.get("shimmer_local", 0),
                    })
                    break
    return rows


@router.get("/voice-dna-plot")
def serve_voice_dna_plot(path: str = Query(..., description="Relative path within ui/data/")):
    """Serve a voice DNA plot PNG from ui/data/."""
    output_root = settings.ui_data_dir
    resolved = (output_root / path).resolve()
    if not str(resolved).startswith(str(output_root.resolve())):
        raise HTTPException(400, "Path outside output directory")
    if not resolved.is_file() or resolved.suffix.lower() != ".png":
        raise HTTPException(404, "Plot not found")
    return FileResponse(str(resolved), media_type="image/png")


@router.post("/migrate/{agent}/{customer}")
def migrate_pair(agent: str, customer: str):
    """Migrate a pair's flat audio/ dir to the per-call structure."""
    try:
        moved = migrate_pair_to_new_structure(agent, customer)
        return {"moved": moved}
    except Exception as e:
        raise HTTPException(500, str(e))


@router.post("/sync-pipeline")
def sync_pipeline(background_tasks):
    """Import all pipeline output (data/output/) into ui/data/ structure."""
    from fastapi import BackgroundTasks
    background_tasks.add_task(sync_all_pipeline_output)
    return {"ok": True, "status": "sync started in background"}


@router.post("/sync-pipeline/run")
def sync_pipeline_sync():
    """Import all pipeline output synchronously. Returns counts."""
    try:
        return sync_all_pipeline_output()
    except Exception as e:
        raise HTTPException(500, str(e))


@router.get("/voice-dna-candidates")
def get_voice_dna_candidates(name: str = Query(..., description="Speaker name to find audio for")):
    """List all original audio files for a speaker (as agent or customer)."""
    ui_data = settings.agents_dir
    results = []
    name_lower = name.lower()
    if not ui_data.exists():
        return []
    for agent_dir in sorted(ui_data.iterdir()):
        if not agent_dir.is_dir() or agent_dir.name.startswith("."):
            continue
        for cust_dir in sorted(agent_dir.iterdir()):
            if not cust_dir.is_dir() or cust_dir.name.startswith("."):
                continue
            agent = agent_dir.name
            customer = cust_dir.name
            if name_lower not in agent.lower() and name_lower not in customer.lower():
                continue
            pair_slug = f"{agent}/{customer}"
            for call_dir in sorted(cust_dir.iterdir()):
                if not call_dir.is_dir():
                    continue
                call_id = call_dir.name
                audio_file = call_dir / "audio" / "original" / f"{call_id}.wav"
                if not audio_file.exists():
                    # Try any .wav in that dir
                    candidates = list((call_dir / "audio" / "original").glob("*.wav")) if (call_dir / "audio" / "original").exists() else []
                    if not candidates:
                        continue
                    audio_file = candidates[0]
                results.append({
                    "pair_slug": pair_slug,
                    "call_id": call_id,
                    "audio_path": str(audio_file),
                    "speaker_a": agent,
                    "speaker_b": customer,
                    "size_bytes": audio_file.stat().st_size,
                })
    return results


@router.post("/voice-dna-run")
def run_voice_dna(body: dict = Body(...)):
    """Run Stage 0101 voice DNA analysis on selected audio files. Returns job_id."""
    calls = body.get("calls", [])
    if not calls:
        raise HTTPException(400, "No calls specified")

    job_id = str(uuid.uuid4())[:8]
    _dna_jobs[job_id] = {"status": "running", "total": len(calls), "done": 0, "errors": []}

    def _run():
        import sys
        from concurrent.futures import ThreadPoolExecutor, as_completed
        from ui.backend.services import log_buffer as _lb
        sys.path.insert(0, str(settings.project_root))
        s0101 = importlib.import_module("stages.0101_audio_preprocessing.runner")
        from shared.models import StageManifest

        total = len(calls)
        _lb.emit(f"🧬 Voice DNA analysis started — {total} call(s) queued (parallel)")
        done_lock = threading.Lock()

        def _analyze_one(call):
            audio_path = call["audio_path"]
            call_id = call["call_id"]
            speaker_a = call.get("speaker_a", "Speaker A")
            speaker_b = call.get("speaker_b", "Speaker B")
            pair_slug = call.get("pair_slug", "")
            if "/" in pair_slug:
                agent_dir, cust_dir = pair_slug.split("/", 1)
                workspace = settings.agents_dir / agent_dir / cust_dir / call_id / "voice_dna"
            else:
                workspace = settings.ui_data_dir / "_voice_dna" / f"{call_id}"
            _lb.emit(f"🧬 Analyzing {call_id} ({speaker_a} / {speaker_b})")
            manifest = StageManifest.from_standalone(
                audio_path=audio_path,
                workspace_dir=str(workspace),
                speakers=(speaker_a, speaker_b),
            )
            try:
                s0101.run(manifest, interactive=False)
                _lb.emit(f"✅ Voice DNA complete: {call_id}")
                # Pre-warm caches so GET /voice-dna is instant for this call
                report_path = workspace / "0101_voice_dna" / "voice_dna_report.json"
                if report_path.exists():
                    try:
                        data = json.loads(report_path.read_text())
                        for src_info in data.get("sources", {}).values():
                            for spk in src_info.get("speakers", []):
                                if speaker_a.lower() in spk.get("speaker_label", "").lower():
                                    acoustics = {k: v for k, v in spk.items() if isinstance(v, (int, float))}
                                    spk_id = spk.get("speaker_id", "SPEAKER_0")
                                    _ensure_speaker_plots(report_path, spk["speaker_label"], spk_id, settings.ui_data_dir, generate=True)
                                    _ensure_voice_attributes(report_path, spk["speaker_label"], spk_id, acoustics, detect_language=True)
                                    break
                    except Exception:
                        pass
            except Exception as e:
                _dna_jobs[job_id]["errors"].append(f"{call_id}: {e}")
                _lb.emit(f"[ERROR] Voice DNA FAILED for {call_id}: {e}")
            finally:
                with done_lock:
                    _dna_jobs[job_id]["done"] += 1

        with ThreadPoolExecutor(max_workers=3) as executor:
            futures = [executor.submit(_analyze_one, call) for call in calls]
            for f in as_completed(futures):
                f.result()  # surface any unexpected exception

        _dna_jobs[job_id]["status"] = "complete"
        _lb.emit(f"🧬 Voice DNA analysis complete — {total} call(s) processed")

    threading.Thread(target=_run, daemon=True).start()
    return {"job_id": job_id}


@router.get("/voice-dna-status/{job_id}")
def get_voice_dna_status(job_id: str):
    """Poll status of a voice DNA analysis job."""
    job = _dna_jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    return job


@router.post("/voice-dna-composite")
def build_voice_composite(body: dict = Body(...)):
    """Build a composite voice profile by merging acoustic data from multiple analyzed calls.

    Weighted-averages all acoustic features (weight = speaking time), concatenates
    the refined speaker WAVs to produce a composite spectrogram, and re-infers
    gender/age/language from the merged acoustics.
    """
    speaker_name = body.get("speaker_name", "").strip()
    call_ids: list = body.get("call_ids", [])
    if not speaker_name or not call_ids:
        raise HTTPException(400, "speaker_name and call_ids are required")

    output_root = settings.ui_data_dir   # base for plot URL relativization & serving
    search_root = settings.agents_dir    # where per-agent voice DNA reports live
    name_lower = speaker_name.lower()
    call_ids_set = set(str(c) for c in call_ids)

    # ── Collect per-call acoustic data and refined WAV paths ─────────────────
    profiles: list[dict] = []
    wav_paths: list[str] = []
    agent_dir_name: str | None = None  # first agent dir found for this speaker

    for report_path in sorted(search_root.rglob("voice_dna_report.json")):
        try:
            data = json.loads(report_path.read_text())
        except Exception:
            continue
        audio_path = data.get("metadata", {}).get("audio_path", "")
        call_id = Path(audio_path).stem if audio_path else ""
        if call_id not in call_ids_set:
            continue
        for src_info in data.get("sources", {}).values():
            for spk in src_info.get("speakers", []):
                if name_lower not in spk.get("speaker_label", "").lower():
                    continue
                acoustics = {
                    k: v for k, v in spk.items()
                    if isinstance(v, (int, float)) and k != "embedding_dim"
                }
                if not acoustics:
                    continue
                if agent_dir_name is None:
                    try:
                        agent_dir_name = report_path.relative_to(search_root).parts[0]
                    except Exception:
                        pass
                profiles.append({"call_id": call_id, "speaker_id": spk.get("speaker_id", ""), "acoustics": acoustics})
                # Locate refined WAV for this speaker
                refined_dir = report_path.parent / "refined"
                if refined_dir.exists():
                    idx = spk.get("speaker_id", "SPEAKER_0").split("_")[-1]
                    wavs = list(refined_dir.glob(f"refined_speaker_{idx}.wav"))
                    if wavs:
                        wav_paths.append(str(wavs[0]))
                break  # one speaker match per source

    if not profiles:
        raise HTTPException(404, f"No analyzed DNA found for speaker '{speaker_name}' in call_ids {call_ids}")

    # ── Weighted-average acoustics (weight = total_speaking_time_s) ───────────
    merged: dict[str, float] = {}
    total_weight = 0.0
    for p in profiles:
        w = float(p["acoustics"].get("total_speaking_time_s") or 1.0)
        total_weight += w
        for k, v in p["acoustics"].items():
            merged[k] = merged.get(k, 0.0) + float(v) * w
    merged = {k: round(v / total_weight, 6) for k, v in merged.items()} if total_weight else merged

    # ── Composite spectrogram from concatenated refined WAVs ─────────────────
    composite_plot: str | None = None
    if wav_paths:
        try:
            import numpy as np
            import librosa
            import soundfile as sf
            import tempfile, os

            segments = []
            target_sr = 16000
            for wp in wav_paths[:6]:   # cap at 6 calls (~6 min max)
                y, _sr = librosa.load(wp, sr=target_sr, mono=True, duration=90)
                segments.append(y)

            combined = np.concatenate(segments)
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
                sf.write(tmp.name, combined, target_sr)
                tmp_path = tmp.name

            plots_dir = settings.agents_dir / (agent_dir_name or "_unassigned") / "_composite"
            plots_dir.mkdir(parents=True, exist_ok=True)
            safe = _re.sub(r"[^\w]", "_", speaker_name.lower()).strip("_")
            png = plots_dir / f"composite_{safe}_{len(profiles)}calls.png"
            label = f"{speaker_name}  —  composite ({len(profiles)} call{'s' if len(profiles) != 1 else ''})"
            _generate_speaker_combined_plot(tmp_path, label, str(png))
            os.unlink(tmp_path)
            if png.exists():
                composite_plot = str(png.relative_to(output_root))
        except Exception:
            pass   # composite plot is best-effort

    voice_attributes = _ensure_voice_attributes(
        report_path,           # last report_path found — only needed for lang cache dir
        speaker_name, profiles[-1]["speaker_id"], merged,
    ) if profiles else {}

    return {
        "speaker_name":   speaker_name,
        "call_ids":       [p["call_id"] for p in profiles],
        "call_count":     len(profiles),
        "acoustics":      merged,
        "voice_attributes": voice_attributes,
        "composite_plot": composite_plot,
    }
