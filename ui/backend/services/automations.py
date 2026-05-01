from __future__ import annotations

import json
import queue
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

from ui.backend.config import settings

_AUTOMATION_DIR = settings.ui_data_dir / "_automations"
_AUTOMATION_CONFIG_FILE = _AUTOMATION_DIR / "config.json"
_AUTOMATION_STATE_FILE = _AUTOMATION_DIR / "state.json"
_REJECTION_ARCHIVE_FILE = settings.ui_data_dir / "_webhooks" / "rejections_archive.json"

_STATE_LOCK = threading.RLock()
_SCHEDULER_THREAD: Optional[threading.Thread] = None
_STOP_EVENT = threading.Event()


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _utc_iso(dt: Optional[datetime] = None) -> str:
    return (dt or _utc_now()).isoformat()


def _parse_iso(raw: Any) -> Optional[datetime]:
    s = str(raw or "").strip()
    if not s:
        return None
    try:
        out = datetime.fromisoformat(s)
    except Exception:
        return None
    if out.tzinfo is None:
        out = out.replace(tzinfo=timezone.utc)
    return out.astimezone(timezone.utc)


def _default_automations() -> list[dict[str, Any]]:
    return [
        {
            "id": "crm_sync",
            "name": "CRM Sync",
            "description": "Sync CRM pairs, deposits, and index data.",
            "action": "crm_sync",
            "enabled": True,
            "schedule": "0 */2 * * *",
            "params": {},
        },
        {
            "id": "stash_rejected",
            "name": "Stash Rejected Webhooks",
            "description": "Archive rejected webhook items older than 7 days and remove them from the active list.",
            "action": "stash_rejected",
            "enabled": True,
            "schedule": "15 */6 * * *",
            "params": {"retention_days": 7},
        },
        {
            "id": "populate",
            "name": "Populate",
            "description": "Run the populate workflow (CRM sync + transcription submission).",
            "action": "populate",
            "enabled": False,
            "schedule": "0 3 * * *",
            "params": {},
        },
    ]


def _default_config() -> dict[str, Any]:
    return {
        "updated_at": _utc_iso(),
        "automations": _default_automations(),
    }


def _default_state() -> dict[str, Any]:
    return {
        "updated_at": _utc_iso(),
        "automations": {},
        "runs": [],
    }


def _ensure_dirs() -> None:
    _AUTOMATION_DIR.mkdir(parents=True, exist_ok=True)
    _REJECTION_ARCHIVE_FILE.parent.mkdir(parents=True, exist_ok=True)


def _normalize_cron_field(field: str) -> str:
    return str(field or "").strip()


def _parse_cron_value(token: str, minimum: int, maximum: int, *, weekday: bool = False) -> set[int]:
    out: set[int] = set()
    tok = str(token or "").strip()
    if not tok:
        return out

    def _to_int(raw: str) -> Optional[int]:
        try:
            val = int(str(raw).strip())
        except Exception:
            return None
        if weekday and val == 7:
            val = 0
        if minimum <= val <= maximum:
            return val
        return None

    if tok == "*":
        return set(range(minimum, maximum + 1))

    for part in tok.split(","):
        part = part.strip()
        if not part:
            continue

        base = part
        step = 1
        if "/" in part:
            base, step_raw = part.split("/", 1)
            try:
                step = max(1, int(step_raw.strip()))
            except Exception:
                return set()
            base = base.strip() or "*"

        if base == "*":
            start = minimum
            end = maximum
        elif "-" in base:
            left, right = base.split("-", 1)
            li = _to_int(left)
            ri = _to_int(right)
            if li is None or ri is None:
                return set()
            start = min(li, ri)
            end = max(li, ri)
        else:
            vi = _to_int(base)
            if vi is None:
                return set()
            start = vi
            end = vi

        for val in range(start, end + 1, step):
            if minimum <= val <= maximum:
                out.add(val)

    return out


def is_valid_cron(expr: str) -> bool:
    parts = str(expr or "").strip().split()
    if len(parts) != 5:
        return False
    mins = _parse_cron_value(parts[0], 0, 59)
    hrs = _parse_cron_value(parts[1], 0, 23)
    dom = _parse_cron_value(parts[2], 1, 31)
    mon = _parse_cron_value(parts[3], 1, 12)
    dow = _parse_cron_value(parts[4], 0, 6, weekday=True)
    return bool(mins and hrs and dom and mon and dow)


def _cron_matches(expr: str, when: datetime) -> bool:
    parts = str(expr or "").strip().split()
    if len(parts) != 5:
        return False
    mins = _parse_cron_value(parts[0], 0, 59)
    hrs = _parse_cron_value(parts[1], 0, 23)
    dom = _parse_cron_value(parts[2], 1, 31)
    mon = _parse_cron_value(parts[3], 1, 12)
    dow = _parse_cron_value(parts[4], 0, 6, weekday=True)
    if not (mins and hrs and dom and mon and dow):
        return False

    # Python weekday: Monday=0..Sunday=6; cron (this parser): Sunday=0..Saturday=6
    cron_dow = (when.weekday() + 1) % 7
    return (
        when.minute in mins
        and when.hour in hrs
        and when.day in dom
        and when.month in mon
        and cron_dow in dow
    )


def _cron_next_run(expr: str, from_dt: Optional[datetime] = None) -> Optional[str]:
    if not is_valid_cron(expr):
        return None
    start = (from_dt or _utc_now()).astimezone(timezone.utc).replace(second=0, microsecond=0) + timedelta(minutes=1)
    limit = start + timedelta(days=30)
    cur = start
    while cur <= limit:
        if _cron_matches(expr, cur):
            return _utc_iso(cur)
        cur += timedelta(minutes=1)
    return None


def _normalize_automation(item: Any, defaults_by_id: dict[str, dict[str, Any]]) -> Optional[dict[str, Any]]:
    if not isinstance(item, dict):
        return None

    aid = str(item.get("id") or "").strip()
    if not aid:
        return None

    base = dict(defaults_by_id.get(aid) or {})
    if not base:
        base = {
            "id": aid,
            "name": aid.replace("_", " ").title(),
            "description": "",
            "action": str(item.get("action") or aid).strip() or aid,
            "enabled": True,
            "schedule": "0 * * * *",
            "params": {},
        }

    if "name" in item:
        base["name"] = str(item.get("name") or base["name"])
    if "description" in item:
        base["description"] = str(item.get("description") or "")
    if "action" in item:
        base["action"] = str(item.get("action") or base["action"]).strip() or base["action"]
    if "params" in item and isinstance(item.get("params"), dict):
        base["params"] = dict(item.get("params") or {})

    base["enabled"] = bool(item.get("enabled", base.get("enabled", True)))

    sched = str(item.get("schedule") or base.get("schedule") or "0 * * * *").strip()
    if not is_valid_cron(sched):
        sched = str(base.get("schedule") or "0 * * * *")
        if not is_valid_cron(sched):
            sched = "0 * * * *"
    base["schedule"] = sched

    return base


def _normalize_config(raw: Any) -> dict[str, Any]:
    defaults = _default_automations()
    defaults_by_id = {str(a["id"]): dict(a) for a in defaults}

    items_raw = raw.get("automations") if isinstance(raw, dict) else None
    normalized: list[dict[str, Any]] = []
    seen: set[str] = set()

    if isinstance(items_raw, list):
        for row in items_raw:
            norm = _normalize_automation(row, defaults_by_id)
            if not norm:
                continue
            aid = str(norm["id"])
            if aid in seen:
                continue
            seen.add(aid)
            normalized.append(norm)

    for d in defaults:
        aid = str(d["id"])
        if aid not in seen:
            normalized.append(dict(d))

    return {
        "updated_at": _utc_iso(),
        "automations": normalized,
    }


def _normalize_state(raw: Any) -> dict[str, Any]:
    out = _default_state()
    if isinstance(raw, dict):
        autos = raw.get("automations")
        if isinstance(autos, dict):
            norm_autos: dict[str, dict[str, Any]] = {}
            for k, v in autos.items():
                kk = str(k or "").strip()
                if not kk:
                    continue
                vv = dict(v) if isinstance(v, dict) else {}
                norm_autos[kk] = vv
            out["automations"] = norm_autos
        runs = raw.get("runs")
        if isinstance(runs, list):
            norm_runs: list[dict[str, Any]] = []
            for row in runs:
                if isinstance(row, dict):
                    norm_runs.append(dict(row))
            out["runs"] = norm_runs[-2000:]
    out["updated_at"] = _utc_iso()
    return out


def _load_json(path: Path, default: dict[str, Any], normalizer) -> dict[str, Any]:
    _ensure_dirs()
    if not path.exists():
        data = normalizer(default)
        path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
        return data
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        raw = default
    data = normalizer(raw)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    return data


def _load_config() -> dict[str, Any]:
    with _STATE_LOCK:
        return _load_json(_AUTOMATION_CONFIG_FILE, _default_config(), _normalize_config)


def _save_config(cfg: dict[str, Any]) -> dict[str, Any]:
    with _STATE_LOCK:
        norm = _normalize_config(cfg)
        _ensure_dirs()
        _AUTOMATION_CONFIG_FILE.write_text(json.dumps(norm, indent=2, ensure_ascii=False), encoding="utf-8")
        return norm


def _load_state() -> dict[str, Any]:
    with _STATE_LOCK:
        return _load_json(_AUTOMATION_STATE_FILE, _default_state(), _normalize_state)


def _save_state(state: dict[str, Any]) -> dict[str, Any]:
    with _STATE_LOCK:
        norm = _normalize_state(state)
        _ensure_dirs()
        _AUTOMATION_STATE_FILE.write_text(json.dumps(norm, indent=2, ensure_ascii=False), encoding="utf-8")
        return norm


def _update_state_for(automation_id: str, **updates: Any) -> dict[str, Any]:
    aid = str(automation_id or "").strip()
    if not aid:
        return _load_state()
    state = _load_state()
    autos = state.get("automations")
    if not isinstance(autos, dict):
        autos = {}
        state["automations"] = autos
    entry = dict(autos.get(aid) or {})
    entry.update(updates)
    autos[aid] = entry
    return _save_state(state)


def _append_run_log(run_row: dict[str, Any]) -> None:
    state = _load_state()
    runs = state.get("runs")
    if not isinstance(runs, list):
        runs = []
    runs.append(run_row)
    if len(runs) > 2000:
        runs = runs[-2000:]
    state["runs"] = runs
    _save_state(state)


def _finalize_run(run_id: str, status: str, message: str, details: Optional[dict[str, Any]] = None) -> None:
    rid = str(run_id or "").strip()
    if not rid:
        return
    state = _load_state()
    runs = state.get("runs")
    if not isinstance(runs, list):
        runs = []

    done_at = _utc_iso()
    for idx in range(len(runs) - 1, -1, -1):
        row = runs[idx]
        if not isinstance(row, dict):
            continue
        if str(row.get("run_id") or "").strip() != rid:
            continue
        row["status"] = status
        row["message"] = str(message or "")
        row["finished_at"] = done_at
        if isinstance(details, dict):
            row["details"] = details
        runs[idx] = row
        break
    state["runs"] = runs
    _save_state(state)


def _run_sync_action() -> tuple[str, str, dict[str, Any]]:
    from ui.backend.routers.sync import _run_sync

    q: queue.Queue = queue.Queue()
    worker = threading.Thread(target=_run_sync, args=(q,), daemon=True)
    worker.start()

    total_events = 0
    errors = 0
    last_msg = "CRM sync completed"

    while worker.is_alive() or not q.empty():
        try:
            item = q.get(timeout=0.5)
        except queue.Empty:
            continue
        if item is None:
            break
        total_events += 1
        msg = str((item or {}).get("msg") or "").strip()
        if msg:
            last_msg = msg
        if bool((item or {}).get("error")):
            errors += 1

    worker.join(timeout=1)

    if errors:
        return "error", f"CRM sync finished with {errors} error event(s).", {
            "events": total_events,
            "errors": errors,
            "last_message": last_msg,
        }

    return "success", "CRM sync completed successfully.", {
        "events": total_events,
        "errors": 0,
        "last_message": last_msg,
    }


def _load_rejection_archive() -> dict[str, Any]:
    if not _REJECTION_ARCHIVE_FILE.exists():
        return {"updated_at": _utc_iso(), "items": []}
    try:
        raw = json.loads(_REJECTION_ARCHIVE_FILE.read_text(encoding="utf-8"))
    except Exception:
        raw = {}
    items = raw.get("items") if isinstance(raw, dict) else []
    if not isinstance(items, list):
        items = []
    norm_items = [dict(x) for x in items if isinstance(x, dict)]
    return {"updated_at": _utc_iso(), "items": norm_items}


def _save_rejection_archive(data: dict[str, Any]) -> dict[str, Any]:
    _ensure_dirs()
    items = data.get("items") if isinstance(data, dict) else []
    if not isinstance(items, list):
        items = []
    norm = {"updated_at": _utc_iso(), "items": [dict(x) for x in items if isinstance(x, dict)]}
    _REJECTION_ARCHIVE_FILE.write_text(json.dumps(norm, indent=2, ensure_ascii=False), encoding="utf-8")
    return norm


def _run_stash_rejected_action(retention_days: int = 7) -> tuple[str, str, dict[str, Any]]:
    from ui.backend.routers import webhooks as _wh

    days = max(1, min(int(retention_days or 7), 3650))
    cutoff = _utc_now() - timedelta(days=days)

    store = _wh._load_rejections_store()
    items = store.get("items")
    if not isinstance(items, list):
        items = []

    keep: list[dict[str, Any]] = []
    stash: list[dict[str, Any]] = []

    for row in items:
        if not isinstance(row, dict):
            continue
        created = _parse_iso(row.get("created_at") or row.get("updated_at"))
        if created is None:
            keep.append(dict(row))
            continue
        if created < cutoff:
            copied = dict(row)
            copied["stashed_at"] = _utc_iso()
            stash.append(copied)
        else:
            keep.append(dict(row))

    if stash:
        archive = _load_rejection_archive()
        arch_items = archive.get("items") if isinstance(archive.get("items"), list) else []
        arch_items.extend(stash)
        archive["items"] = arch_items[-100000:]
        _save_rejection_archive(archive)

    store["items"] = keep
    _wh._save_rejections_store(store)

    return "success", f"Stashed {len(stash)} rejected webhook record(s).", {
        "stashed": len(stash),
        "remaining": len(keep),
        "retention_days": days,
    }


def _run_populate_action(timeout_s: int = 8 * 60 * 60) -> tuple[str, str, dict[str, Any]]:
    from ui.backend.routers import populate as _pop

    started = _pop.start_populate()
    if not bool((started or {}).get("ok")):
        err = str((started or {}).get("error") or "Populate start failed")
        if "already running" in err.lower():
            return "success", "Populate already running.", {"already_running": True}
        return "error", err, {"already_running": False}

    deadline = time.monotonic() + max(60, int(timeout_s))
    while time.monotonic() < deadline:
        status = _pop.populate_status()
        if not bool((status or {}).get("running")):
            log = status.get("log") if isinstance(status, dict) else []
            has_error = False
            if isinstance(log, list):
                for row in log:
                    if isinstance(row, dict) and str(row.get("event") or "").strip().lower() == "error":
                        has_error = True
                        break
            summary = status.get("last_result") if isinstance(status, dict) else None
            if has_error:
                return "error", "Populate finished with errors.", {
                    "last_result": summary,
                    "log_size": len(log) if isinstance(log, list) else 0,
                }
            return "success", "Populate completed.", {
                "last_result": summary,
                "log_size": len(log) if isinstance(log, list) else 0,
            }
        time.sleep(2)

    return "error", "Populate timed out while waiting for completion.", {"timeout_s": int(timeout_s)}


def _run_action(automation: dict[str, Any]) -> tuple[str, str, dict[str, Any]]:
    action = str(automation.get("action") or "").strip().lower()
    params = automation.get("params") if isinstance(automation.get("params"), dict) else {}
    if action == "crm_sync":
        return _run_sync_action()
    if action == "stash_rejected":
        return _run_stash_rejected_action(int(params.get("retention_days") or 7))
    if action == "populate":
        return _run_populate_action()
    return "error", f"Unknown automation action: {action}", {}


def _execute_automation_run(automation: dict[str, Any], run_id: str, trigger: str) -> None:
    aid = str(automation.get("id") or "").strip()
    started_at = _utc_iso()

    _update_state_for(
        aid,
        running=True,
        last_status="running",
        last_message=f"Started via {trigger}.",
        last_run_started_at=started_at,
    )

    _append_run_log(
        {
            "run_id": run_id,
            "automation_id": aid,
            "automation_name": str(automation.get("name") or aid),
            "trigger": trigger,
            "status": "running",
            "message": f"Started via {trigger}.",
            "started_at": started_at,
        }
    )

    try:
        status, message, details = _run_action(automation)
    except Exception as exc:
        status, message, details = "error", f"Automation crashed: {exc}", {}

    finished_at = _utc_iso()
    _update_state_for(
        aid,
        running=False,
        last_status=status,
        last_message=str(message or ""),
        last_run_started_at=started_at,
        last_run_at=finished_at,
        last_run_trigger=trigger,
        last_error=(str(message) if status == "error" else ""),
    )

    _finalize_run(run_id, status, str(message or ""), details)


def _dispatch_automation(automation: dict[str, Any], trigger: str) -> tuple[bool, str]:
    aid = str(automation.get("id") or "").strip()
    if not aid:
        return False, "Missing automation id"

    state = _load_state()
    autos = state.get("automations") if isinstance(state.get("automations"), dict) else {}
    row = autos.get(aid) if isinstance(autos, dict) else {}
    if isinstance(row, dict) and bool(row.get("running")):
        return False, "Automation is already running"

    run_id = str(uuid.uuid4())
    worker = threading.Thread(
        target=_execute_automation_run,
        args=(dict(automation), run_id, trigger),
        daemon=True,
        name=f"automation-{aid}",
    )
    worker.start()
    return True, run_id


def _scheduler_loop() -> None:
    while not _STOP_EVENT.is_set():
        try:
            now = _utc_now()
            minute_key = now.strftime("%Y-%m-%dT%H:%M")
            cfg = _load_config()
            autos = cfg.get("automations") if isinstance(cfg.get("automations"), list) else []
            state = _load_state()
            state_autos = state.get("automations") if isinstance(state.get("automations"), dict) else {}

            changed = False
            for auto in autos:
                if not isinstance(auto, dict):
                    continue
                aid = str(auto.get("id") or "").strip()
                if not aid:
                    continue
                if not bool(auto.get("enabled", False)):
                    continue
                sched = str(auto.get("schedule") or "").strip()
                if not is_valid_cron(sched):
                    continue
                row = state_autos.get(aid) if isinstance(state_autos, dict) else None
                if isinstance(row, dict) and bool(row.get("running")):
                    continue
                if not _cron_matches(sched, now):
                    continue
                if isinstance(row, dict) and str(row.get("last_trigger_minute") or "") == minute_key:
                    continue

                ok, _ = _dispatch_automation(auto, "scheduler")
                if ok:
                    changed = True
                    if not isinstance(row, dict):
                        row = {}
                    row["last_trigger_minute"] = minute_key
                    state_autos[aid] = row

            if changed:
                state["automations"] = state_autos
                _save_state(state)
        except Exception:
            pass

        _STOP_EVENT.wait(5.0)


def start_scheduler() -> None:
    global _SCHEDULER_THREAD
    with _STATE_LOCK:
        if _SCHEDULER_THREAD and _SCHEDULER_THREAD.is_alive():
            return
        _STOP_EVENT.clear()
        _SCHEDULER_THREAD = threading.Thread(target=_scheduler_loop, daemon=True, name="automation-scheduler")
        _SCHEDULER_THREAD.start()


def stop_scheduler() -> None:
    global _SCHEDULER_THREAD
    _STOP_EVENT.set()
    th = _SCHEDULER_THREAD
    if th and th.is_alive():
        th.join(timeout=2)
    _SCHEDULER_THREAD = None


def update_automations(automations: list[dict[str, Any]]) -> dict[str, Any]:
    cfg = _load_config()
    cfg["automations"] = automations
    return _save_config(cfg)


def run_automation_now(automation_id: str) -> tuple[bool, str]:
    aid = str(automation_id or "").strip()
    if not aid:
        return False, "Missing automation id"
    cfg = _load_config()
    autos = cfg.get("automations") if isinstance(cfg.get("automations"), list) else []
    target = None
    for row in autos:
        if isinstance(row, dict) and str(row.get("id") or "").strip() == aid:
            target = dict(row)
            break
    if not target:
        return False, "Automation not found"
    ok, run_id = _dispatch_automation(target, "manual")
    if not ok:
        return False, run_id
    return True, run_id


def get_automations_snapshot(limit_runs: int = 100) -> dict[str, Any]:
    cfg = _load_config()
    state = _load_state()
    autos_cfg = cfg.get("automations") if isinstance(cfg.get("automations"), list) else []
    autos_state = state.get("automations") if isinstance(state.get("automations"), dict) else {}

    now = _utc_now()
    rows: list[dict[str, Any]] = []
    for auto in autos_cfg:
        if not isinstance(auto, dict):
            continue
        aid = str(auto.get("id") or "").strip()
        if not aid:
            continue
        st = autos_state.get(aid) if isinstance(autos_state.get(aid), dict) else {}
        enabled = bool(auto.get("enabled", False))
        sched = str(auto.get("schedule") or "").strip()
        row = {
            **auto,
            "enabled": enabled,
            "schedule": sched,
            "running": bool(st.get("running", False)),
            "last_status": str(st.get("last_status") or "idle"),
            "last_message": str(st.get("last_message") or ""),
            "last_run_at": st.get("last_run_at"),
            "last_run_started_at": st.get("last_run_started_at"),
            "last_run_trigger": st.get("last_run_trigger"),
            "next_run_at": _cron_next_run(sched, now) if enabled else None,
        }
        rows.append(row)

    runs = state.get("runs") if isinstance(state.get("runs"), list) else []
    out_runs = [dict(r) for r in runs if isinstance(r, dict)]
    out_runs.sort(key=lambda r: str(r.get("started_at") or ""), reverse=True)

    sched_alive = bool(_SCHEDULER_THREAD and _SCHEDULER_THREAD.is_alive())
    return {
        "updated_at": _utc_iso(),
        "scheduler": {
            "running": sched_alive,
            "tick_interval_s": 5,
        },
        "automations": rows,
        "runs": out_runs[: max(1, min(int(limit_runs or 100), 2000))],
    }


# Ensure files exist on import.
_ensure_dirs()
_load_config()
_load_state()
