"""CRM service — loads pairs from JSON cache + SQLite DB, refreshes from CRM API on demand."""
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent))

from shared.crm_client import load_credentials, list_agent_customer_pairs, get_calls_for_pair
from ui.backend.config import settings

_LOCAL_CACHE = settings.ui_data_dir / "all_crm_agents_customers.json"
_INDEX_FILE = settings.ui_data_dir / "index.json"
_ALIASES_FILE = Path(__file__).parent.parent / "agent_aliases.json"


def _load_aliases() -> dict[str, str]:
    """Return {alias_name: primary_name} from agent_aliases.json.
    e.g. {"Ron Silver-re10": "Ron Silver"}"""
    if _ALIASES_FILE.exists():
        try:
            return json.loads(_ALIASES_FILE.read_text())
        except Exception:
            pass
    return {}


# Matches "Name-Re13", "Name Re10", "Name-re10", "Name-R5", "Name re3", etc.
_RE_VARIANT_RE = re.compile(r'^(.+?)[\s\-][Rr][eE]?\d+$')


def _auto_detect_re_aliases(agent_names: list[str]) -> dict[str, str]:
    """Scan agent names for Re-variant suffixes and return {alias: primary}.

    e.g. ["Leo West-Re13", "Leo West"] → {"Leo West-Re13": "Leo West"}
    Works even if the base name is absent from the list — the alias system
    will rename the variant row to the base name.
    """
    aliases: dict[str, str] = {}
    for name in agent_names:
        m = _RE_VARIANT_RE.match(name)
        if m:
            base = m.group(1).strip()
            if base and base != name:
                aliases[name] = base
    return aliases


def _apply_aliases(pairs: list[dict], aliases: dict[str, str]) -> list[dict]:
    """Merge alias-agent rows into their primary agent rows.

    For alias entries with the same (crm, customer) as a primary entry,
    call counts and duration are summed. Deposit figures are NOT summed
    (same customer account — the money is the same regardless of caller).
    Alias rows are then dropped from the list.
    """
    if not aliases:
        return pairs

    # Build a mutable map of primary rows keyed by (crm, primary_agent, customer)
    primary_map: dict[tuple[str, str, str], dict] = {}
    result: list[dict] = []

    for p in pairs:
        agent = p.get("agent", "")
        if agent not in aliases:
            key = (p.get("crm", ""), agent, p.get("customer", ""))
            primary_map[key] = p
            result.append(p)

    # Second pass: merge alias rows into primary rows
    for p in pairs:
        agent = p.get("agent", "")
        primary = aliases.get(agent)
        if primary is None:
            continue  # not an alias
        customer = p.get("customer", "")
        crm = p.get("crm", "")
        key = (crm, primary, customer)
        if key in primary_map:
            # Merge call counts into the existing primary row
            row = primary_map[key]
            row["total_calls"] = int(row.get("total_calls") or 0) + int(p.get("total_calls") or 0)
            row["recorded_calls"] = int(row.get("recorded_calls") or 0) + int(p.get("recorded_calls") or 0)
            row["total_duration_s"] = int(row.get("total_duration_s") or 0) + int(p.get("total_duration_s") or 0)
            # Deposit figures represent the same money — take the non-zero value if primary is $0
            for dep_field in ("net_deposits", "total_deposits", "total_withdrawals", "ftd"):
                primary_val = float(row.get(dep_field) or 0)
                alias_val = float(p.get(dep_field) or 0)
                if primary_val == 0 and alias_val != 0:
                    row[dep_field] = alias_val
            # Use the earlier ftd_at
            if p.get("ftd_at") and (not row.get("ftd_at") or str(p["ftd_at"]) < str(row["ftd_at"])):
                row["ftd_at"] = p["ftd_at"]
        else:
            # Primary doesn't have this customer yet — add under primary name
            new_row = {**p, "agent": primary}
            primary_map[key] = new_row
            result.append(new_row)

    return result


def _load_local() -> list[dict]:
    """Read pairs from index.json (preferred — includes deposits) or legacy JSON file."""
    # New index takes priority — built by sync Stage 3, includes deposit data
    if _INDEX_FILE.exists():
        try:
            data = json.loads(_INDEX_FILE.read_text())
            if data:
                return data
        except Exception:
            pass
    # Fallback: all_crm_agents_customers.json (no deposits)
    if _LOCAL_CACHE.exists():
        try:
            data = json.loads(_LOCAL_CACHE.read_text())
            if data:
                return data
        except Exception:
            pass
    # Legacy migration from pipeline data dir
    legacy = settings.data_dir / "all_crm_agents_customers.json"
    if legacy.exists():
        try:
            data = json.loads(legacy.read_text())
            if data:
                _save_local(data)
                return data
        except Exception:
            pass
    return []


def _save_local(pairs: list[dict]):
    _LOCAL_CACHE.parent.mkdir(parents=True, exist_ok=True)
    _LOCAL_CACHE.write_text(json.dumps(pairs, indent=2))


def _filter(pairs: list[dict], crm_filter="", agent_filter="", customer_filter="") -> list[dict]:
    if crm_filter:
        pairs = [p for p in pairs if crm_filter.lower() in p.get("crm", "").lower()]
    if agent_filter:
        pairs = [p for p in pairs if agent_filter.lower() in p.get("agent", "").lower()]
    if customer_filter:
        pairs = [p for p in pairs if customer_filter.lower() in p.get("customer", "").lower()]
    return pairs


def get_pairs(crm_filter="", agent_filter="", customer_filter="") -> list[dict]:
    """Return pairs from local cache (instant). Use refresh_pairs() to update from CRM API."""
    pairs = _load_local()
    return _filter(pairs, crm_filter, agent_filter, customer_filter)


def seed_db(pairs: list[dict], session, replace_crm_urls: set[str] | None = None) -> int:
    """Upsert rows in crm_pair table. Returns count inserted.

    replace_crm_urls: if given, only delete existing rows for those CRM URLs
    before inserting (preserves data for CRMs that weren't refreshed).
    If None, replaces everything (full reset).
    """
    from sqlalchemy import text
    from ui.backend.models.crm import CRMPair
    if replace_crm_urls is None:
        session.exec(text("DELETE FROM crm_pair"))
    else:
        for url in replace_crm_urls:
            session.exec(text("DELETE FROM crm_pair WHERE crm_url = :u").bindparams(u=url))
    now = datetime.now(timezone.utc)
    for p in pairs:
        crm_url = p.get("crm", p.get("crm_url", ""))
        account_id = str(p.get("account_id", ""))
        agent = p.get("agent", "")
        row = CRMPair(
            id=f"{crm_url}::{account_id}::{agent}",
            crm_url=crm_url,
            account_id=account_id,
            agent=agent,
            customer=p.get("customer", ""),
            call_count=int(p.get("recorded_calls", p.get("call_count", 0)) or 0),
            total_duration_s=int(p.get("total_duration_s", p.get("total_duration", 0)) or 0),
            net_deposits=float(p.get("net_deposits") or 0),
            total_deposits=float(p.get("total_deposits") or 0),
            total_withdrawals=float(p.get("total_withdrawals") or 0),
            ftd_at=p.get("ftd_at") or None,
            last_synced_at=now,
        )
        session.add(row)
    session.commit()
    return len(pairs)


def refresh_pairs() -> dict:
    """Fetch fresh data from all CRM APIs, save to local file and DB. Returns {count, errors}.

    CRMs that fail (e.g. IP not whitelisted) keep their existing cached data — they are
    not wiped from the local file or DB just because one refresh attempt blocked.
    """
    creds = load_credentials()
    errors: list[str] = []
    succeeded_crms: set[str] = set()
    new_pairs: list[dict] = []

    # Load existing cache keyed by crm_url so we can preserve data for blocked CRMs
    existing_by_crm: dict[str, list[dict]] = {}
    for p in _load_local():
        key = p.get("crm", p.get("crm_url", ""))
        existing_by_crm.setdefault(key, []).append(p)

    for crm_url in creds.crm_urls:
        try:
            pairs = list_agent_customer_pairs(crm_url, creds)
            new_pairs.extend(pairs)
            succeeded_crms.add(crm_url)
            print(f"[crm_service] Fetched {len(pairs)} pairs from {crm_url}")
        except Exception as e:
            # Clean up HTML in the error message (e.g. Cloudflare block pages)
            msg = str(e)
            if "<" in msg:
                msg = msg.split("<")[0].strip().rstrip(":").strip()
            errors.append(f"{crm_url}: {msg}")
            print(f"[crm_service] Warning: failed to fetch {crm_url}: {msg}")
            # Preserve existing cached data for this CRM
            new_pairs.extend(existing_by_crm.get(crm_url, []))

    # Apply alias merges — Ron Silver-re10 → Ron Silver, Leo West-Re13 → Leo West, etc.
    file_aliases = _load_aliases()
    all_agent_names = list({p.get("agent", "") for p in new_pairs if p.get("agent")})
    auto_aliases = _auto_detect_re_aliases(all_agent_names)

    # Save any newly discovered aliases back to the file (manual entries take priority)
    if auto_aliases:
        new_entries = {k: v for k, v in auto_aliases.items() if k not in file_aliases}
        if new_entries:
            updated_file = {**file_aliases, **new_entries}
            try:
                _ALIASES_FILE.write_text(json.dumps(updated_file, sort_keys=True, indent=2))
                print(f"[crm_service] Auto-saved {len(new_entries)} new Re-variant alias(es): {new_entries}")
            except Exception as _e:
                print(f"[crm_service] Warning: could not save aliases: {_e}")
            file_aliases = updated_file

    # Merge: manual aliases override auto-detected ones
    aliases = {**auto_aliases, **file_aliases}
    if aliases:
        pre = len(new_pairs)
        new_pairs = _apply_aliases(new_pairs, aliases)
        print(f"[crm_service] Aliases applied: {pre} → {len(new_pairs)} pairs "
              f"({pre - len(new_pairs)} alias rows merged)")

    _save_local(new_pairs)
    try:
        from sqlmodel import Session
        from ui.backend.database import engine
        with Session(engine) as db:
            # Only replace rows for CRMs we successfully refreshed; leave blocked CRMs intact
            seed_db(new_pairs, db, replace_crm_urls=succeeded_crms if succeeded_crms else None)
    except Exception as e:
        print(f"[crm_service] Warning: failed to update DB: {e}")
    return {"count": len(new_pairs), "errors": errors}


def get_calls_local(crm_url: str, agent: str, customer: str) -> list[dict]:
    """Read calls from local calls.json (instant, no network).
    Checks new ui/data/agents/{agent}/{customer}/ first, then legacy path."""
    # New path
    new_path = settings.agents_dir / agent / customer / "calls.json"
    if new_path.exists():
        try:
            return json.loads(new_path.read_text())
        except Exception:
            return []
    # Legacy path
    from shared.crm_download import slugify
    host = crm_url.replace("https://", "").replace("http://", "").split(".")[0]
    legacy = settings.data_dir / f"{host}_{slugify(agent)}_{slugify(customer)}" / "calls.json"
    if legacy.exists():
        try:
            return json.loads(legacy.read_text())
        except Exception:
            return []
    return []


def get_calls(account_id: str, crm_url: str, agent: str = "", customer: str = "") -> list[dict]:
    """Load calls from DB (preferred) or local calls.json.
    If neither has data, auto-fetches from the CRM API (lazy-load on first access)."""
    # Try DB first — populated by sync_crm_calls.py
    try:
        from sqlmodel import Session, select
        from ui.backend.database import engine
        from ui.backend.models.crm import CRMCall
        with Session(engine) as db:
            stmt = select(CRMCall).where(
                CRMCall.crm_url == crm_url,
                CRMCall.account_id == str(account_id),
            )
            if agent:
                # Include calls stored under alias names (e.g. Ron Silver-re10 → Ron Silver)
                aliases = _load_aliases()
                alias_names = [a for a, p in aliases.items() if p == agent]
                agent_names = [agent] + alias_names
                if len(agent_names) == 1:
                    stmt = stmt.where(CRMCall.agent == agent)
                else:
                    from sqlalchemy import or_
                    stmt = stmt.where(or_(*[CRMCall.agent == n for n in agent_names]))
            rows = db.exec(stmt.order_by(CRMCall.started_at)).all()
        if rows:
            return [
                {
                    "call_id":          r.call_id,
                    "account_id":       r.account_id,
                    "customer":         r.customer,
                    "agent":            agent or r.agent,  # normalize alias to primary name
                    "duration_s":       r.audio_duration_s if r.audio_duration_s is not None else r.duration_s,
                    "started_at":       r.started_at,
                    "record_path":      r.record_path,
                    "has_local_audio":  r.has_local_audio,
                }
                for r in rows
            ]
    except Exception as e:
        print(f"[crm_service] DB read failed, falling back to calls.json: {e}")

    # Try calls.json on disk
    local = get_calls_local(crm_url, agent, customer)
    if local:
        return local

    # Neither DB nor local file has data — auto-fetch from CRM (lazy-load)
    if crm_url and account_id:
        print(f"[crm_service] No local calls for {agent}/{customer} — fetching from CRM")
        result = refresh_calls(account_id, crm_url, agent, customer)
        if result["count"] > 0:
            return get_calls_local(crm_url, agent, customer)

    return []


def _all_crm_accounts_for_pair(canonical_agent: str, customer: str) -> list[tuple[str, str]]:
    """
    Search the local cache for every (crm_url, account_id) that belongs to
    canonical_agent + customer — across ALL CRMs and under ALL alias names.
    Returns a list of (crm_url, account_id) tuples, deduplicated.
    """
    file_aliases = _load_aliases()
    auto_aliases = _auto_detect_re_aliases([canonical_agent])
    all_aliases   = {**auto_aliases, **file_aliases}

    # All names this canonical agent is known by
    alias_names = {k for k, v in all_aliases.items() if v == canonical_agent}
    all_names   = {canonical_agent} | alias_names

    pairs = _load_local()
    seen: set[tuple[str, str]] = set()
    result: list[tuple[str, str]] = []

    for p in pairs:
        p_agent   = p.get("agent", "")
        p_cust    = p.get("customer", "")
        p_crm     = p.get("crm", p.get("crm_url", ""))
        p_acc     = str(p.get("account_id", ""))

        if not p_crm or not p_acc:
            continue
        if p_cust.lower() != customer.lower():
            continue
        if p_agent in all_names:
            key = (p_crm, p_acc)
            if key not in seen:
                seen.add(key)
                result.append(key)

    return result


def refresh_calls(account_id: str, crm_url: str, agent: str = "", customer: str = "") -> dict:
    """Fetch calls from ALL CRMs × ALL aliases for this agent/customer pair.

    Queries every (crm_url, account_id) found in the local cache for this
    canonical agent + customer, using both the canonical name and all known
    aliases on each CRM.  Results are merged and deduplicated by call_id.
    """
    try:
        creds = load_credentials()

        # Discover all (crm_url, account_id) combos across all CRMs
        all_pairs = _all_crm_accounts_for_pair(agent, customer)

        # Always include the explicitly requested pair (may not be in cache yet)
        if (crm_url, str(account_id)) not in {(c, a) for c, a in all_pairs}:
            all_pairs.insert(0, (crm_url, str(account_id)))

        # Build the full set of names to try on each CRM
        file_aliases = _load_aliases()
        auto_aliases = _auto_detect_re_aliases([agent])
        all_aliases  = {**auto_aliases, **file_aliases}
        alias_names  = [k for k, v in all_aliases.items() if v == agent]

        pair_dir = settings.agents_dir / agent / customer
        manifest_callers: list[str] = []
        manifest_path = pair_dir / "manifest.json"
        if manifest_path.exists():
            try:
                m = json.loads(manifest_path.read_text())
                manifest_callers = m.get("also_callers", [])
            except Exception:
                pass

        # Deduplicated ordered list: canonical first, then aliases, then also_callers
        query_names: list[str] = list(dict.fromkeys(
            [agent] + alias_names + manifest_callers
        ))

        all_calls: list[dict] = []
        existing_ids: set[str] = set()

        for pair_crm, pair_acc in all_pairs:
            for name in query_names:
                try:
                    found = get_calls_for_pair(
                        pair_crm, creds,
                        agent_name=name, account_id=int(pair_acc),
                    )
                    for c in found:
                        cid = str(c.get("call_id", ""))
                        if cid and cid not in existing_ids:
                            c["agent"] = agent   # normalize to canonical name
                            all_calls.append(c)
                            existing_ids.add(cid)
                except Exception as _e:
                    print(f"[crm_service] refresh_calls {pair_crm}/{name}/{pair_acc}: {_e}")

        if not all_calls and not existing_ids:
            # Nothing found at all — return a soft error so the caller can surface it
            return {"count": 0, "error": f"No calls found across {len(all_pairs)} CRM(s)"}

        pair_dir.mkdir(parents=True, exist_ok=True)

        # Write manifest if it doesn't exist
        if not manifest_path.exists():
            manifest_path.write_text(json.dumps({
                "agent": agent, "customer": customer,
                "crm": crm_url, "account_id": int(account_id),
            }, indent=2))

        if all_calls:
            (pair_dir / "calls.json").write_text(json.dumps(all_calls, indent=2))

        # Upsert crm_pair DB row (keyed to the primary crm_url/account_id)
        try:
            from datetime import datetime, timezone
            from sqlmodel import Session
            from ui.backend.database import engine
            from ui.backend.models.crm import CRMPair
            total_duration = sum(int(c.get("duration_s") or 0) for c in all_calls)
            row_id = f"{crm_url}::{account_id}::{agent}"
            with Session(engine) as db:
                existing = db.get(CRMPair, row_id)
                if existing:
                    existing.call_count     = len(all_calls)
                    existing.total_duration_s = total_duration
                    existing.last_synced_at = datetime.now(timezone.utc)
                    db.add(existing)
                else:
                    db.add(CRMPair(
                        id=row_id,
                        crm_url=crm_url,
                        account_id=str(account_id),
                        agent=agent,
                        customer=customer,
                        call_count=len(all_calls),
                        total_duration_s=total_duration,
                        last_synced_at=datetime.now(timezone.utc),
                    ))
                db.commit()
        except Exception as db_err:
            print(f"[crm_service] Warning: DB update failed after refresh_calls: {db_err}")

        print(f"[crm_service] refresh_calls {agent}/{customer}: "
              f"{len(all_calls)} calls from {len(all_pairs)} CRM(s) × {len(query_names)} name(s)")

        return {"count": len(all_calls), "error": None}

    except Exception as e:
        msg = str(e)
        if "<" in msg:
            msg = msg.split("<")[0].strip().rstrip(":").strip()
        return {"count": 0, "error": msg}


def get_agents(crm_filter="") -> list[str]:
    return sorted(set(p["agent"] for p in get_pairs(crm_filter=crm_filter)))


def get_customers(crm_filter="", agent_filter="") -> list[str]:
    return sorted(set(p["customer"] for p in get_pairs(crm_filter=crm_filter, agent_filter=agent_filter)))
