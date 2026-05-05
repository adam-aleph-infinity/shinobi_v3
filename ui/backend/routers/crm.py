from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, Request
from pydantic import BaseModel
from sqlmodel import Session, select
from typing import Optional
import re

from ui.backend.database import get_session
from ui.backend.models.crm import CRMPair
from ui.backend.services import crm_service, execution_logs

router = APIRouter(prefix="/crm", tags=["crm"])


class AuthRequest(BaseModel):
    crm_url: str
    email: str
    password: str


def _norm_agent_name(value: str) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip()).lower()


def _build_account_agent_uniqueness_index(
    db: Session,
    *,
    account_ids: Optional[set[str]] = None,
) -> dict[str, dict[str, object]]:
    """
    Returns:
      {
        "<account_id>": {
          "is_unique": bool,
          "agent_count": int,
          "agents_canonical": list[str],
        }
      }
    """
    stmt = select(CRMPair.account_id, CRMPair.agent)
    cleaned_ids = sorted(
        {
            str(a or "").strip()
            for a in (account_ids or set())
            if str(a or "").strip()
        }
    )
    if cleaned_ids:
        stmt = stmt.where(CRMPair.account_id.in_(cleaned_ids))

    rows = db.exec(stmt).all()
    if not rows:
        return {}

    raw_names = sorted(
        {
            str(agent_raw or "").strip()
            for _account_id_raw, agent_raw in rows
            if str(agent_raw or "").strip()
        }
    )
    alias_map: dict[str, str] = {}
    try:
        from ui.backend.services.crm_service import _auto_detect_re_aliases, _load_aliases

        alias_map = {**_auto_detect_re_aliases(raw_names), **_load_aliases()}
    except Exception:
        alias_map = {}

    account_agents: dict[str, set[str]] = {}
    for account_id_raw, agent_raw in rows:
        account_id = str(account_id_raw or "").strip()
        if not account_id:
            continue
        raw_agent = str(agent_raw or "").strip()
        canonical = str(alias_map.get(raw_agent) or raw_agent).strip()
        canonical_norm = _norm_agent_name(canonical)
        if not canonical_norm:
            continue
        account_agents.setdefault(account_id, set()).add(canonical_norm)

    out: dict[str, dict[str, object]] = {}
    for account_id, agents in account_agents.items():
        agents_sorted = sorted(agents)
        out[account_id] = {
            "is_unique": len(agents_sorted) <= 1,
            "agent_count": len(agents_sorted),
            "agents_canonical": agents_sorted,
        }
    return out


@router.get("/pairs")
def get_pairs(
    crm: str = Query(""),
    agent: str = Query(""),
    agent_exact: bool = Query(False),  # True = exact match, False = LIKE (for search)
    customer: str = Query(""),
    account_id: str = Query(""),
    sort: str = Query("agent"),       # agent|customer|crm|calls|duration|deposits
    dir: str = Query("asc"),          # asc|desc
    min_calls: int = Query(0),
    min_duration: float = Query(0.0),  # hours
    min_deposits: float = Query(0.0),  # net deposits minimum (per customer)
    max_deposits: float = Query(0.0),  # net deposits maximum (per customer)
    min_agent_deposits: float = Query(0.0),  # min total net dep across all agent's customers
    max_agent_deposits: float = Query(0.0),  # max total net dep across all agent's customers
    ftd_after: str = Query(""),        # ISO date string, e.g. "2025-01-01"
    ftd_before: str = Query(""),       # ISO date string, e.g. "2025-12-31"
    limit: int = Query(0, ge=0, le=20000),   # 0 = no limit (legacy behavior)
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_session),
):
    from sqlalchemy import func as sa_func, select as sa_select
    try:
        stmt = select(CRMPair)
        if crm:
            stmt = stmt.where(CRMPair.crm_url.ilike(f"%{crm}%"))
        if agent:
            if agent_exact:
                stmt = stmt.where(CRMPair.agent.ilike(agent))
            else:
                stmt = stmt.where(CRMPair.agent.ilike(f"%{agent}%"))
        if customer:
            stmt = stmt.where(CRMPair.customer.ilike(f"%{customer}%"))
        if account_id:
            stmt = stmt.where(CRMPair.account_id.ilike(f"%{account_id}%"))
        if min_calls:
            stmt = stmt.where(CRMPair.call_count >= min_calls)
        if min_duration:
            stmt = stmt.where(CRMPair.total_duration_s >= int(min_duration * 3600))
        if min_deposits:
            stmt = stmt.where(CRMPair.net_deposits >= min_deposits)
        if max_deposits:
            stmt = stmt.where(CRMPair.net_deposits <= max_deposits)
        if ftd_after:
            stmt = stmt.where(CRMPair.ftd_at >= ftd_after)
        if ftd_before:
            # ftd_at is stored as a full ISO datetime string (e.g. "2025-01-15T10:30:45Z")
            # appending T23:59:59 ensures date-only input includes the full day
            stmt = stmt.where(CRMPair.ftd_at <= ftd_before + "T23:59:59")

        # Per-agent aggregate deposit filter via subquery
        if min_agent_deposits or max_agent_deposits:
            agent_nd = (
                sa_select(CRMPair.agent, sa_func.sum(CRMPair.net_deposits).label("total_nd"))
                .group_by(CRMPair.agent)
                .subquery()
            )
            stmt = stmt.join(agent_nd, CRMPair.agent == agent_nd.c.agent)
            if min_agent_deposits:
                stmt = stmt.where(agent_nd.c.total_nd >= min_agent_deposits)
            if max_agent_deposits:
                stmt = stmt.where(agent_nd.c.total_nd <= max_agent_deposits)

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
        if offset:
            stmt = stmt.offset(int(offset))
        if limit:
            stmt = stmt.limit(int(limit))

        pairs = db.exec(stmt).all()
        uniqueness_index = _build_account_agent_uniqueness_index(
            db,
            account_ids={
                str(getattr(p, "account_id", "") or "").strip()
                for p in pairs
                if str(getattr(p, "account_id", "") or "").strip()
            },
        )
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
                "ftd_at": p.ftd_at,
                "pair_is_unique": bool(
                    (uniqueness_index.get(str(p.account_id or "").strip()) or {}).get("is_unique", True)
                ),
                "pair_agent_count": int(
                    (uniqueness_index.get(str(p.account_id or "").strip()) or {}).get("agent_count", 1) or 1
                ),
            }
            for p in pairs
        ]
    except Exception as e:
        raise HTTPException(500, str(e))


@router.get("/crm-urls")
def get_crm_urls(db: Session = Depends(get_session)):
    """Returns distinct CRM base URLs for the CRM filter dropdown."""
    try:
        rows = db.exec(
            select(CRMPair.crm_url).distinct().order_by(CRMPair.crm_url)
        ).all()
        return [str(url).strip() for url in rows if str(url or "").strip()]
    except Exception as e:
        raise HTTPException(500, str(e))


@router.get("/pairs-count")
def get_pairs_count(db: Session = Depends(get_session)):
    """Returns total CRM pair count without loading rows."""
    from sqlalchemy import func as sa_func

    try:
        total = db.exec(select(sa_func.count()).select_from(CRMPair)).one()
        if isinstance(total, (tuple, list)):
            total = total[0] if total else 0
        return {"count": int(total or 0)}
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
                stmt = stmt.where(CRMPair.agent.ilike(agent))
            else:
                stmt = stmt.where(CRMPair.agent.ilike(f"%{agent}%"))
        if customer:
            stmt = stmt.where(CRMPair.customer.ilike(f"%{customer}%"))
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


@router.get("/calls-by-pair")
def calls_by_pair(
    agent: str = Query(...),
    customer: str = Query(""),
    auto_sync: bool = Query(True, description="Auto-refresh missing calls for this pair before returning"),
    max_refresh_pairs: int = Query(4, ge=1, le=20),
    db: Session = Depends(get_session),
):
    """Return calls for an agent/customer pair (alias-aware).
    Prefers local files/DB; auto-syncs missing call sets from CRM when needed."""
    from sqlalchemy import or_
    from ui.backend.models.crm import CRMCall
    from ui.backend.services.crm_service import _load_aliases, _auto_detect_re_aliases

    file_aliases = _load_aliases()
    auto_aliases = _auto_detect_re_aliases([agent])
    all_aliases  = {**auto_aliases, **file_aliases}
    alias_names  = [k for k, v in all_aliases.items() if v == agent]
    all_names    = [agent] + alias_names

    if len(all_names) == 1:
        cond = CRMCall.agent == agent
    else:
        cond = or_(*[CRMCall.agent == n for n in all_names])

    # Determine relevant CRM account targets from crm_pair first.
    pair_stmt = select(CRMPair)
    if len(all_names) == 1:
        pair_stmt = pair_stmt.where(CRMPair.agent == agent)
    else:
        pair_stmt = pair_stmt.where(or_(*[CRMPair.agent == n for n in all_names]))
    if customer:
        pair_stmt = pair_stmt.where(CRMPair.customer == customer)
    pair_rows = db.exec(pair_stmt).all()

    # Fall back to legacy crm_call rows if no pair rows are found.
    if not pair_rows:
        stmt = select(CRMCall).where(cond)
        if customer:
            stmt = stmt.where(CRMCall.customer == customer)
        rows = db.exec(stmt.order_by(CRMCall.started_at)).all()
        return [
            {
                "call_id":      r.call_id,
                "date":         r.started_at or "",
                "duration":     int(r.audio_duration_s if r.audio_duration_s is not None else (r.duration_s or 0)),
                "record_path":  r.record_path or "",
                "crm_url":      r.crm_url,
                "account_id":   r.account_id,
            }
            for r in rows
        ]

    targets: list[tuple[str, str, str, int]] = []
    seen_targets: set[tuple[str, str]] = set()
    for p in pair_rows:
        crm_url = str(p.crm_url or "").strip()
        account_id = str(p.account_id or "").strip()
        cust = str(p.customer or customer or "").strip()
        if not crm_url or not account_id:
            continue
        key = (crm_url, account_id)
        if key in seen_targets:
            continue
        seen_targets.add(key)
        targets.append((crm_url, account_id, cust, int(p.call_count or 0)))

    # Auto-heal: refresh only targets that are clearly missing local calls.
    if auto_sync:
        refreshed = 0
        for crm_url, account_id, cust, expected_count in targets:
            if refreshed >= int(max_refresh_pairs):
                break
            local_calls = crm_service.get_calls_local(crm_url=crm_url, agent=agent, customer=cust)
            local_count = len(local_calls or [])
            needs_refresh = False
            if expected_count > 0:
                # tolerate a tiny drift (1 call) to avoid unnecessary frequent refresh.
                needs_refresh = (local_count + 1) < expected_count
            elif local_count == 0:
                needs_refresh = True
            if not needs_refresh:
                continue
            try:
                crm_service.refresh_calls(
                    account_id=account_id,
                    crm_url=crm_url,
                    agent=agent,
                    customer=cust,
                )
                refreshed += 1
            except Exception:
                # best-effort; we'll still return whatever is available
                pass

    # Merge calls from all discovered account targets.
    merged: dict[tuple[str, str], dict] = {}
    for crm_url, account_id, cust, _expected_count in targets:
        # Prefer calls.json (freshly refreshed) over legacy crm_call rows.
        calls = crm_service.get_calls_local(crm_url=crm_url, agent=agent, customer=cust)
        if not calls:
            calls = crm_service.get_calls(
                account_id=account_id,
                crm_url=crm_url,
                agent=agent,
                customer=cust,
            )
        for c in calls or []:
            cid = str(c.get("call_id", c.get("id", ""))).strip()
            if not cid:
                continue
            key = (crm_url, cid)
            started_at = str(c.get("started_at", c.get("date", "")) or "").strip()
            duration_val = c.get("audio_duration_s", c.get("duration_s", c.get("duration", 0)))
            try:
                duration = int(float(duration_val or 0))
            except Exception:
                duration = 0
            merged[key] = {
                "call_id": cid,
                "date": started_at,
                "duration": duration,
                "record_path": str(c.get("record_path", "")),
                "crm_url": crm_url,
                "account_id": account_id,
            }

    out = list(merged.values())
    out.sort(key=lambda row: str(row.get("date") or ""))
    return out


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
    request: Request,
    crm_url: str = Query(...),
    agent: str = Query(""),
    customer: str = Query(""),
):
    client_local_time = request.headers.get("x-client-local-time", "")
    client_timezone = request.headers.get("x-client-timezone", "")
    session_id = execution_logs.start_session(
        action="crm_refresh_calls",
        source="backend",
        context={
            "crm_url": crm_url,
            "account_id": str(account_id),
            "agent": agent,
            "customer": customer,
        },
        client_local_time=client_local_time,
        client_timezone=client_timezone,
    )
    execution_logs.append_event(
        session_id,
        "CRM call refresh started",
        level="stage",
        status="running",
    )
    try:
        result = crm_service.refresh_calls(account_id, crm_url, agent, customer)
        ok = result["error"] is None
        execution_logs.append_event(
            session_id,
            "CRM call refresh completed",
            level="info" if ok else "error",
            status="success" if ok else "failed",
            data={"count": int(result.get("count") or 0), "error": result.get("error")},
            error=str(result.get("error") or ""),
        )
        execution_logs.finish_session(
            session_id,
            status="success" if ok else "failed",
            report={
                "count": int(result.get("count") or 0),
                "error": result.get("error"),
            },
            error=str(result.get("error") or ""),
        )
        return {
            "ok": ok,
            "count": result["count"],
            "error": result["error"],
            "execution_session_id": session_id,
        }
    except Exception as exc:
        execution_logs.append_event(
            session_id,
            "CRM call refresh crashed",
            level="error",
            status="failed",
            error=str(exc),
        )
        execution_logs.finish_session(
            session_id,
            status="failed",
            report={"count": 0},
            error=str(exc),
        )
        raise


@router.post("/refresh")
def refresh_cache(background_tasks: BackgroundTasks, request: Request):
    client_local_time = request.headers.get("x-client-local-time", "")
    client_timezone = request.headers.get("x-client-timezone", "")
    session_id = execution_logs.start_session(
        action="crm_refresh_pairs",
        source="backend",
        context={"trigger": "ui"},
        client_local_time=client_local_time,
        client_timezone=client_timezone,
    )

    def _run_refresh(sid: str):
        execution_logs.append_event(
            sid,
            "CRM pairs refresh started",
            level="stage",
            status="running",
        )
        try:
            result = crm_service.refresh_pairs()
            errors = result.get("errors") or []
            status = "success" if not errors else "completed_with_errors"
            execution_logs.append_event(
                sid,
                "CRM pairs refresh completed",
                level="info" if not errors else "warn",
                status=status,
                data={"count": int(result.get("count") or 0), "errors": errors},
                error="; ".join(str(e) for e in errors[:10]),
            )
            execution_logs.finish_session(
                sid,
                status=status,
                report=result,
                error="; ".join(str(e) for e in errors[:10]),
            )
        except Exception as exc:
            execution_logs.append_event(
                sid,
                "CRM pairs refresh crashed",
                level="error",
                status="failed",
                error=str(exc),
            )
            execution_logs.finish_session(
                sid,
                status="failed",
                report={"count": 0, "errors": [str(exc)]},
                error=str(exc),
            )

    background_tasks.add_task(_run_refresh, session_id)
    return {"ok": True, "status": "refresh started in background", "execution_session_id": session_id}


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


@router.get("/call-dates")
def get_call_dates(
    agent: str = Query(...),
    customer: str = Query(...),
    db: Session = Depends(get_session),
):
    """Return {call_id: {date, has_audio}} for all calls of an agent-customer pair (including aliases).
    Checks DB first, then falls back to calls.json on disk."""
    import json as _json
    from ui.backend.models.crm import CRMCall
    from ui.backend.services.crm_service import _load_aliases
    from ui.backend.config import settings
    from sqlalchemy import or_
    aliases = _load_aliases()
    agent_names = [agent] + [a for a, p in aliases.items() if p == agent]

    # DB lookup — include has_local_audio
    stmt = select(CRMCall.call_id, CRMCall.started_at, CRMCall.has_local_audio).where(CRMCall.customer == customer)
    if len(agent_names) == 1:
        stmt = stmt.where(CRMCall.agent == agent)
    else:
        stmt = stmt.where(or_(*[CRMCall.agent == n for n in agent_names]))
    result: dict = {}
    for r in db.exec(stmt).all():
        if r[0] and r[1]:
            result[r[0]] = {"date": str(r[1]), "has_audio": bool(r[2])}

    # Fallback: read calls.json for any call IDs not in DB
    for a in agent_names:
        calls_path = settings.agents_dir / a / customer / "calls.json"
        if calls_path.exists():
            try:
                for c in _json.loads(calls_path.read_text()):
                    cid = str(c.get("call_id", ""))
                    if cid and cid not in result:
                        date = c.get("started_at") or c.get("date", "")
                        if date:
                            result[cid] = {
                                "date": str(date),
                                "has_audio": bool(c.get("has_local_audio", False)),
                            }
            except Exception:
                pass

    return result


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
    Queries canonical name + all known aliases so unmerged alias rows are included.
    Deduplicates by customer name, keeping the row with the highest call_count.
    """
    from sqlalchemy import or_
    from ui.backend.services.crm_service import _load_aliases, _auto_detect_re_aliases

    file_aliases = _load_aliases()
    auto_aliases = _auto_detect_re_aliases([agent])
    all_aliases  = {**auto_aliases, **file_aliases}
    alias_names  = [k for k, v in all_aliases.items() if v == agent]
    all_names    = [agent] + alias_names  # canonical first

    if len(all_names) == 1:
        cond = CRMPair.agent == agent
    else:
        cond = or_(*[CRMPair.agent == n for n in all_names])

    rows = db.exec(
        select(CRMPair.customer, CRMPair.account_id, CRMPair.crm_url, CRMPair.call_count)
        .where(cond)
        .order_by(CRMPair.customer)
    ).all()

    best: dict[str, tuple] = {}
    for r in rows:
        if r[0] not in best or r[3] > best[r[0]][3]:
            best[r[0]] = r
    return [{"customer": r[0], "account_id": r[1], "crm_url": r[2], "call_count": r[3]}
            for r in sorted(best.values(), key=lambda r: r[0])]
