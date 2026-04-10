from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlmodel import Session, select
from typing import Optional

from ui.backend.database import get_session
from ui.backend.models.crm import CRMPair
from ui.backend.services import crm_service

router = APIRouter(prefix="/crm", tags=["crm"])


class AuthRequest(BaseModel):
    crm_url: str
    email: str
    password: str



@router.get("/pairs")
def get_pairs(
    crm: str = Query(""),
    agent: str = Query(""),
    agent_exact: bool = Query(False),  # True = exact match, False = LIKE (for search)
    customer: str = Query(""),
    sort: str = Query("agent"),       # agent|customer|crm|calls|duration|deposits
    dir: str = Query("asc"),          # asc|desc
    min_calls: int = Query(0),
    min_duration: float = Query(0.0), # hours
    min_deposits: float = Query(0.0), # net deposits minimum
    db: Session = Depends(get_session),
):
    try:
        stmt = select(CRMPair)
        if crm:
            stmt = stmt.where(CRMPair.crm_url.like(f"%{crm}%"))
        if agent:
            if agent_exact:
                stmt = stmt.where(CRMPair.agent == agent)
            else:
                stmt = stmt.where(CRMPair.agent.like(f"%{agent}%"))
        if customer:
            stmt = stmt.where(CRMPair.customer.like(f"%{customer}%"))
        if min_calls:
            stmt = stmt.where(CRMPair.call_count >= min_calls)
        if min_duration:
            stmt = stmt.where(CRMPair.total_duration_s >= int(min_duration * 3600))
        if min_deposits:
            stmt = stmt.where(CRMPair.net_deposits >= min_deposits)

        col_map = {
            "agent":    CRMPair.agent,
            "customer": CRMPair.customer,
            "crm":      CRMPair.crm_url,
            "calls":    CRMPair.call_count,
            "duration": CRMPair.total_duration_s,
            "deposits": CRMPair.net_deposits,
        }
        col = col_map.get(sort, CRMPair.agent)
        stmt = stmt.order_by(col.desc() if dir == "desc" else col.asc())

        pairs = db.exec(stmt).all()
        return [
            {
                "id": p.id,
                "crm_url": p.crm_url,
                "account_id": p.account_id,
                "agent": p.agent,
                "customer": p.customer,
                "call_count": p.call_count,
                "total_duration": p.total_duration_s,
                "net_deposits": p.net_deposits,
            }
            for p in pairs
        ]
    except Exception as e:
        raise HTTPException(500, str(e))


@router.get("/agents")
def get_agents(crm: str = Query("")):
    try:
        return crm_service.get_agents(crm_filter=crm)
    except Exception as e:
        raise HTTPException(500, str(e))


@router.get("/pairs/local")
def get_pairs_local(
    agent: str = Query(""),
    customer: str = Query(""),
    agent_exact: bool = Query(False),
    sort: str = Query("agent"),
    dir: str = Query("asc"),
    min_calls: int = Query(0),
    min_duration: float = Query(0.0),
    min_deposits: float = Query(0.0),
    max_deposits: float = Query(0.0),
    db: Session = Depends(get_session),
):
    """Same data as /crm/pairs but with nd/td/tw field names for the pipeline frontend.

    Both endpoints read from the same crm_pair DB table — guaranteed identical data.
    """
    try:
        stmt = select(CRMPair)
        if agent:
            if agent_exact:
                stmt = stmt.where(CRMPair.agent == agent)
            else:
                stmt = stmt.where(CRMPair.agent.like(f"%{agent}%"))
        if customer:
            stmt = stmt.where(CRMPair.customer.like(f"%{customer}%"))
        if min_calls:
            stmt = stmt.where(CRMPair.call_count >= min_calls)
        if min_duration:
            stmt = stmt.where(CRMPair.total_duration_s >= int(min_duration * 3600))
        if min_deposits:
            stmt = stmt.where(CRMPair.net_deposits >= min_deposits)
        if max_deposits:
            stmt = stmt.where(CRMPair.net_deposits <= max_deposits)

        col_map = {
            "agent":    CRMPair.agent,
            "customer": CRMPair.customer,
            "crm":      CRMPair.crm_url,
            "calls":    CRMPair.call_count,
            "duration": CRMPair.total_duration_s,
            "deposits": CRMPair.net_deposits,
        }
        col = col_map.get(sort, CRMPair.agent)
        stmt = stmt.order_by(col.desc() if dir == "desc" else col.asc())

        pairs = db.exec(stmt).all()

        # Deduplicate by (agent, customer) — same customer can exist on multiple CRMs.
        # Keep the row with the highest call_count (the one with real local data).
        deduped: dict[tuple[str, str], CRMPair] = {}
        for p in pairs:
            key = (p.agent, p.customer)
            if key not in deduped or p.call_count > deduped[key].call_count:
                deduped[key] = p

        return [
            {
                "crm_url":        p.crm_url,
                "account_id":     p.account_id,
                "agent":          p.agent,
                "customer":       p.customer,
                "call_count":     p.call_count,
                "total_duration": p.total_duration_s,
                "nd": p.net_deposits,
                "td": p.total_deposits,
                "tw": p.total_withdrawals,
            }
            for p in deduped.values()
        ]
    except Exception as e:
        raise HTTPException(500, str(e))


@router.get("/customers")
def get_customers(crm: str = Query(""), agent: str = Query("")):
    try:
        return crm_service.get_customers(crm_filter=crm, agent_filter=agent)
    except Exception as e:
        raise HTTPException(500, str(e))


@router.get("/calls/{account_id}")
def get_calls(
    account_id: str,
    crm_url: str = Query(...),
    agent: str = Query(""),
    customer: str = Query(""),
):
    try:
        calls = crm_service.get_calls(account_id=account_id, crm_url=crm_url, agent=agent, customer=customer)
        result = []
        for c in calls:
            cid = str(c.get("call_id", c.get("id", "")))
            result.append({
                "call_id": cid,
                "date": c.get("started_at", c.get("date", "")),
                "duration": c.get("duration_s", c.get("duration", 0)),
                "record_path": c.get("record_path", ""),
            })
        return result
    except Exception as e:
        raise HTTPException(500, str(e))


@router.post("/calls/{account_id}/refresh")
def refresh_calls(
    account_id: str,
    crm_url: str = Query(...),
    agent: str = Query(""),
    customer: str = Query(""),
):
    result = crm_service.refresh_calls(account_id, crm_url, agent, customer)
    return {"ok": result["error"] is None, "count": result["count"], "error": result["error"]}


@router.post("/refresh")
def refresh_cache(background_tasks: BackgroundTasks):
    background_tasks.add_task(crm_service.refresh_pairs)
    return {"ok": True, "status": "refresh started in background"}


@router.post("/update-audio-lengths")
def update_audio_lengths(background_tasks: BackgroundTasks):
    """Scan all locally downloaded WAV files, update audio_duration_s in crm_call table."""
    def _run():
        import sys
        from pathlib import Path
        sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent))
        import wave
        from datetime import datetime, timezone
        from sqlmodel import Session, select
        from ui.backend.database import engine
        from ui.backend.models.crm import CRMCall
        from ui.backend.config import settings

        _AUDIO_EXTS = {".wav", ".mp3", ".m4a"}

        def _find(pair_dir, cid):
            for ext in _AUDIO_EXTS:
                p = pair_dir / cid / "audio" / "original" / f"{cid}{ext}"
                if p.exists():
                    return p
            for ext in _AUDIO_EXTS:
                p = pair_dir / "audio" / f"{cid}{ext}"
                if p.exists():
                    return p
            return None

        def _dur(path):
            try:
                with wave.open(str(path), "rb") as f:
                    return round(f.getnframes() / f.getframerate(), 2)
            except Exception:
                return None

        updated = 0
        with Session(engine) as db:
            calls = db.exec(select(CRMCall)).all()
            for row in calls:
                pair_dir = settings.agents_dir / row.agent / row.customer
                audio = _find(pair_dir, row.call_id)
                has_audio = audio is not None
                dur = _dur(audio) if audio and audio.suffix == ".wav" else None
                if has_audio != row.has_local_audio or dur != row.audio_duration_s:
                    row.has_local_audio = has_audio
                    row.audio_duration_s = dur
                    db.add(row)
                    updated += 1
            db.commit()
        print(f"[update-audio-lengths] Updated {updated} crm_call rows")

    background_tasks.add_task(_run)
    return {"ok": True, "status": "audio length scan started in background"}


@router.post("/authenticate")
def authenticate_crm(req: AuthRequest):
    """Manually obtain a session cookie for a CRM via web login and save it to .env.crm."""
    from shared.crm_client import get_session_cookie, save_session_cookie
    cookie = get_session_cookie(req.crm_url, req.email, req.password)
    if not cookie:
        raise HTTPException(400, f"Login failed for {req.crm_url} — check email/password")
    save_session_cookie(req.crm_url, cookie)
    return {"ok": True, "host": req.crm_url, "preview": cookie[:40] + "…"}


@router.get("/auth-status")
def auth_status():
    """Return which CRMs have session cookies configured, plus the configured login email."""
    from shared.crm_client import load_credentials
    creds = load_credentials()
    host0 = _host(creds.crm_urls[0]) if creds.crm_urls else ""
    default_email = creds.login_emails.get(host0, "")
    return {
        "default_email": default_email,
        "crms": [
            {"crm_url": url, "has_cookie": _host(url) in creds.session_cookies}
            for url in creds.crm_urls
        ],
    }


def _host(crm_url: str) -> str:
    return crm_url.replace("https://", "").replace("http://", "").split("/")[0]


@router.get("/nav/agents")
def nav_agents(db: Session = Depends(get_session)):
    """Unique agent names with customer count — for nav panels."""
    from sqlalchemy import func
    rows = db.exec(
        select(CRMPair.agent, func.count(CRMPair.id).label("c"))
        .group_by(CRMPair.agent)
        .order_by(CRMPair.agent)
    ).all()
    return [{"agent": r[0], "count": r[1]} for r in rows]


@router.get("/nav/customers")
def nav_customers(agent: str = Query(...), db: Session = Depends(get_session)):
    """All customers for an agent with account_id, crm_url, and call_count.
    Deduplicates by customer name, keeping the row with the highest call_count.
    """
    rows = db.exec(
        select(CRMPair.customer, CRMPair.account_id, CRMPair.crm_url, CRMPair.call_count)
        .where(CRMPair.agent == agent)
        .order_by(CRMPair.customer)
    ).all()
    best: dict[str, tuple] = {}
    for r in rows:
        if r[0] not in best or r[3] > best[r[0]][3]:
            best[r[0]] = r
    return [{"customer": r[0], "account_id": r[1], "crm_url": r[2], "call_count": r[3]}
            for r in sorted(best.values(), key=lambda r: r[0])]
