"""Notes — per-call LLM analysis saved as notes against a specific transcript."""
import asyncio
import json
import uuid
from datetime import datetime
from typing import Optional
import requests as _requests

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlmodel import Session, select

from ui.backend.config import settings
from ui.backend.database import get_session
from ui.backend.models.crm import CRMPair
from ui.backend.models.note import Note
from ui.backend.routers.full_persona_agent import _llm_call_temp, _llm_stream_thinking, _sse

router = APIRouter(prefix="/notes", tags=["notes"])

# ── Notes Agent preset storage ────────────────────────────────────────────────

NOTES_AGENTS_DIR = settings.ui_data_dir / "_notes_agents"
NOTE_ROLLUPS_DIR  = settings.ui_data_dir / "_note_rollups"

DEFAULT_COMPLIANCE_SYSTEM = """You are a regulatory compliance analyst reviewing a single sales call note.

Given the call note, return ONLY a valid JSON object — no markdown, no explanation, no code fences.

The JSON must have this exact structure:
{
  "Compliance Risk":    {"score": 80, "reasoning": "brief justification"},
  "Disclosure Quality": {"score": 75, "reasoning": "brief justification"},
  "Regulatory Language":{"score": 85, "reasoning": "brief justification"},
  "Sales Ethics":       {"score": 90, "reasoning": "brief justification"},
  "_overall": 82,
  "_summary": "One sentence overall compliance assessment",
  "_risk_level": "Low",
  "_violations": ["list specific violations, or leave empty"]
}

Rules:
- All scores are integers 0–100; higher = better compliance.
- _risk_level is exactly one of: Low, Medium, High.
- _violations is a list; leave [] if none found.
- Score every section from the note content only."""

DEFAULT_COMPLIANCE_PROMPT = "Score the compliance of this call note:"

DEFAULT_ROLLUP_SYSTEM = """You are a senior compliance analyst reviewing a complete series of call notes for a single agent-customer relationship.

Return ONLY a valid JSON object — no markdown, no explanation, no code fences.

The JSON must have this exact structure:
{
  "overall_risk": "Low",
  "summary": "One sentence overall assessment.",
  "compliance_aggregate": {
    "procedures": [{"name": "Procedure Name", "compliant": 3, "violations": 1}],
    "total_violations": 5,
    "total_checks": 18
  },
  "call_progression": [{"call_id": "call_001", "stage": "Introduction", "outcome": "Interested"}],
  "key_patterns": ["Pattern observed across calls"],
  "next_steps": ["Priority action 1"],
  "violated_procedures": ["Procedure name"]
}

Rules:
- overall_risk is exactly one of: Low, Medium, High
- summary is a single sentence
- procedures: one entry per distinct compliance procedure found across all notes; compliant/violations are exact integer counts
- call_progression: one entry per call in chronological order
- key_patterns: 3–6 most important recurring issues as short strings
- next_steps: 5–8 actions ranked by urgency as short strings
- violated_procedures: list of procedure names that had at least one violation
- Do not estimate — extract exact numbers from the notes"""

DEFAULT_ROLLUP_PROMPT = "Analyse and aggregate all notes for this agent-customer relationship and return the JSON object:"

DEFAULT_SYSTEM = """You are a senior call analyst reviewing a single sales call transcript.

Produce a concise call note with EXACTLY these sections (each preceded by ##):

## Summary
What was discussed, key outcomes, the customer's stance at the end.

## Sales Techniques Used
Specific tactics, objection handling, persuasion methods observed in this call.

## Compliance & Risk
Required disclosures given or missed, any red flags, risk rating (Low / Medium / High).

## Communication Quality
Tone, clarity, active listening, rapport, pacing.

## Next Steps
Agreed next actions, follow-ups, open items.

Rules:
- Use the exact ## headings — do not rename, add, or remove sections.
- Be specific; quote the transcript directly where relevant.
- Keep each section concise (3–6 bullet points).
- Do not add a title or preamble before the first ## heading."""

DEFAULT_PROMPT = "Analyse this call and produce a concise call note:"


def _na_load_all() -> list[dict]:
    NOTES_AGENTS_DIR.mkdir(parents=True, exist_ok=True)
    out = []
    for f in sorted(NOTES_AGENTS_DIR.glob("*.json")):
        try:
            out.append(json.loads(f.read_text(encoding="utf-8")))
        except Exception:
            pass
    return out


def _na_find(name: str):
    """Return (Path, data) for the agent with given name, or raise 404."""
    for f in NOTES_AGENTS_DIR.glob("*.json"):
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
            if d.get("name") == name:
                return f, d
        except Exception:
            pass
    raise HTTPException(404, "Notes agent not found")


# ── Notes Agent CRUD — defined BEFORE /{note_id} routes ──────────────────────

class NotesAgentIn(BaseModel):
    name: str
    model: str = "gpt-5.4"
    temperature: float = 0.0
    system_prompt: str = DEFAULT_SYSTEM
    user_prompt: str = DEFAULT_PROMPT
    is_default: bool = False
    # Compliancy agent fields (optional — defaults applied if absent)
    run_compliance: bool = True
    compliance_model: str = "gpt-5.4"
    compliance_system_prompt: str = DEFAULT_COMPLIANCE_SYSTEM
    compliance_user_prompt: str = DEFAULT_COMPLIANCE_PROMPT


@router.get("/agents")
def list_notes_agents():
    return _na_load_all()


@router.post("/agents")
def save_notes_agent(req: NotesAgentIn):
    NOTES_AGENTS_DIR.mkdir(parents=True, exist_ok=True)
    now = datetime.utcnow().isoformat()
    # Upsert by name
    existing_file = None
    for f in NOTES_AGENTS_DIR.glob("*.json"):
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
            if d.get("name") == req.name:
                existing_file = f
                break
        except Exception:
            pass

    if req.is_default:
        for f in NOTES_AGENTS_DIR.glob("*.json"):
            try:
                d = json.loads(f.read_text(encoding="utf-8"))
                if d.get("is_default") and d.get("name") != req.name:
                    d["is_default"] = False
                    f.write_text(json.dumps(d, indent=2, ensure_ascii=False), encoding="utf-8")
            except Exception:
                pass

    record = {
        "name": req.name,
        "model": req.model,
        "temperature": req.temperature,
        "system_prompt": req.system_prompt,
        "user_prompt": req.user_prompt,
        "is_default": req.is_default,
        "run_compliance": req.run_compliance,
        "compliance_model": req.compliance_model,
        "compliance_system_prompt": req.compliance_system_prompt,
        "compliance_user_prompt": req.compliance_user_prompt,
        "created_at": now,
    }
    target = existing_file or (NOTES_AGENTS_DIR / f"{uuid.uuid4()}.json")
    target.write_text(json.dumps(record, indent=2, ensure_ascii=False), encoding="utf-8")
    return record


@router.patch("/agents/{name}/default")
def set_notes_agent_default(name: str):
    for f in NOTES_AGENTS_DIR.glob("*.json"):
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
            want = d.get("name") == name
            if d.get("is_default") != want:
                d["is_default"] = want
                f.write_text(json.dumps(d, indent=2, ensure_ascii=False), encoding="utf-8")
        except Exception:
            pass
    return {"ok": True}


@router.delete("/agents/{name}")
def delete_notes_agent(name: str):
    f, _ = _na_find(name)
    f.unlink()
    return {"ok": True}


# ── List notes ────────────────────────────────────────────────────────────────

def _agent_names_for(agent: str) -> list[str]:
    """Return [agent] plus any alias names that map to this primary agent.

    e.g. "Leo West" → ["Leo West", "Leo West-Re13"]
    """
    from ui.backend.services.crm_service import _load_aliases
    aliases = _load_aliases()
    extras = [a for a, p in aliases.items() if p == agent]
    return [agent] + extras


def _is_dev_host(request: Request) -> bool:
    hosts: list[str] = []
    for key in ("x-forwarded-host", "host"):
        raw = str(request.headers.get(key) or "")
        if raw:
            hosts.extend([h.strip() for h in raw.split(",") if h.strip()])
    if request.url and request.url.hostname:
        hosts.append(str(request.url.hostname))
    for host in hosts:
        norm = host.split(":")[0].strip().lower()
        if not norm:
            continue
        if norm in {"localhost", "127.0.0.1"}:
            return True
        if norm == "shinobi.aleph-infinity.com":
            return True
    return False


def _resolve_account_for_note(agent: str, customer: str, db: Session) -> tuple[str, str]:
    names = _agent_names_for(agent)
    stmt = select(CRMPair).where(CRMPair.customer == customer)
    if len(names) == 1:
        stmt = stmt.where(CRMPair.agent == names[0])
    else:
        from sqlalchemy import or_
        stmt = stmt.where(or_(*[CRMPair.agent == n for n in names]))
    pairs = db.exec(stmt).all()
    if not pairs:
        return "", ""
    pairs.sort(
        key=lambda p: (
            int(getattr(p, "call_count", 0) or 0),
            float(getattr(p, "net_deposits", 0.0) or 0.0),
        ),
        reverse=True,
    )
    best = pairs[0]
    return str(best.account_id or "").strip(), str(best.crm_url or "").strip()


@router.get("")
def list_notes(
    agent: str = Query(""),
    customer: str = Query(""),
    call_id: str = Query(""),
    db: Session = Depends(get_session),
):
    stmt = select(Note)
    if agent:
        names = _agent_names_for(agent)
        if len(names) == 1:
            stmt = stmt.where(Note.agent == agent)
        else:
            from sqlalchemy import or_
            stmt = stmt.where(or_(*[Note.agent == n for n in names]))
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
            "notes_agent_id": n.persona_agent_id,   # reusing the column
            "content_md": n.content_md,
            "score_json": json.loads(n.score_json) if n.score_json else None,
            "model": n.model,
            "temperature": n.temperature,
            "created_at": n.created_at.isoformat() if n.created_at else "",
        }
        for n in notes
    ]


# ── Manager summary helpers ───────────────────────────────────────────────────

def _get_call_meta(agent: str, customer: str, call_id: str) -> dict:
    """Return {date, duration_s, net_deposits, crm_url} for a specific call."""
    import json as _json
    meta: dict = {"date": None, "duration_s": None, "net_deposits": None, "crm_url": None}

    # Call date + duration from calls.json (tries alias dirs too)
    for a in _agent_names_for(agent):
        calls_path = settings.agents_dir / a / customer / "calls.json"
        if calls_path.exists():
            try:
                for c in _json.loads(calls_path.read_text()):
                    if str(c.get("call_id", "")) == str(call_id):
                        meta["date"] = c.get("started_at") or c.get("date")
                        meta["duration_s"] = c.get("duration_s") or c.get("audio_duration_s")
                        meta["crm_url"] = c.get("crm_url", "")
                        break
            except Exception:
                pass
        if meta["date"]:
            break

    # Net deposits from crm_pair table
    try:
        from ui.backend.database import engine
        from sqlmodel import Session as _Sess
        from ui.backend.models.crm import CRMPair
        with _Sess(engine) as _db:
            pairs = _db.exec(
                select(CRMPair.net_deposits, CRMPair.crm_url)
                .where(CRMPair.agent == agent, CRMPair.customer == customer)
            ).all()
            if pairs:
                meta["net_deposits"] = sum(float(p[0] or 0) for p in pairs)
                if not meta["crm_url"] and pairs[0][1]:
                    meta["crm_url"] = pairs[0][1]
    except Exception:
        pass

    return meta


def _build_summary_header(agent: str, customer: str, call_id: str, meta: dict) -> str:
    """Build a manager summary block matching the merged-transcript style."""
    from datetime import datetime, timezone
    nd = meta.get("net_deposits")
    nd_line = f"Net Deposits: ${nd:,.2f}\n" if nd is not None else ""
    date_str = str(meta.get("date") or "")[:19]
    dur_str = ""
    if meta.get("duration_s") is not None:
        d = int(meta["duration_s"])
        dur_str = f"  |  {d // 60}m{d % 60:02d}s"
    call_line = f"CALL {call_id}"
    if date_str:
        call_line += f"  |  {date_str}"
    call_line += dur_str
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    return (
        f"{'═' * 60}\n"
        f"MANAGER SUMMARY\n"
        f"Agent:    {agent}\n"
        f"Customer: {customer}\n"
        f"{nd_line}"
        f"Generated: {now}\n"
        f"{'═' * 60}\n"
        f"{'─' * 60}\n"
        f"{call_line}\n"
        f"{'─' * 60}\n\n"
    )


# ── Fetch transcript for a call ──────────────────────────────────────────────

@router.get("/transcript")
def get_transcript(
    agent: str = Query(...),
    customer: str = Query(...),
    call_id: str = Query(...),
):
    """Return the transcript text for a specific call (tries alias agent dirs too)."""
    for a in _agent_names_for(agent):
        call_dir = settings.agents_dir / a / customer / call_id
        for path in [
            call_dir / "transcribed" / "llm_final" / "smoothed.txt",
            call_dir / "transcribed" / "llm_final" / "voted.txt",
            call_dir / "transcribed" / "final.txt",
        ]:
            if path.exists():
                return {"text": path.read_text(encoding="utf-8").strip(), "source": path.name, "call_id": call_id}
    raise HTTPException(404, "No transcript found for this call")


# ── Delete note ───────────────────────────────────────────────────────────────

@router.delete("/{note_id}")
def delete_note(note_id: str, db: Session = Depends(get_session)):
    note = db.get(Note, note_id)
    if not note:
        raise HTTPException(404, "Note not found")
    db.delete(note)
    db.commit()
    return {"ok": True}


class NoteSendToCRMRequest(BaseModel):
    account_id: str = ""


@router.post("/{note_id}/send-to-crm")
def send_note_to_crm(
    note_id: str,
    req: NoteSendToCRMRequest,
    request: Request,
    db: Session = Depends(get_session),
):
    if not settings.crm_push_enabled:
        raise HTTPException(403, "CRM push is disabled. Set CRM_PUSH_ENABLED=true in development env.")
    if not _is_dev_host(request):
        raise HTTPException(403, "Send to CRM is available only in development environment.")

    note = db.get(Note, note_id)
    if not note:
        raise HTTPException(404, "Note not found")

    endpoint = str(settings.crm_push_endpoint or "").strip()
    if not endpoint:
        raise HTTPException(500, "Missing CRM push endpoint configuration")

    missing = []
    if not settings.crm_push_api_username:
        missing.append("CRM_PUSH_API_USERNAME")
    if not settings.crm_push_api_password:
        missing.append("CRM_PUSH_API_PASSWORD")
    if not settings.crm_push_api_key:
        missing.append("CRM_PUSH_API_KEY")
    if missing:
        raise HTTPException(500, f"Missing CRM push credentials: {', '.join(missing)}")

    account_id = str(req.account_id or "").strip()
    crm_url = ""
    if not account_id:
        account_id, crm_url = _resolve_account_for_note(note.agent, note.customer, db)
    if not account_id:
        raise HTTPException(
            400,
            f"Could not resolve CRM account_id for {note.agent} / {note.customer}. Provide account_id explicitly.",
        )

    data_field = str(settings.crm_push_data_field or "note").strip() or "note"
    note_payload = {
        data_field: str(note.content_md or ""),
        "call_id": str(note.call_id or ""),
        "agent": str(note.agent or ""),
        "customer": str(note.customer or ""),
        "model": str(note.model or ""),
        "created_at": note.created_at.isoformat() if note.created_at else "",
    }
    body = {
        "api_username": settings.crm_push_api_username,
        "api_password": settings.crm_push_api_password,
        "api_key": settings.crm_push_api_key,
        "account_id": account_id,
        "data": json.dumps(note_payload, ensure_ascii=False),
    }

    try:
        resp = _requests.post(
            endpoint,
            data=body,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            timeout=max(5, int(settings.crm_push_timeout_s or 20)),
        )
    except Exception as exc:
        raise HTTPException(502, f"CRM request failed: {exc}")

    text = (resp.text or "").strip()
    if resp.status_code >= 400:
        raise HTTPException(
            502,
            f"CRM push failed ({resp.status_code}): {text[:1000]}",
        )

    return {
        "ok": True,
        "message": "Note sent to CRM",
        "crm_status": resp.status_code,
        "crm_response": text[:1000],
        "endpoint": endpoint,
        "account_id": account_id,
        "crm_url": crm_url,
        "note_id": note.id,
    }


# ── Analyze a single call — SSE stream ───────────────────────────────────────

class NoteAnalyzeRequest(BaseModel):
    agent: str
    customer: str
    call_id: str
    notes_agent_id: str = ""      # name of the notes agent preset used
    model: str = "gpt-5.4"
    temperature: float = 0.0
    system_prompt: str = DEFAULT_SYSTEM
    user_prompt: str = DEFAULT_PROMPT
    notes_thinking: bool = False
    # Compliancy agent
    run_compliance: bool = False
    compliance_model: str = "gpt-5.4"
    compliance_system_prompt: str = DEFAULT_COMPLIANCE_SYSTEM
    compliance_user_prompt: str = DEFAULT_COMPLIANCE_PROMPT
    compliance_thinking: bool = False


@router.post("/analyze")
async def analyze_note(req: NoteAnalyzeRequest):
    loop = asyncio.get_event_loop()
    _label = f"{req.agent}/{req.customer}/{req.call_id}"

    async def stream():
        # Locate the single call's transcript
        call_dir = settings.agents_dir / req.agent / req.customer / req.call_id
        tx_path = call_dir / "transcribed" / "llm_final" / "smoothed.txt"
        if not tx_path.exists():
            tx_path = call_dir / "transcribed" / "llm_final" / "voted.txt"
        if not tx_path.exists():
            yield _sse("error", {"msg": "No transcript found. Transcribe this call first."})
            return

        yield _sse("progress", {"step": 1, "total": 3, "msg": "Loading transcript…"})
        try:
            transcript = tx_path.read_text(encoding="utf-8").strip()
        except Exception as e:
            yield _sse("error", {"msg": f"Failed to read transcript: {e}"})
            return

        if not transcript:
            yield _sse("error", {"msg": "Transcript is empty."})
            return

        yield _sse("progress", {"step": 1, "total": 3,
            "msg": f"Transcript ready — {len(transcript):,} chars"})

        # Step 2: run notes agent
        print(f"[notes] {_label}: running notes agent model={req.model}")
        yield _sse("progress", {"step": 2, "total": 3,
            "msg": f"Running notes agent ({req.model})…"})
        try:
            user_msg = f"{req.user_prompt.strip()}\n\n{transcript}"
            _notes_q: asyncio.Queue = asyncio.Queue()
            def _on_notes_chunk(t: str, _q=_notes_q):
                asyncio.run_coroutine_threadsafe(_q.put(("t", t)), loop)
            async def _notes_coro(_q=_notes_q):
                try:
                    r = await loop.run_in_executor(
                        None, _llm_stream_thinking,
                        req.system_prompt, user_msg, req.model,
                        req.temperature, req.notes_thinking, _on_notes_chunk)
                    await _q.put(("done", r))
                except Exception as exc:
                    await _q.put(("error", str(exc)))
            asyncio.create_task(_notes_coro())
            content_md = ""
            while True:
                kind, val = await _notes_q.get()
                if kind == "t":
                    yield _sse("thinking", {"text": val, "phase": "notes"})
                elif kind == "done":
                    content_md = val
                    break
                elif kind == "error":
                    raise RuntimeError(val)
        except Exception as e:
            print(f"[notes] {_label}: notes agent error: {e}")
            yield _sse("error", {"msg": f"Notes agent failed: {e}"})
            return

        yield _sse("progress", {"step": 2, "total": 3,
            "msg": f"Note generated — {len(content_md):,} chars"})

        # Step 3: save
        # Prepend manager summary header
        try:
            meta = _get_call_meta(req.agent, req.customer, req.call_id)
            summary_header = _build_summary_header(req.agent, req.customer, req.call_id, meta)
            content_md = summary_header + content_md
        except Exception as _hdr_err:
            print(f"[notes] {_label}: summary header error (non-fatal): {_hdr_err}")

        yield _sse("progress", {"step": 3, "total": 3, "msg": "Saving note…"})
        try:
            from ui.backend.database import engine
            from sqlmodel import Session as _Session
            note_id = str(uuid.uuid4())
            note = Note(
                id=note_id,
                agent=req.agent,
                customer=req.customer,
                call_id=req.call_id,
                persona_agent_id=req.notes_agent_id or None,
                content_md=content_md,
                score_json=None,
                model=req.model,
                temperature=req.temperature,
                created_at=datetime.utcnow(),
            )
            with _Session(engine) as db:
                db.add(note)
                db.commit()
        except Exception as e:
            print(f"[notes] {_label}: save error: {e}")
            yield _sse("error", {"msg": f"Save failed: {e}"})
            return

        # Step 4 (optional): compliancy scoring
        comp_json: dict | None = None
        if req.run_compliance:
            yield _sse("progress", {"step": 4, "total": 4,
                "msg": f"Running compliancy agent ({req.compliance_model})…"})
            try:
                import re as _re
                comp_msg = f"{req.compliance_user_prompt.strip()}\n\n{content_md}"
                _comp_q: asyncio.Queue = asyncio.Queue()
                def _on_comp_chunk(t: str, _q=_comp_q):
                    asyncio.run_coroutine_threadsafe(_q.put(("t", t)), loop)
                async def _comp_coro(_q=_comp_q):
                    try:
                        r = await loop.run_in_executor(
                            None, _llm_stream_thinking,
                            req.compliance_system_prompt, comp_msg, req.compliance_model,
                            0.0, req.compliance_thinking, _on_comp_chunk)
                        await _q.put(("done", r))
                    except Exception as exc:
                        await _q.put(("error", str(exc)))
                asyncio.create_task(_comp_coro())
                comp_raw = ""
                while True:
                    kind, val = await _comp_q.get()
                    if kind == "t":
                        yield _sse("thinking", {"text": val, "phase": "compliance"})
                    elif kind == "done":
                        comp_raw = val
                        break
                    elif kind == "error":
                        raise RuntimeError(val)
                try:
                    comp_json = json.loads(comp_raw)
                except Exception:
                    m = _re.search(r'\{[\s\S]+\}', comp_raw)
                    comp_json = json.loads(m.group()) if m else {"_raw_text": comp_raw}
                with _Session(engine) as db:
                    note_obj = db.get(Note, note_id)
                    if note_obj:
                        note_obj.score_json = json.dumps(comp_json)
                        db.add(note_obj)
                        db.commit()
                overall = comp_json.get("_overall", "?")
                risk    = comp_json.get("_risk_level", "?")
                yield _sse("progress", {"step": 4, "total": 4,
                    "msg": f"Compliance scored — overall {overall} | risk {risk}"})
            except Exception as e:
                print(f"[notes] {_label}: compliance error: {e}")
                yield _sse("progress", {"step": 4, "total": 4,
                    "msg": "Compliance scoring failed (note still saved)"})

        print(f"[notes] {_label}: done — note_id={note_id}")
        yield _sse("done", {
            "note_id": note_id,
            "call_id": req.call_id,
            "content_md": content_md,
            "score_json": comp_json,
        })

    return StreamingResponse(stream(), media_type="text/event-stream", headers={
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
    })


# ── Roll-up: aggregate all notes for an agent+customer ────────────────────────

class NoteRollupRequest(BaseModel):
    agent: str
    customer: str
    preset: str = ""          # notes_agent_id to filter by; empty = all presets
    max_notes: int = 10       # cap to N most recent unique calls to avoid LLM timeout
    model: str = "gemini-2.5-flash"
    temperature: float = 0.0
    system_prompt: str = DEFAULT_ROLLUP_SYSTEM
    user_prompt: str = DEFAULT_ROLLUP_PROMPT
    thinking: bool = False


@router.get("/rollup")
def get_rollup(agent: str = Query(...), customer: str = Query(...), preset: str = Query("")):
    """Return the persisted roll-up JSON for agent+customer (optionally scoped to preset), or 404."""
    slug = preset.replace(" ", "_") if preset else "_all"
    rollup_path = NOTE_ROLLUPS_DIR / agent / f"{customer}__{slug}.json"
    # Fallback: legacy path without preset slug
    if not rollup_path.exists():
        rollup_path = NOTE_ROLLUPS_DIR / agent / f"{customer}.json"
    if not rollup_path.exists():
        raise HTTPException(404, "No saved rollup found")
    try:
        return json.loads(rollup_path.read_text(encoding="utf-8"))
    except Exception as e:
        raise HTTPException(500, f"Failed to read rollup: {e}")


@router.post("/rollup")
async def rollup_notes(req: NoteRollupRequest):
    loop = asyncio.get_event_loop()
    _label = f"{req.agent}/{req.customer}"

    # Padding to push through Next.js / nginx proxy buffers (must be > 4 KB to flush)
    _PAD = ": " + " " * 4096 + "\n\n"

    async def stream():
        yield _PAD  # flush proxy buffer immediately

        from ui.backend.database import engine
        from sqlmodel import Session as _Session
        with _Session(engine) as db:
            agent_names = _agent_names_for(req.agent)
            if len(agent_names) == 1:
                agent_filter = Note.agent == req.agent
            else:
                from sqlalchemy import or_
                agent_filter = or_(*[Note.agent == n for n in agent_names])
            stmt = select(Note).where(
                agent_filter,
                Note.customer == req.customer,
            )
            if req.preset:
                stmt = stmt.where(Note.persona_agent_id == req.preset)
            stmt = stmt.order_by(Note.created_at)
            all_notes = db.exec(stmt).all()

        # Deduplicate: keep only the latest note per call_id
        seen: dict[str, Note] = {}
        for n in all_notes:
            seen[n.call_id] = n   # later rows overwrite earlier ones (ordered by created_at)
        all_unique = list(seen.values())
        all_unique.sort(key=lambda n: n.created_at)

        if not all_unique:
            preset_hint = f" with preset '{req.preset}'" if req.preset else ""
            yield _sse("error", {"msg": f"No notes found for this agent-customer pair{preset_hint}. Run the notes agent first."})
            return

        # Cap to most recent N notes to avoid LLM timeout on huge inputs
        total_unique = len(all_unique)
        notes = all_unique[-req.max_notes:] if req.max_notes > 0 else all_unique

        # Concatenate notes with separators
        parts_list = [f"\n\n---\n### Note {i} (Call: {note.call_id})\n\n{note.content_md}"
                      for i, note in enumerate(notes, 1)]
        combined = "".join(parts_list).strip()

        print(f"[rollup] {_label}: preset={req.preset!r} total_unique={total_unique} using={len(notes)} chars={len(combined):,}")

        # Emit preview — send another pad to ensure it flushes through the proxy
        yield _sse("notes_preview", {
            "note_count": len(notes),
            "total_unique": total_unique,
            "total_chars": len(combined),
            "preset": req.preset or "(all)",
            "preview": combined[:4000],
        })
        yield _PAD  # flush after preview so UI updates before LLM starts

        yield _sse("progress", {"step": 2, "total": 3,
            "msg": f"Running LLM on {len(notes)} notes ({len(combined):,} chars)…"})

        try:
            user_msg = f"{req.user_prompt.strip()}\n\n{combined}"
            _q: asyncio.Queue = asyncio.Queue()
            def _on_chunk(t: str, _q=_q):
                asyncio.run_coroutine_threadsafe(_q.put(("t", t)), loop)
            async def _coro(_q=_q):
                try:
                    r = await loop.run_in_executor(
                        None, _llm_stream_thinking,
                        req.system_prompt, user_msg, req.model,
                        req.temperature, req.thinking, _on_chunk)
                    await _q.put(("done", r))
                except Exception as exc:
                    await _q.put(("error", str(exc)))
            asyncio.create_task(_coro())
            result_raw = ""
            while True:
                kind, val = await _q.get()
                if kind == "t":
                    yield _sse("thinking", {"text": val, "phase": "rollup"})
                elif kind == "done":
                    result_raw = val
                    break
                elif kind == "error":
                    raise RuntimeError(val)
        except Exception as e:
            print(f"[rollup] {_label}: error: {e}")
            yield _sse("error", {"msg": f"Roll-up failed: {e}"})
            return

        # Parse JSON output (strip accidental code fences)
        import re as _re
        try:
            result_json = json.loads(result_raw)
        except Exception:
            m = _re.search(r'\{[\s\S]+\}', result_raw)
            try:
                result_json = json.loads(m.group()) if m else {"_raw_text": result_raw}
            except Exception:
                result_json = {"_raw_text": result_raw}

        # Persist to disk
        result_json["_saved_at"] = datetime.utcnow().isoformat()
        result_json["_note_count"] = len(notes)
        result_json["_preset"] = req.preset or "(all)"
        slug = req.preset.replace(" ", "_") if req.preset else "_all"
        try:
            save_dir = NOTE_ROLLUPS_DIR / req.agent
            save_dir.mkdir(parents=True, exist_ok=True)
            save_path = save_dir / f"{req.customer}__{slug}.json"
            save_path.write_text(json.dumps(result_json, indent=2, ensure_ascii=False), encoding="utf-8")
            print(f"[rollup] {_label}: saved to {save_path}")
        except Exception as e:
            print(f"[rollup] {_label}: save error (non-fatal): {e}")

        yield _sse("progress", {"step": 3, "total": 3, "msg": "Summary complete"})
        print(f"[rollup] {_label}: done — {len(result_raw):,} chars")
        yield _sse("done", {"result_json": result_json, "note_count": len(notes)})

    return StreamingResponse(stream(), media_type="text/event-stream", headers={
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
    })
