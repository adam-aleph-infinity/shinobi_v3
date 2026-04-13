"""
Transcription process router — job-based ElevenLabs-only transcription.

Endpoints:
  POST /transcription/jobs          — create a transcription job (CRM call → EL → smooth)
  GET  /transcription/jobs          — list jobs (filtered by agent/customer)
  GET  /transcription/jobs/{job_id} — job status
  POST /transcription/smooth        — one-shot LLM smooth of an existing EL transcript
"""
import asyncio
import json
import uuid
from datetime import datetime
from pathlib import Path
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlmodel import Session, select

from ui.backend.config import settings
from ui.backend.database import engine, get_session
from ui.backend.models.job import Job, JobStatus
from ui.backend.services import job_runner

router = APIRouter(prefix="/transcription", tags=["transcription"])


# ── Request models ─────────────────────────────────────────────────────────────

class CreateJobRequest(BaseModel):
    crm_url: str
    account_id: str = ""
    agent: str
    customer: str
    call_id: str
    record_path: str                 # S3 key (relative path within the CRM bucket)
    speaker_a: str = "SPEAKER_00"
    speaker_b: str = "SPEAKER_01"
    smooth_model: str = "gpt-5.4"


class SmoothRequest(BaseModel):
    agent: str
    customer: str
    call_id: str
    model: str = "gpt-5.4"          # LLM to use for smoothing


class PairSpec(BaseModel):
    crm_url: str
    account_id: str
    agent: str
    customer: str


class BatchPairsRequest(BaseModel):
    pairs: List[PairSpec]
    smooth_model: str = "gpt-5.4"
    speaker_a: str = "SPEAKER_00"
    speaker_b: str = "SPEAKER_01"


# ── Job creation ───────────────────────────────────────────────────────────────

@router.post("/jobs")
async def create_transcription_job(req: CreateJobRequest, db: Session = Depends(get_session)):
    """Create an ElevenLabs transcription job for a single CRM call recording."""
    # Prevent duplicate: skip if a pending/running job already exists for this exact pair+call
    pair_slug_check = f"{req.agent}/{req.customer}"
    existing = db.exec(
        select(Job)
        .where(Job.call_id == req.call_id)
        .where(Job.pair_slug == pair_slug_check)
        .where(Job.status.in_([JobStatus.pending, JobStatus.running]))
    ).first()
    if existing:
        return {"job_id": existing.id, "status": existing.status, "duplicate": True}

    extra = {
        "crm_url": req.crm_url,
        "account_id": req.account_id,
        "agent": req.agent,
        "customer": req.customer,
        "record_path": req.record_path,
        "smooth_model": req.smooth_model,
    }
    pair_slug = f"{req.agent}/{req.customer}"
    job = Job(
        id=str(uuid.uuid4()),
        audio_path=req.record_path,   # stored for reference; actual audio via S3 URL
        pair_slug=pair_slug,
        call_id=req.call_id,
        speaker_a=req.speaker_a,
        speaker_b=req.speaker_b,
        status=JobStatus.pending,
        extra_config=json.dumps(extra),
    )
    db.add(job)
    db.commit()
    db.refresh(job)

    loop = asyncio.get_running_loop()
    job_runner.submit_job(job, loop)
    return {"job_id": job.id, "status": job.status}


# ── Batch transcription for multiple agent/customer pairs ─────────────────────

@router.post("/batch-for-pairs")
async def batch_transcribe_pairs(req: BatchPairsRequest):
    """Queue ElevenLabs transcription jobs for all untranscribed calls across selected pairs.

    For each pair: fetches calls (lazy-loads from CRM if needed), skips calls that
    already have smoothed.txt or voted.txt, and submits a job for each remaining call.
    Up to 8 pairs are processed concurrently. All jobs share a batch_id for UI grouping.
    """
    from ui.backend.services.crm_service import get_calls as _get_calls

    loop = asyncio.get_running_loop()
    submitted = 0
    skipped = 0
    job_ids: list[str] = []
    # One batch_id groups all jobs from this request in the UI queue
    batch_id = str(uuid.uuid4())

    # Process pairs with limited concurrency (CRM fetch can be slow on first access)
    sem = asyncio.Semaphore(8)

    async def _process_pair(spec: PairSpec):
        nonlocal submitted, skipped
        async with sem:
            try:
                calls = await loop.run_in_executor(
                    None,
                    lambda: _get_calls(
                        account_id=spec.account_id,
                        crm_url=spec.crm_url,
                        agent=spec.agent,
                        customer=spec.customer,
                    ),
                )
                pair_slug = f"{spec.agent}/{spec.customer}"
                # Each pair gets its own session to avoid shared-session state issues
                with Session(engine) as pair_db:
                    for c in calls:
                        record_path = c.get("record_path", "")
                        call_id = str(c.get("call_id", ""))
                        if not record_path or not call_id:
                            skipped += 1
                            continue
                        # Skip already transcribed
                        llm_dir = (
                            settings.agents_dir / spec.agent / spec.customer
                            / call_id / "transcribed" / "llm_final"
                        )
                        if (llm_dir / "smoothed.txt").exists() or (llm_dir / "voted.txt").exists():
                            skipped += 1
                            continue
                        # Skip if a pending/running job exists for this exact pair+call.
                        # Must include pair_slug — different agents can share the same
                        # account's call IDs, so checking call_id alone would cause
                        # pair B's calls to be skipped by pair A's jobs.
                        in_flight = pair_db.exec(
                            select(Job)
                            .where(Job.call_id == call_id)
                            .where(Job.pair_slug == pair_slug)
                            .where(Job.status.in_([JobStatus.pending, JobStatus.running]))
                        ).first()
                        if in_flight:
                            skipped += 1
                            continue
                        extra = {
                            "crm_url": spec.crm_url,
                            "account_id": spec.account_id,
                            "agent": spec.agent,
                            "customer": spec.customer,
                            "record_path": record_path,
                            "smooth_model": req.smooth_model,
                        }
                        job = Job(
                            id=str(uuid.uuid4()),
                            audio_path=record_path,
                            pair_slug=pair_slug,
                            call_id=call_id,
                            speaker_a=req.speaker_a,
                            speaker_b=req.speaker_b,
                            status=JobStatus.pending,
                            extra_config=json.dumps(extra),
                            batch_id=batch_id,
                        )
                        pair_db.add(job)
                        pair_db.commit()
                        pair_db.refresh(job)
                        job_runner.submit_job(job, loop)
                        job_ids.append(job.id)
                        submitted += 1
            except Exception as exc:
                print(f"[batch-for-pairs] Error processing {spec.agent}/{spec.customer}: {exc}")

    await asyncio.gather(*[_process_pair(p) for p in req.pairs])
    return {"submitted": submitted, "skipped": skipped, "job_ids": job_ids}


# ── Job listing / status ───────────────────────────────────────────────────────

@router.get("/jobs")
def list_transcription_jobs(
    agent: str = Query(""),
    customer: str = Query(""),
    limit: int = Query(100),
    db: Session = Depends(get_session),
):
    stmt = select(Job)
    if agent:
        stmt = stmt.where(Job.pair_slug.like(f"{agent}%"))
    if customer:
        stmt = stmt.where(Job.pair_slug.like(f"%/{customer}%"))
    stmt = stmt.order_by(Job.created_at.desc()).limit(limit)
    return db.exec(stmt).all()


@router.get("/jobs/{job_id}")
def get_transcription_job(job_id: str, db: Session = Depends(get_session)):
    job = db.get(Job, job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    return job


# ── One-shot smooth endpoint ───────────────────────────────────────────────────

@router.post("/smooth")
def smooth_transcript(req: SmoothRequest):
    """LLM-smooth an existing ElevenLabs transcript for a call.

    Reads the saved EL JSON from the call directory, runs LLM smoothing,
    and saves the result to transcribed/llm_final/smoothed.txt.
    """
    from ui.backend.routers.final_transcript import _build_smooth_system, _llm_call, _ensure_timestamps

    call_dir = settings.agents_dir / req.agent / req.customer / req.call_id
    el_json_path = call_dir / "transcribed" / "elevenlabs" / "original.json"

    if not el_json_path.exists():
        raise HTTPException(404, f"EL transcript not found: {el_json_path}")

    try:
        data = json.loads(el_json_path.read_text())
    except Exception as e:
        raise HTTPException(400, f"Could not read EL JSON: {e}")

    # Convert EL JSON to readable text
    words = data.get("words", [])

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

    el_text = "\n".join(lines) if lines else data.get("text", "")

    # LLM smooth
    system = _build_smooth_system(req.agent, req.customer)
    user = f"Transcript to clean up:\n\n{el_text}"
    raw = _llm_call(system, user, req.model)
    smoothed = _ensure_timestamps(el_text, raw)

    # Save
    llm_dir = call_dir / "transcribed" / "llm_final"
    llm_dir.mkdir(parents=True, exist_ok=True)
    (llm_dir / "smoothed.txt").write_text(smoothed, encoding="utf-8")
    (llm_dir / "smoothed_meta.json").write_text(json.dumps({
        "type": "smoothed",
        "call_id": req.call_id,
        "agent": req.agent,
        "customer": req.customer,
        "model": req.model,
        "created_at": datetime.utcnow().isoformat(),
    }, indent=2))

    return {
        "ok": True,
        "smoothed_path": str(llm_dir / "smoothed.txt"),
        "chars": len(smoothed),
    }
