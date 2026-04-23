"""Agent summary statistics — total calls, customers, deposits, session analysis insights."""
from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select
from sqlalchemy import func, or_

from ui.backend.database import get_session
from ui.backend.models.crm import CRMPair, CRMCall

router = APIRouter(prefix="/agent-stats", tags=["agent-stats"])


def _norm_name(v: str) -> str:
    return " ".join((v or "").split()).strip().casefold()


def _to_float(v) -> float:
    try:
        if v is None:
            return 0.0
        if isinstance(v, (int, float)):
            return float(v)
        s = str(v).strip().replace(",", "")
        return float(s) if s else 0.0
    except Exception:
        return 0.0


def _dedupe_pairs_with_deposits(
    pairs: list[CRMPair],
    key_fn,
) -> list[dict]:
    """Deduplicate pair rows but preserve non-zero deposit fields.

    Some duplicate rows differ only by sync/source quality:
    - one may have the highest call_count
    - another may hold the non-zero deposit fields
    This keeps call_count/duration from the best activity row while taking
    strongest deposit values from duplicate siblings.
    """
    grouped: dict[tuple, list[CRMPair]] = {}
    for p in pairs:
        grouped.setdefault(key_fn(p), []).append(p)

    out: list[dict] = []
    for rows in grouped.values():
        activity = max(rows, key=lambda r: (r.call_count or 0, r.total_duration_s or 0))
        net_dep = max((_to_float(r.net_deposits) for r in rows), key=abs, default=0.0)
        total_dep = max((_to_float(r.total_deposits) for r in rows), default=0.0)
        total_with = max((_to_float(r.total_withdrawals) for r in rows), default=0.0)
        out.append({
            "agent": activity.agent,
            "customer": activity.customer,
            "call_count": activity.call_count or 0,
            "total_duration_s": activity.total_duration_s or 0,
            "net_deposits": net_dep,
            "total_deposits": total_dep,
            "total_withdrawals": total_with,
        })
    return out


@router.get("")
def list_agent_stats(db: Session = Depends(get_session)):
    """Summary row per agent across all CRMs."""
    all_pairs = db.exec(select(CRMPair)).all()
    deduped = _dedupe_pairs_with_deposits(all_pairs, key_fn=lambda p: (p.agent, p.customer))

    # Aggregate per agent
    agents_map: dict[str, dict] = {}
    for p in deduped:
        a = agents_map.setdefault(p["agent"], {
            "agent": p["agent"],
            "total_calls": 0,
            "unique_customers": 0,
            "net_deposits": 0.0,
            "total_deposits": 0.0,
        })
        a["total_calls"] += p["call_count"]
        a["unique_customers"] += 1
        a["net_deposits"] += p["net_deposits"]
        a["total_deposits"] += p["total_deposits"]

    # Avg call duration (>120s) per agent from crm_call table
    dur_rows = db.exec(
        select(CRMCall.agent, func.avg(CRMCall.duration_s).label("avg_dur"))
        .where(CRMCall.duration_s > 120)
        .group_by(CRMCall.agent)
    ).all()
    dur_map = {r[0]: r[1] for r in dur_rows}

    # Session analysis count + avg score per agent
    try:
        from ui.backend.models.session_analysis import SessionAnalysis
        sa_rows = db.exec(
            select(
                SessionAnalysis.agent,
                func.count(SessionAnalysis.id).label("sa_count"),
                func.avg(SessionAnalysis.score).label("avg_score"),
            ).group_by(SessionAnalysis.agent)
        ).all()
        sa_map = {r[0]: {"count": r[1], "avg_score": round(r[2] or 0, 1)} for r in sa_rows}
    except Exception:
        sa_map = {}

    result = []
    for agent, a in agents_map.items():
        sa = sa_map.get(agent, {"count": 0, "avg_score": None})
        result.append({
            **a,
            "avg_call_duration_s": round(dur_map.get(agent) or 0),
            "session_analysis_count": sa["count"],
            "avg_score": sa["avg_score"],
        })

    result.sort(key=lambda x: x["net_deposits"] or 0, reverse=True)
    return result


@router.get("/pair")
def get_pair_stats(
    agent: str,
    customer: str,
    db: Session = Depends(get_session),
):
    """Stats for one agent/customer pair (deduped, deposit-safe)."""
    agent = (agent or "").strip()
    customer = (customer or "").strip()
    if not agent or not customer:
        raise HTTPException(400, "agent and customer are required")

    # Resolve alias family for robust matching (canonical + known aliases).
    from ui.backend.services.crm_service import _load_aliases, _auto_detect_re_aliases

    all_agents = [r[0] for r in db.exec(select(CRMPair.agent).distinct()).all() if r and r[0]]
    aliases = {**_auto_detect_re_aliases(all_agents), **_load_aliases()}
    canonical_agent = aliases.get(agent, agent)
    alias_names = [a for a, p in aliases.items() if p == canonical_agent]
    candidate_agents = sorted(set([agent, canonical_agent, *alias_names]))
    candidate_agent_norms = sorted({_norm_name(a) for a in candidate_agents if _norm_name(a)})
    customer_norm = _norm_name(customer)

    # Prefer strict equality first.
    rows = db.exec(
        select(CRMPair).where(
            or_(*[CRMPair.agent == a for a in candidate_agents]),
            CRMPair.customer == customer,
        )
    ).all()
    # Fallback: normalized whitespace/case match.
    if not rows:
        rows = db.exec(
            select(CRMPair).where(
                or_(*[(func.lower(func.trim(CRMPair.agent)) == a_norm) for a_norm in candidate_agent_norms]),
                func.lower(func.trim(CRMPair.customer)) == customer_norm,
            )
        ).all()
    # Last fallback: in-memory normalization (handles internal multi-space variants).
    if not rows:
        broad_rows = db.exec(
            select(CRMPair).where(
                or_(*[(func.lower(func.trim(CRMPair.agent)) == a_norm) for a_norm in candidate_agent_norms]),
            )
        ).all()
        rows = [r for r in broad_rows if _norm_name(r.customer) == customer_norm]

    if not rows:
        return {
            "agent": canonical_agent,
            "customer": customer,
            "not_found": True,
            "call_count": 0,
            "total_duration_s": 0,
            "net_deposits": 0.0,
            "total_deposits": 0.0,
            "total_withdrawals": 0.0,
        }

    merged = _dedupe_pairs_with_deposits(rows, key_fn=lambda p: (_norm_name(p.agent), _norm_name(p.customer)))[0]
    return {
        "agent": merged["agent"],
        "customer": merged["customer"],
        "call_count": merged["call_count"],
        "total_duration_s": merged["total_duration_s"],
        "net_deposits": merged["net_deposits"],
        "total_deposits": merged["total_deposits"],
        "total_withdrawals": merged["total_withdrawals"],
        "duplicate_rows_merged": len(rows),
    }


@router.get("/{agent}")
def get_agent_stats(agent: str, db: Session = Depends(get_session)):
    """Deep stats for a single agent."""
    pairs = db.exec(select(CRMPair).where(CRMPair.agent == agent)).all()
    if not pairs:
        return {"agent": agent, "not_found": True}

    deduped = _dedupe_pairs_with_deposits(pairs, key_fn=lambda p: p.customer)

    total_calls = sum(p["call_count"] for p in deduped)
    unique_customers = len(deduped)
    net_deposits = sum(p["net_deposits"] for p in deduped)
    total_deposits = sum(p["total_deposits"] for p in deduped)
    total_withdrawals = sum(p["total_withdrawals"] for p in deduped)

    call_rows = db.exec(
        select(CRMCall)
        .where(CRMCall.agent == agent, CRMCall.duration_s > 120)
    ).all()
    avg_duration = (
        sum(c.duration_s or 0 for c in call_rows) / len(call_rows)
        if call_rows else 0
    )

    # Session analysis insights
    session_count = avg_score = 0
    topic_counts: dict[str, int] = {}
    top_improvements: list[str] = []
    try:
        import json, re
        from ui.backend.models.session_analysis import SessionAnalysis
        sa_rows = db.exec(
            select(SessionAnalysis).where(SessionAnalysis.agent == agent)
        ).all()
        session_count = len(sa_rows)
        scores = [r.score for r in sa_rows if r.score is not None]
        avg_score = round(sum(scores) / len(scores), 1) if scores else 0

        # Count topics from analysis_md section headers
        for row in sa_rows:
            for m in re.finditer(r"^##\s+(.+)", row.analysis_md or "", re.MULTILINE):
                topic = m.group(1).strip()
                topic_counts[topic] = topic_counts.get(topic, 0) + 1
            # Count improvement items
            try:
                items = json.loads(row.improvement_items or "[]")
                for item in items[:3]:
                    if isinstance(item, str) and len(item) < 120:
                        top_improvements.append(item)
            except Exception:
                pass

        # Keep top 10 improvements by frequency
        from collections import Counter
        top_improvements = [i for i, _ in Counter(top_improvements).most_common(10)]
    except Exception:
        pass

    return {
        "agent": agent,
        "total_calls": total_calls,
        "unique_customers": unique_customers,
        "net_deposits": net_deposits,
        "total_deposits": total_deposits,
        "total_withdrawals": total_withdrawals,
        "avg_call_duration_s": round(avg_duration),
        "session_analysis_count": session_count,
        "avg_score": avg_score,
        "topic_counts": dict(sorted(topic_counts.items(), key=lambda x: -x[1])[:12]),
        "top_improvements": top_improvements,
    }
