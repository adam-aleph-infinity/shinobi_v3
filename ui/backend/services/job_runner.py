"""
In-process job runner: ElevenLabs transcription (via S3 presigned URL) + LLM smoothing.
Streams stdout lines as SSE progress events via per-job asyncio queues.
"""
import asyncio
import json
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Optional

from sqlmodel import Session

from ui.backend.database import engine
from ui.backend.models.job import Job, JobStatus

_max_workers = 10
_executor = ThreadPoolExecutor(max_workers=_max_workers)


def get_max_workers() -> int:
    return _max_workers


def set_max_workers(n: int):
    """Resize the worker pool. Takes effect for jobs submitted after this call."""
    global _executor, _max_workers
    n = max(1, min(64, n))
    if n != _max_workers:
        _max_workers = n
        _executor = ThreadPoolExecutor(max_workers=n)

# Persist job log history to disk so logs survive server restarts
from ui.backend.config import settings as _settings
_JOB_LOG_DIR = _settings.ui_data_dir / "job_logs"
_JOB_LOG_DIR.mkdir(parents=True, exist_ok=True)


def _save_job_log(job_id: str, history: list) -> None:
    try:
        (_JOB_LOG_DIR / f"{job_id}.json").write_text(json.dumps(history))
    except Exception:
        pass


@dataclass
class _JobStream:
    history: list = field(default_factory=list)
    subscribers: list = field(default_factory=list)


_streams: dict[str, _JobStream] = {}
_job_context = threading.local()


class _JobContext:
    def __init__(self, job_id: str, loop: asyncio.AbstractEventLoop):
        self.job_id = job_id
        self.loop = loop

    def __enter__(self):
        _job_context.current = self
        _lb.set_job_context(self.job_id)
        return self

    def __exit__(self, *_):
        _job_context.current = None
        _lb.set_job_context(None)


def _emit_line(line: str):
    ctx = getattr(_job_context, "current", None)
    if ctx is not None:
        event = _parse_line(line)
        _broadcast(ctx.job_id, event, ctx.loop)


from ui.backend.services import log_buffer as _lb
if not hasattr(_lb, "_job_hooks"):
    _lb._job_hooks = []
if _emit_line not in _lb._job_hooks:
    _lb._job_hooks.append(_emit_line)


def _parse_line(line: str) -> dict:
    stage, pct, done = 0, 0, False
    lo = line.lower()
    if   "transcrib" in lo and "start" in lo:                stage, pct = 2, 10
    elif "elevenlabs" in lo and "scribe" in lo:               stage, pct = 2, 20
    elif "transcrib" in lo and ("✅" in line or "done" in lo): stage, pct = 2, 60
    elif "smooth" in lo and "start" in lo:                    stage, pct = 3, 65
    elif "smooth" in lo and ("✅" in line or "done" in lo):   stage, pct = 3, 90
    elif "pipeline complete" in lo:                           stage, pct, done = 3, 100, True
    return {"stage": stage, "pct": pct, "message": line, "done": done}


def _broadcast(job_id: str, event: dict, loop: asyncio.AbstractEventLoop):
    stream = _streams.get(job_id)
    if stream is None:
        return
    stream.history.append(event)
    for q in list(stream.subscribers):
        loop.call_soon_threadsafe(q.put_nowait, event)


# ── S3 presigned URL helper ────────────────────────────────────────────────────

_CRM_S3_BUCKETS = {
    "mlbcrm.io":  ("mlb-bucket-prod", "eu-west-2"),
    "brtcrm.io":  ("brt-production",  "eu-west-2"),
    "sfxcrm.io":  ("sfx-bucket-prod", "eu-west-2"),
}


def _s3_presigned_url(crm_url: str, record_path: str, expires: int = 3600) -> tuple[Optional[str], Optional[str]]:
    host = crm_url.replace("https://", "").replace("http://", "").split("/")[0]
    bucket_info = _CRM_S3_BUCKETS.get(host)
    if not bucket_info:
        return None, f"no S3 bucket configured for {host}"
    if not record_path:
        return None, "record_path is empty"
    bucket, region = bucket_info
    try:
        from shared.crm_download import load_aws_env
        load_aws_env()
        import boto3
        from botocore.config import Config
        s3 = boto3.client("s3", region_name=region, config=Config(signature_version="s3v4"))
        url = s3.generate_presigned_url(
            "get_object",
            Params={"Bucket": bucket, "Key": record_path},
            ExpiresIn=expires,
        )
        return url, None
    except Exception as e:
        return None, str(e)


# ── ElevenLabs transcription (inlined — no stages/ dependency) ─────────────────

def _transcribe_via_elevenlabs(audio_url: Optional[str], audio_path: Optional[str]) -> dict:
    """Call ElevenLabs Scribe v2. Returns raw JSON dict with words + text."""
    import os
    api_key = os.environ.get("ELEVENLABS_API_KEY")
    if not api_key:
        raise RuntimeError("ELEVENLABS_API_KEY not set")

    if audio_url:
        import requests
        resp = requests.post(
            "https://api.elevenlabs.io/v1/speech-to-text",
            data={
                "source_url": audio_url,
                "model_id": "scribe_v2",
                "diarize": "true",
                "tag_audio_events": "true",
                "timestamps_granularity": "word",
            },
            headers={"xi-api-key": api_key},
            timeout=300,
        )
        if not resp.ok:
            raise RuntimeError(f"ElevenLabs error {resp.status_code}: {resp.text[:300]}")
        return resp.json()
    elif audio_path and Path(audio_path).exists():
        from elevenlabs import ElevenLabs
        client = ElevenLabs(api_key=api_key)
        with open(audio_path, "rb") as f:
            response = client.speech_to_text.convert(
                file=f,
                model_id="scribe_v2",
                diarize=True,
                tag_audio_events=True,
                timestamps_granularity="word",
            )
        return {
            "text": getattr(response, "text", ""),
            "words": [w.__dict__ for w in getattr(response, "words", [])],
            "segments": [s.__dict__ for s in getattr(response, "segments", [])],
        }
    else:
        raise RuntimeError("No audio URL or valid local path provided")


def _el_json_to_text(data: dict) -> str:
    """Convert EL response JSON to readable speaker-labeled text with timestamps."""
    words = data.get("words", [])
    if not words:
        return data.get("text", "")

    def fmt_time(t: float) -> str:
        t = max(0, int(t))
        return f"{t // 60}:{t % 60:02d}"

    lines = []
    current_speaker: Optional[str] = None
    current_words: list = []
    segment_start = 0.0

    for w in words:
        spk = w.get("speaker_id") or w.get("speaker") or "SPEAKER"
        word = w.get("text", w.get("word", ""))
        t = float(w.get("start", 0) or 0)
        if spk != current_speaker:
            if current_words and current_speaker is not None:
                lines.append(f"[{fmt_time(segment_start)}] {current_speaker}: {' '.join(current_words)}")
            current_speaker = spk
            current_words = [word]
            segment_start = t
        else:
            current_words.append(word)
    if current_words and current_speaker is not None:
        lines.append(f"[{fmt_time(segment_start)}] {current_speaker}: {' '.join(current_words)}")
    return "\n".join(lines)


# ── Main job runner ────────────────────────────────────────────────────────────

def _run_job(
    job_id: str,
    audio_path: str,
    speaker_a: str,
    speaker_b: str,
    pair_slug: str,
    call_id: str,
    loop: asyncio.AbstractEventLoop,
    extra_config_json: Optional[str] = None,
):
    import sys
    sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent))

    cfg = json.loads(extra_config_json) if extra_config_json else {}
    crm_url = cfg.get("crm_url", "")
    record_path = cfg.get("record_path", audio_path)
    agent = cfg.get("agent", "")
    customer = cfg.get("customer", "")
    smooth_model = cfg.get("smooth_model", "gpt-5.4")

    # Derive agent/customer from pair_slug if not in cfg
    if not agent and "/" in pair_slug:
        parts = pair_slug.split("/", 1)
        agent, customer = parts[0], parts[1]

    with Session(engine) as db:
        job = db.get(Job, job_id)
        if job:
            job.status = JobStatus.running
            db.add(job)
            db.commit()

    try:
        with _JobContext(job_id, loop):
            # ── Step 1: Get audio URL or local path ──────────────────────────
            audio_url: Optional[str] = None
            if crm_url and record_path:
                print(f"[job/{job_id[:8]}] Generating S3 presigned URL for {record_path}…")
                audio_url, err = _s3_presigned_url(crm_url, record_path)
                if err:
                    print(f"[job/{job_id[:8]}] S3 error: {err} — will try local path")

            local_path = Path(audio_path) if audio_path else None
            if not audio_url and not (local_path and local_path.exists()):
                raise RuntimeError(
                    f"No audio available: S3 URL failed and local path "
                    f"{'not found' if local_path else 'not set'}"
                )

            # ── Step 2: ElevenLabs transcription ─────────────────────────────
            print(f"[job/{job_id[:8]}] ElevenLabs Scribe v2 transcription start — {'URL' if audio_url else 'local file'}…")
            el_data = _transcribe_via_elevenlabs(audio_url, str(local_path) if local_path else None)
            el_text = _el_json_to_text(el_data)
            print(f"[job/{job_id[:8]}] ElevenLabs transcription ✅ — {len(el_text)} chars")

            # Save EL JSON
            from ui.backend.config import settings
            call_dir = settings.agents_dir / agent / customer / call_id if (agent and customer) else None
            if call_dir:
                call_dir.mkdir(parents=True, exist_ok=True)
                el_dir = call_dir / "transcribed" / "elevenlabs"
                el_dir.mkdir(parents=True, exist_ok=True)
                el_json_path = el_dir / "original.json"
                el_json_path.write_text(json.dumps({
                    "engine": "elevenlabs",
                    "audio_type": "original",
                    "text": el_data.get("text", el_text),
                    "words": el_data.get("words", []),
                }, indent=2))
                print(f"[job/{job_id[:8]}] Saved EL JSON → {el_json_path}")

            # ── Step 3: LLM smoothing ─────────────────────────────────────────
            print(f"[job/{job_id[:8]}] LLM smooth start (model={smooth_model})…")
            from ui.backend.routers.final_transcript import _build_smooth_system, _llm_call, _ensure_timestamps
            system = _build_smooth_system(agent or speaker_a, customer or speaker_b)
            user = f"Transcript to clean up:\n\n{el_text}"
            raw_smooth = _llm_call(system, user, smooth_model)
            smoothed = _ensure_timestamps(el_text, raw_smooth)
            print(f"[job/{job_id[:8]}] LLM smoothing done ✅ — {len(smoothed)} chars")

            # Save smoothed transcript
            if call_dir:
                llm_dir = call_dir / "transcribed" / "llm_final"
                llm_dir.mkdir(parents=True, exist_ok=True)
                (llm_dir / "smoothed.txt").write_text(smoothed, encoding="utf-8")
                (llm_dir / "smoothed_meta.json").write_text(json.dumps({
                    "type": "smoothed",
                    "call_id": call_id,
                    "agent": agent,
                    "customer": customer,
                    "model": smooth_model,
                    "created_at": datetime.utcnow().isoformat(),
                }, indent=2))
                print(f"[job/{job_id[:8]}] Saved smoothed.txt → {llm_dir / 'smoothed.txt'}")

            print(f"[job/{job_id[:8]}] Pipeline complete ✅")

        with Session(engine) as db:
            job = db.get(Job, job_id)
            if job:
                job.status = JobStatus.complete
                job.pct = 100
                job.completed_at = datetime.utcnow()
                db.add(job)
                db.commit()

    except Exception as e:
        print(f"[job/{job_id[:8]}] ERROR: {e}")
        with Session(engine) as db:
            job = db.get(Job, job_id)
            if job:
                job.status = JobStatus.failed
                job.error = str(e)
                job.completed_at = datetime.utcnow()
                db.add(job)
                db.commit()
        _broadcast(job_id, {"stage": 0, "pct": 0, "message": f"ERROR: {e}", "done": True, "error": True}, loop)

    finally:
        _broadcast(job_id, {"stage": 3, "pct": 100, "message": "done", "done": True}, loop)
        # Persist to disk so logs are available after server restart
        stream = _streams.get(job_id)
        if stream:
            _save_job_log(job_id, stream.history)


def submit_job(job: Job, loop: asyncio.AbstractEventLoop) -> str:
    _streams[job.id] = _JobStream()
    _executor.submit(
        _run_job,
        job.id, job.audio_path, job.speaker_a, job.speaker_b,
        job.pair_slug, job.call_id, loop, job.extra_config,
    )
    return job.id


def get_stream(job_id: str) -> Optional[_JobStream]:
    return _streams.get(job_id)
