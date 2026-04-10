"""
Full top-down data sync endpoint — streams SSE progress to the browser.

Stages:
  1. CRM pairs   — fetch pair list from all CRM APIs, write manifest.json for new pairs
  2. Deposits    — fetch account-level financial data, write crm_info.json per pair
  3. Index       — scan ui/data/agents/ filesystem, rebuild ui/data/index.json
  4. DB          — upsert crm_pair table from index.json (single source of truth)

ui/data/index.json is the master index: all UI reads come from here first.
"""
from __future__ import annotations

import asyncio
import json
import queue
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import StreamingResponse

from ui.backend.config import settings

router = APIRouter(prefix="/sync", tags=["sync"])

_sync_lock = threading.Lock()
_sync_running = False


def _emit(q: queue.Queue, stage: int, msg: str, **kw):
    q.put({"stage": stage, "msg": msg, **kw})


def _load_aliases() -> dict[str, str]:
    """Load agent_aliases.json → {alias: primary}."""
    aliases_file = Path(__file__).parent.parent / "agent_aliases.json"
    if aliases_file.exists():
        try:
            return json.loads(aliases_file.read_text())
        except Exception:
            pass
    return {}


def _run_sync(q: queue.Queue) -> None:
    global _sync_running
    total_start = time.time()

    try:
        aliases = _load_aliases()
        alias_agents: set[str] = set(aliases.keys())

        # ── Stage 1: CRM pairs + manifest creation ──────────────────────────
        _emit(q, 1, "Fetching pair list from CRM APIs…")
        try:
            from ui.backend.services import crm_service
            result = crm_service.refresh_pairs()
            errors = result.get("errors", [])

            # Write manifest.json for any pair that doesn't have a local directory yet
            cache_path = settings.ui_data_dir / "all_crm_agents_customers.json"
            manifests_created = 0
            if cache_path.exists():
                try:
                    pairs_data = json.loads(cache_path.read_text())
                    for p in pairs_data:
                        agent = p.get("agent", "")
                        customer = p.get("customer", "")
                        if not agent or not customer or agent in alias_agents:
                            continue
                        pair_dir = settings.agents_dir / agent / customer
                        mf_path = pair_dir / "manifest.json"
                        if not mf_path.exists():
                            pair_dir.mkdir(parents=True, exist_ok=True)
                            mf_path.write_text(json.dumps({
                                "agent": agent,
                                "customer": customer,
                                "crm": p.get("crm", p.get("crm_url", "")),
                                "account_id": p.get("account_id"),
                            }, indent=2))
                            manifests_created += 1
                except Exception as e:
                    _emit(q, 1, f"Manifest creation warning: {e}", warning=True)

            msg = f"Pairs refreshed — {result['count']} pairs"
            if manifests_created:
                msg += f", {manifests_created} new manifests"
            if errors:
                msg += f", {len(errors)} CRM error(s)"
            _emit(q, 1, msg, done=True, count=result["count"],
                  errors=[str(e) for e in errors])
        except Exception as e:
            _emit(q, 1, f"CRM pairs failed: {e}", error=True)

        # ── Stage 2: Deposits → crm_info.json per pair ──────────────────────
        _emit(q, 2, "Fetching deposit data from CRM…")
        try:
            from shared.crm_client import load_credentials, fetch_accounts

            creds = load_credentials()
            cache_path = settings.ui_data_dir / "all_crm_agents_customers.json"
            cache: list[dict] = []
            if cache_path.exists():
                try:
                    cache = json.loads(cache_path.read_text())
                except Exception:
                    pass

            # Build lookup: (crm_url, account_id) → list of (agent, customer)
            # Multiple agents can share the same account_id — store all of them
            pair_lookup: dict[tuple[str, int], list[tuple[str, str]]] = {}
            crm_agents: dict[str, list[str]] = {}
            for row in cache:
                crm = row.get("crm", "")
                ag = row.get("agent", "")
                try:
                    acc_id = int(row.get("account_id", 0))
                except (ValueError, TypeError):
                    continue
                if crm and ag:
                    key = (crm, acc_id)
                    if key not in pair_lookup:
                        pair_lookup[key] = []
                    pair_lookup[key].append((ag, row.get("customer", "")))
                    if crm not in crm_agents:
                        crm_agents[crm] = []
                    if ag not in crm_agents[crm]:
                        crm_agents[crm].append(ag)

            total_crms = len(crm_agents)
            dep_updated = dep_errors = 0

            def _fetch_batch_with_retry(crm_url: str, all_agents: list[str]) -> list:
                for attempt in range(3):
                    try:
                        return fetch_accounts(
                            crm_url, creds, callers=all_agents,
                            date_start="01/01/2025 00:00", date_end="01/04/2026 00:00",
                        )
                    except Exception as exc:
                        msg = str(exc)
                        if "tooManyAttempts" in msg and attempt < 2:
                            wait = 60 * (attempt + 1)
                            _emit(q, 2,
                                  f"Rate limited — waiting {wait}s (attempt {attempt + 1}/3)…",
                                  warning=True)
                            time.sleep(wait)
                            continue
                        raise
                return []

            for crm_idx, (crm_url, agents) in enumerate(sorted(crm_agents.items())):
                host = crm_url.replace("https://", "").split("/")[0]
                _emit(q, 2, f"{host} — {len(agents)} agents ({crm_idx + 1}/{total_crms})",
                      index=crm_idx + 1, total=total_crms)
                try:
                    raw = _fetch_batch_with_retry(crm_url, sorted(agents))
                    now_str = datetime.now(timezone.utc).isoformat()
                    n = 0

                    for agent_row in raw:
                        for acc in agent_row.get("accounts", []):
                            acc_id = acc.get("id")
                            if acc_id is None:
                                continue
                            try:
                                acc_id_int = int(acc_id)
                            except (ValueError, TypeError):
                                continue

                            nd = acc.get("total_net_deposits")
                            td = acc.get("total_deposits")
                            tw = acc.get("total_withdrawals")
                            if nd is None and td is None and tw is None:
                                continue  # no deposit data (missing session cookie?)

                            agent_pairs = pair_lookup.get((crm_url, acc_id_int), [])
                            if not agent_pairs:
                                continue

                            # Write deposit data to crm_info.json for EVERY agent on this account
                            for agent_name, customer_name in agent_pairs:
                                if not agent_name or not customer_name:
                                    continue
                                pair_dir = settings.agents_dir / agent_name / customer_name
                                if not pair_dir.exists():
                                    pair_dir.mkdir(parents=True, exist_ok=True)

                                crm_info_path = pair_dir / "crm_info.json"
                                existing: dict = {}
                                if crm_info_path.exists():
                                    try:
                                        existing = json.loads(crm_info_path.read_text())
                                    except Exception:
                                        pass

                                changed = False
                                if nd is not None:
                                    existing["net_deposits"] = nd
                                    changed = True
                                if td is not None:
                                    existing["total_deposits"] = td
                                    changed = True
                                if tw is not None:
                                    existing["total_withdrawals"] = tw
                                    changed = True
                                if changed:
                                    existing["last_synced_at"] = now_str
                                    crm_info_path.write_text(json.dumps(existing, indent=2))
                                    n += 1

                    dep_updated += n
                    _emit(q, 2, f"{host} — {n} crm_info.json files updated")
                except Exception as e:
                    msg = str(e)
                    if "<" in msg:
                        msg = msg.split("<")[0].strip().rstrip(":").strip()
                    _emit(q, 2, f"{host} error: {msg}", warning=True)
                    dep_errors += 1

                if crm_idx < total_crms - 1:
                    time.sleep(3)

            _emit(q, 2,
                  f"Deposits done — {dep_updated} crm_info.json files updated"
                  + (f", {dep_errors} error(s)" if dep_errors else ""),
                  done=True, updated=dep_updated, errors=dep_errors)

        except Exception as e:
            _emit(q, 2, f"Deposits stage failed: {e}", error=True)

        # ── Stage 3: Rebuild index.json from filesystem ──────────────────────
        _emit(q, 3, "Rebuilding index from filesystem…")
        try:
            # Load existing DB deposits as fallback for pairs where crm_info.json
            # has no deposit data (e.g. session cookie missing during Stage 2).
            # Key: (crm_url, str(account_id), agent) → {nd, td, tw}
            db_deposit_fallback: dict[tuple[str, str, str], dict] = {}
            try:
                from sqlmodel import Session as _Sess, select as _sel
                from ui.backend.database import engine as _eng
                from ui.backend.models.crm import CRMPair as _CP
                with _Sess(_eng) as _db:
                    for _row in _db.exec(_sel(_CP)).all():
                        if _row.net_deposits or _row.total_deposits or _row.total_withdrawals:
                            db_deposit_fallback[
                                (_row.crm_url, str(_row.account_id), _row.agent)
                            ] = {
                                "nd": _row.net_deposits,
                                "td": _row.total_deposits,
                                "tw": _row.total_withdrawals,
                            }
            except Exception:
                pass

            # Collect alias agents: agent_aliases.json + also_callers in manifests
            alias_agents_full: set[str] = set(alias_agents)
            agents_dir: Path = settings.agents_dir
            if agents_dir.exists():
                for _ad in agents_dir.iterdir():
                    if not _ad.is_dir() or _ad.name.startswith("_"):
                        continue
                    for _cd in _ad.iterdir():
                        mf = _cd / "manifest.json"
                        if mf.exists():
                            try:
                                _m = json.loads(mf.read_text())
                                for _alias in _m.get("also_callers", []):
                                    alias_agents_full.add(_alias)
                            except Exception:
                                pass

            index: list[dict] = []

            if agents_dir.exists():
                for agent_dir in sorted(agents_dir.iterdir()):
                    if not agent_dir.is_dir() or agent_dir.name.startswith("_"):
                        continue
                    if agent_dir.name in alias_agents_full:
                        continue  # skip alias agent directories

                    for customer_dir in sorted(agent_dir.iterdir()):
                        if not customer_dir.is_dir() or customer_dir.name.startswith("_"):
                            continue
                        mf_path = customer_dir / "manifest.json"
                        if not mf_path.exists():
                            continue

                        try:
                            m = json.loads(mf_path.read_text())
                        except Exception:
                            continue

                        # crm_info.json — financial data written by Stage 2
                        crm_info: dict = {}
                        crm_info_path = customer_dir / "crm_info.json"
                        if crm_info_path.exists():
                            try:
                                crm_info = json.loads(crm_info_path.read_text())
                            except Exception:
                                pass

                        # calls.json — call counts + duration
                        calls: list[dict] = []
                        calls_path = customer_dir / "calls.json"
                        if calls_path.exists():
                            try:
                                calls = json.loads(calls_path.read_text())
                            except Exception:
                                pass

                        recorded = sum(1 for c in calls if c.get("record_path"))
                        total_dur = sum(int(c.get("duration_s") or 0) for c in calls)

                        # Count downloaded audio + smoothed transcripts
                        call_dirs = [
                            d for d in customer_dir.iterdir()
                            if d.is_dir() and not d.name.startswith("_")
                        ]
                        downloaded = sum(
                            1 for d in call_dirs
                            if (d / "audio" / "original").exists()
                            and any((d / "audio" / "original").glob(f"{d.name}.*"))
                        )
                        smoothed = sum(
                            1 for d in call_dirs
                            if (d / "transcribed" / "llm_final" / "smoothed.txt").exists()
                        )

                        # Deposits: crm_info.json first, then DB fallback
                        _crm_url = m.get("crm", "")
                        _acc_id  = str(m.get("account_id", ""))
                        _agent   = agent_dir.name
                        _fb = db_deposit_fallback.get((_crm_url, _acc_id, _agent), {})
                        nd = crm_info.get("net_deposits")
                        td = crm_info.get("total_deposits")
                        tw = crm_info.get("total_withdrawals")
                        if nd is None: nd = _fb.get("nd")
                        if td is None: td = _fb.get("td")
                        if tw is None: tw = _fb.get("tw")

                        index.append({
                            "crm":               _crm_url,
                            "agent":             _agent,
                            "account_id":        m.get("account_id"),
                            "customer":          customer_dir.name,
                            "total_calls":       len(calls),
                            "recorded_calls":    recorded,
                            "total_duration_s":  total_dur,
                            "downloaded_calls":  downloaded,
                            "smoothed_calls":    smoothed,
                            "net_deposits":      nd,
                            "total_deposits":    td,
                            "total_withdrawals": tw,
                            "ftd_at":            crm_info.get("ftd_at"),
                            "last_synced_at":    crm_info.get("last_synced_at"),
                        })

            settings.index_file.parent.mkdir(parents=True, exist_ok=True)
            settings.index_file.write_text(
                json.dumps(index, indent=2, ensure_ascii=False)
            )

            n_with_deposits = sum(1 for p in index if p.get("net_deposits") is not None)
            _emit(q, 3,
                  f"Index rebuilt — {len(index)} pairs, {n_with_deposits} with deposit data",
                  done=True, count=len(index), with_deposits=n_with_deposits)

        except Exception as e:
            _emit(q, 3, f"Index rebuild failed: {e}", error=True)

        # ── Stage 4: Sync DB from index.json ────────────────────────────────
        _emit(q, 4, "Syncing database from index…")
        try:
            from sqlmodel import Session, select
            from ui.backend.database import engine
            from ui.backend.models.crm import CRMPair

            index_data: list[dict] = []
            if settings.index_file.exists():
                try:
                    index_data = json.loads(settings.index_file.read_text())
                except Exception:
                    pass

            db_updated = db_created = db_deleted = 0
            now = datetime.now(timezone.utc)

            with Session(engine) as db:
                # Remove stale alias-agent rows from DB
                alias_list = list(alias_agents)
                if alias_list:
                    stale = db.exec(
                        select(CRMPair).where(CRMPair.agent.in_(alias_list))
                    ).all()
                    for row in stale:
                        db.delete(row)
                        db_deleted += 1

                for p in index_data:
                    crm_url = p.get("crm", "")
                    account_id = str(p.get("account_id", ""))
                    agent = p.get("agent", "")
                    if not crm_url or not account_id or not agent:
                        continue

                    row_id = f"{crm_url}::{account_id}::{agent}"
                    pair = db.get(CRMPair, row_id)

                    call_count = int(p.get("recorded_calls") or 0)
                    total_dur = int(p.get("total_duration_s") or 0)
                    nd = p.get("net_deposits")
                    td = p.get("total_deposits")
                    tw = p.get("total_withdrawals")

                    if pair:
                        pair.call_count = call_count
                        pair.total_duration_s = total_dur
                        if nd is not None:
                            pair.net_deposits = nd
                        if td is not None:
                            pair.total_deposits = td
                        if tw is not None:
                            pair.total_withdrawals = tw
                        pair.last_synced_at = now
                        db.add(pair)
                        db_updated += 1
                    else:
                        db.add(CRMPair(
                            id=row_id,
                            crm_url=crm_url,
                            account_id=account_id,
                            agent=agent,
                            customer=p.get("customer", ""),
                            call_count=call_count,
                            total_duration_s=total_dur,
                            net_deposits=float(nd) if nd is not None else 0.0,
                            total_deposits=float(td) if td is not None else 0.0,
                            total_withdrawals=float(tw) if tw is not None else 0.0,
                            last_synced_at=now,
                        ))
                        db_created += 1

                db.commit()

            parts = []
            if db_updated:  parts.append(f"{db_updated} updated")
            if db_created:  parts.append(f"{db_created} created")
            if db_deleted:  parts.append(f"{db_deleted} alias rows removed")
            _emit(q, 4, "DB synced — " + (", ".join(parts) if parts else "no changes"),
                  done=True, updated=db_updated, created=db_created, deleted=db_deleted)

        except Exception as e:
            _emit(q, 4, f"DB sync failed: {e}", error=True)

    finally:
        elapsed = int(time.time() - total_start)
        _emit(q, 0, f"Sync complete in {elapsed}s", complete=True, elapsed=elapsed)
        with _sync_lock:
            _sync_running = False
        q.put(None)  # sentinel — tells the generator to stop


@router.post("/full")
async def full_sync():
    """Run a full top-down CRM → filesystem → DB sync, streaming SSE progress."""
    global _sync_running
    with _sync_lock:
        if _sync_running:
            return StreamingResponse(
                iter([f'data: {json.dumps({"error": "Sync already running"})}\n\n']),
                media_type="text/event-stream",
            )
        _sync_running = True

    q: queue.Queue = queue.Queue()
    t = threading.Thread(target=_run_sync, args=(q,), daemon=True)
    t.start()

    async def generate():
        while True:
            try:
                item = q.get_nowait()
            except queue.Empty:
                await asyncio.sleep(0.15)
                continue
            if item is None:
                break
            yield f"data: {json.dumps(item)}\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/status")
async def sync_status():
    """Returns whether a sync is currently running."""
    return {"running": _sync_running}
