"""Notes — per-call LLM analysis saved as notes against a specific transcript."""
import asyncio
import json
import uuid
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlmodel import Session, select

from ui.backend.config import settings
from ui.backend.database import get_session
from ui.backend.models.note import Note
from ui.backend.routers.full_persona_agent import (
    DEFAULT_GENERATOR_SYSTEM,
    DEFAULT_GENERATOR_PROMPT,
    DEFAULT_SCORER_SYSTEM,
    DEFAULT_SCORER_PROMPT,
    _llm_call_temp,
    _parse_score_json,
    _sse,
)

router = APIRouter(prefix="/notes", tags=["notes"])


# ── List notes ────────────────────────────────────────────────────────────────

@router.get("")
def list_notes(
    agent: str = Query(""),
    customer: str = Query(""),
    call_id: str = Query(""),
    db: Session = Depends(get_session),
):
    stmt = select(Note)
    if agent:
        stmt = stmt.where(Note.agent == agent)
    if customer:
        stmt = stmt.where(Note.customer == customer)
    if call_id:
        stmt = stmt.where(Note.call_id == call_id)
    stmt = stmt.order_by(Note.created_at.desc())
    notes = db.exec(stmt).all()
    return [
        {
            "id": n.id,
            "agent": n.agent,
            "customer": n.customer,
            "call_id": n.call_id,
            "persona_agent_id": n.persona_agent_id,
            "content_md": n.content_md,
            "score_json": json.loads(n.score_json) if n.score_json else None,
            "model": n.model,
            "temperature": n.temperature,
            "created_at": n.created_at.isoformat() if n.created_at else "",
        }
        for n in notes
    ]


# ── Delete note ───────────────────────────────────────────────────────────────

@router.delete("/{note_id}")
def delete_note(note_id: str, db: Session = Depends(get_session)):
    note = db.get(Note, note_id)
    if not note:
        raise HTTPException(404, "Note not found")
    db.delete(note)
    db.commit()
    return {"ok": True}


# ── Analyze a single call — SSE stream ───────────────────────────────────────

class NoteAnalyzeRequest(BaseModel):
    agent: str
    customer: str
    call_id: str
    persona_agent_id: str = ""
    generator_model: str = "gpt-5.4"
    generator_temperature: float = 0.0
    generator_system: str = DEFAULT_GENERATOR_SYSTEM
    generator_prompt: str = DEFAULT_GENERATOR_PROMPT
    scorer_model: str = "gpt-5.4"
    scorer_temperature: float = 0.0
    scorer_system: str = DEFAULT_SCORER_SYSTEM
    scorer_prompt: str = DEFAULT_SCORER_PROMPT


@router.post("/analyze")
async def analyze_note(req: NoteAnalyzeRequest):
    loop = asyncio.get_event_loop()
    _label = f"{req.agent}/{req.customer}/{req.call_id}"

    async def stream():
        # Find transcript for this specific call
        call_dir = settings.agents_dir / req.agent / req.customer / req.call_id
        tx_path = call_dir / "transcribed" / "llm_final" / "smoothed.txt"
        if not tx_path.exists():
            tx_path = call_dir / "transcribed" / "llm_final" / "voted.txt"
        if not tx_path.exists():
            yield _sse("error", {"msg": "No transcript found. Transcribe this call first."})
            return

        yield _sse("progress", {"step": 1, "total": 4, "msg": "Loading transcript…"})
        try:
            transcript = tx_path.read_text(encoding="utf-8").strip()
        except Exception as e:
            yield _sse("error", {"msg": f"Failed to read transcript: {e}"})
            return

        if not transcript:
            yield _sse("error", {"msg": "Transcript is empty."})
            return

        yield _sse("progress", {"step": 1, "total": 4,
            "msg": f"Transcript ready — {len(transcript):,} chars"})

        # Step 2: generator
        print(f"[notes] {_label}: running generator model={req.generator_model}")
        yield _sse("progress", {"step": 2, "total": 4,
            "msg": f"Running analysis ({req.generator_model})…"})
        try:
            user_msg = f"{req.generator_prompt.strip()}\n\n{transcript}"
            content_md = await loop.run_in_executor(
                None, _llm_call_temp,
                req.generator_system, user_msg, req.generator_model, req.generator_temperature,
            )
        except Exception as e:
            print(f"[notes] {_label}: generator error: {e}")
            yield _sse("error", {"msg": f"Analysis failed: {e}"})
            return

        yield _sse("progress", {"step": 2, "total": 4,
            "msg": f"Analysis done — {len(content_md):,} chars"})

        # Step 3: scorer
        print(f"[notes] {_label}: running scorer model={req.scorer_model}")
        yield _sse("progress", {"step": 3, "total": 4,
            "msg": f"Scoring ({req.scorer_model})…"})
        score_json: dict = {}
        try:
            score_user_msg = (
                f"{req.scorer_prompt.strip()}\n\n"
                f"## ANALYSIS OUTPUT\n\n{content_md}\n\n"
                f"## TRANSCRIPT\n\n{transcript}"
            )
            score_raw = await loop.run_in_executor(
                None, _llm_call_temp,
                req.scorer_system, score_user_msg, req.scorer_model, req.scorer_temperature,
            )
            score_json = _parse_score_json(score_raw)
        except Exception as e:
            print(f"[notes] {_label}: scorer error (non-fatal): {e}")
            # Non-fatal — save without score

        overall = score_json.get("_overall", 0)
        yield _sse("progress", {"step": 3, "total": 4,
            "msg": f"Score complete — {overall}/100" if score_json else "Scoring skipped"})

        # Step 4: save
        yield _sse("progress", {"step": 4, "total": 4, "msg": "Saving note…"})
        try:
            from ui.backend.database import engine
            from sqlmodel import Session as _Session
            note_id = str(uuid.uuid4())
            note = Note(
                id=note_id,
                agent=req.agent,
                customer=req.customer,
                call_id=req.call_id,
                persona_agent_id=req.persona_agent_id or None,
                content_md=content_md,
                score_json=json.dumps(score_json) if score_json else None,
                model=req.generator_model,
                temperature=req.generator_temperature,
                created_at=datetime.utcnow(),
            )
            with _Session(engine) as db:
                db.add(note)
                db.commit()
        except Exception as e:
            print(f"[notes] {_label}: save error: {e}")
            yield _sse("error", {"msg": f"Save failed: {e}"})
            return

        print(f"[notes] {_label}: done — note_id={note_id} overall={overall}/100")
        yield _sse("done", {
            "note_id": note_id,
            "call_id": req.call_id,
            "overall_score": overall,
            "content_md": content_md,
            "score_json": score_json,
        })

    return StreamingResponse(stream(), media_type="text/event-stream", headers={
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
    })
