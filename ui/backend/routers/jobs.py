import asyncio
import json
import uuid
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlmodel import Session, select, or_

from ui.backend.database import get_session
from ui.backend.models.job import Job, JobStatus
from ui.backend.services import job_runner

router = APIRouter(prefix="/jobs", tags=["jobs"])


ALL_ENGINES = [
    "elevenlabs_original", "elevenlabs_enhanced", "elevenlabs_converted",
    "openai_gpt4o", "openai_diarize", "gemini", "mlx_whisper",
]


class WorkerConfig(BaseModel):
    max_workers: int


class TranscribeRequest(BaseModel):
    audio_path: str
    pair_slug: str
    call_id: str
    speaker_a: str = "Ron"
    speaker_b: str = "Chris"
    # Which pipeline stages to run (default: all)
    stages: list[int] = [1, 2, 4, 5]
    # Engine selection (default: all engines)
    engines: list[str] = ALL_ENGINES
    # Audio enhancement
    noise_reduction: float = 0.8   # 0 = disabled, 0–1 = strength
    voice_isolation: bool = False
    vad_trim: bool = False
    # LLM merge (auto-enabled when >1 engine)
    llm_merge: bool = True
    llm_merge_model: str = "gpt-5.4"
    # Batch grouping (optional UUID shared by all jobs submitted together)
    batch_id: Optional[str] = None


@router.post("")
async def create_job(req: TranscribeRequest, db: Session = Depends(get_session)):
    extra = {
        "stages": req.stages,
        "engines": req.engines,
        "noise_reduction": req.noise_reduction,
        "voice_isolation": req.voice_isolation,
        "vad_trim": req.vad_trim,
        "llm_merge": req.llm_merge and len(req.engines) > 1,
        "llm_merge_model": req.llm_merge_model,
    }
    job = Job(
        id=str(uuid.uuid4()),
        audio_path=req.audio_path,
        pair_slug=req.pair_slug,
        call_id=req.call_id,
        speaker_a=req.speaker_a,
        speaker_b=req.speaker_b,
        status=JobStatus.pending,
        extra_config=json.dumps(extra),
        batch_id=req.batch_id,
    )
    db.add(job)
    db.commit()
    db.refresh(job)

    loop = asyncio.get_running_loop()
    job_runner.submit_job(job, loop)
    return {"job_id": job.id, "status": job.status}


@router.get("")
def list_jobs(pair_slug: Optional[str] = None, db: Session = Depends(get_session)):
    stmt = select(Job)
    if pair_slug:
        stmt = stmt.where(Job.pair_slug == pair_slug)
    stmt = stmt.order_by(Job.created_at.desc())
    jobs = db.exec(stmt).all()
    result = []
    for j in jobs:
        result.append(j.model_dump())
    return result


@router.get("/stats")
def worker_stats():
    """System CPU and memory stats for the workers panel."""
    try:
        import psutil
        executor = job_runner._executor
        active = len([t for t in executor._threads if t.is_alive()]) if hasattr(executor, "_threads") else None
        return {
            "cpu_pct": psutil.cpu_percent(),
            "mem_pct": psutil.virtual_memory().percent,
            "active_workers": active,
        }
    except Exception:
        return {"cpu_pct": None, "mem_pct": None, "active_workers": None}


@router.delete("/history")
def clear_history(db: Session = Depends(get_session)):
    """Delete all completed and failed jobs."""
    to_delete = db.exec(
        select(Job).where(or_(Job.status == JobStatus.complete, Job.status == JobStatus.failed))
    ).all()
    count = len(to_delete)
    for j in to_delete:
        db.delete(j)
    db.commit()
    return {"deleted": count}


@router.get("/config")
def get_config():
    """Return current worker pool configuration."""
    return {"max_workers": job_runner.get_max_workers()}


@router.put("/config")
def update_config(body: WorkerConfig):
    """Update the worker pool size."""
    job_runner.set_max_workers(body.max_workers)
    return {"max_workers": job_runner.get_max_workers()}


@router.get("/{job_id}")
def get_job(job_id: str, db: Session = Depends(get_session)):
    job = db.get(Job, job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    return job


@router.get("/{job_id}/stream")
async def stream_job(job_id: str, db: Session = Depends(get_session)):
    job = db.get(Job, job_id)
    if not job:
        raise HTTPException(404, "Job not found")

    stream = job_runner.get_stream(job_id)

    async def event_generator():
        if stream is None:
            # In-memory stream gone (server restarted) — try disk log first,
            # then fall back to the global log buffer.
            from ui.backend.services.job_runner import _JOB_LOG_DIR
            log_path = _JOB_LOG_DIR / f"{job_id}.json"
            if log_path.exists():
                try:
                    history = json.loads(log_path.read_text())
                    for event in history:
                        yield f"data: {json.dumps(event)}\n\n"
                        if event.get("done"):
                            return
                except Exception:
                    pass
            # Fallback: global log buffer
            from ui.backend.services import log_buffer as _lb
            buffered = _lb.get_by_job(job.id)
            for line in buffered:
                yield f"data: {json.dumps({'stage': 0, 'pct': job.pct, 'message': line.text, 'done': False})}\n\n"
            yield f"data: {json.dumps({'stage': 5, 'pct': job.pct, 'message': job.error or job.status, 'done': True})}\n\n"
            return

        # Replay history so late subscribers see all prior output
        for event in list(stream.history):
            yield f"data: {json.dumps(event)}\n\n"
            if event.get("done"):
                return

        # Subscribe to future events
        queue: asyncio.Queue = asyncio.Queue()
        stream.subscribers.append(queue)
        try:
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=30)
                    yield f"data: {json.dumps(event)}\n\n"
                    if event.get("done"):
                        break
                except asyncio.TimeoutError:
                    yield "data: {\"heartbeat\": true}\n\n"
        finally:
            try:
                stream.subscribers.remove(queue)
            except ValueError:
                pass

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.delete("/{job_id}")
def cancel_job(job_id: str, db: Session = Depends(get_session)):
    job = db.get(Job, job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    if job.status == JobStatus.running:
        job.status = JobStatus.failed
        job.error = "Cancelled by user"
        job.completed_at = datetime.utcnow()
        db.add(job)
        db.commit()
    return {"cancelled": True}
