"""Agent summary statistics — total calls, customers, deposits, session analysis insights."""
from fastapi import APIRouter, Depends
from sqlmodel import Session, select
from sqlalchemy import func

from ui.backend.database import get_session
from ui.backend.models.crm import CRMPair, CRMCall

router = APIRouter(prefix="/agent-stats", tags=["agent-stats"])


@router.get("")
def list_agent_stats(db: Session = Depends(get_session)):
    """Summary row per agent across all CRMs."""
    all_pairs = db.exec(select(CRMPair)).all()

    # Deduplicate per (agent, customer) — same logic as detail endpoint —
    # keeps the row with the highest call_count to avoid double-counting
    # when multiple CRM syncs create duplicate rows for the same pair.
    best: dict[tuple, CRMPair] = {}
    for p in all_pairs:
        key = (p.agent, p.customer)
        if key not in best or (p.call_count or 0) > (best[key].call_count or 0):
            best[key] = p
    deduped = list(best.values())

    # Aggregate per agent
    agents_map: dict[str, dict] = {}
    for p in deduped:
        a = agents_map.setdefault(p.agent, {
            "agent": p.agent,
            "total_calls": 0,
            "unique_customers": 0,
            "net_deposits": 0.0,
            "total_deposits": 0.0,
        })
        a["total_calls"] += p.call_count or 0
        a["unique_customers"] += 1
        a["net_deposits"] += p.net_deposits or 0
        a["total_deposits"] += p.total_deposits or 0

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


@router.get("/{agent}")
def get_agent_stats(agent: str, db: Session = Depends(get_session)):
    """Deep stats for a single agent."""
    pairs = db.exec(select(CRMPair).where(CRMPair.agent == agent)).all()
    if not pairs:
        return {"agent": agent, "not_found": True}

    # Deduplicate by customer name, keeping highest call_count row
    best: dict[str, CRMPair] = {}
    for p in pairs:
        if p.customer not in best or (p.call_count or 0) > (best[p.customer].call_count or 0):
            best[p.customer] = p
    deduped = list(best.values())

    total_calls = sum(p.call_count or 0 for p in deduped)
    unique_customers = len(deduped)
    net_deposits = sum(p.net_deposits or 0 for p in deduped)
    total_deposits = sum(p.total_deposits or 0 for p in deduped)
    total_withdrawals = sum(p.total_withdrawals or 0 for p in deduped)

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
