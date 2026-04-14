"""
Populate pipeline — one button to rule them all.

Stages:
  1. CRM Sync      — fetch pairs, deposit data, rebuild index.json, upsert DB
  2. Sort & Plan   — read index.json, sort pairs by net_deposits desc
  3. Transcribe    — submit every untranscribed call to the job queue
                     (skips calls that already have smoothed.txt)

Can be re-run safely: sync is idempotent, transcription skips already-done calls.

Architecture: poll-based (not SSE) so it works through any HTTP/2 LB.
POST /populate/start  → fires background thread, returns immediately
GET  /populate/status → returns running state + accumulated log events
POST /populate/reset  → clears stale running flag
"""
from __future__ import annotations

import asyncio
import json
import queue
import threading
from datetime import datetime, timezone

from fastapi import APIRouter

from ui.backend.config import settings
from ui.backend.routers.sync import _run_sync

router = APIRouter(prefix="/populate", tags=["populate"])

_pop_lock = threading.Lock()
_pop_state: dict = {
    "running": False,
    "stage": 0,
    "log": [],          # list of {event, msg, ...} dicts accumulated during run
    "last_run": None,
    "last_result": None,
}


def _push(event: str, msg: str, **kw):
    """Append a log entry to the shared state (thread-safe via GIL for list.append)."""
    entry = {"event": event, "msg": msg, **kw}
    _pop_state["log"].append(entry)


def _set_stage(n: int):
    _pop_state["stage"] = n


@router.get("/status")
def populate_status():
    return _pop_state


@router.post("/reset")
def populate_reset():
    """Force-clear the running flag (e.g. after a dropped connection)."""
    with _pop_lock:
        _pop_state["running"] = False
    return {"ok": True}


def _run_populate():
    """Runs in a background thread. Updates _pop_state directly."""
    try:
        # ── Stage 1: CRM Sync ─────────────────────────────────────────────────
        _set_stage(1)
        _push("stage", "Stage 1 / 3 — CRM sync", stage=1)

        sync_q: queue.Queue = queue.Queue()
        sync_thread = threading.Thread(target=_run_sync, args=(sync_q,), daemon=True)
        sync_thread.start()

        while True:
            try:
                item = sync_q.get(timeout=0.5)
            except queue.Empty:
                continue
            if item is None:
                break
            evt = "error" if item.get("error") else "sync"
            _push(evt, item.get("msg", ""), **{k: v for k, v in item.items() if k != "msg"})

        # ── Stage 2: Sort pairs by net deposits ───────────────────────────────
        _set_stage(2)
        _push("stage", "Stage 2 / 3 — Sorting pairs by net deposits", stage=2)

        index: list[dict] = []
        if settings.index_file.exists():
            try:
                index = json.loads(settings.index_file.read_text())
            except Exception as e:
                _push("error", f"Failed to read index.json: {e}")
                return

        pairs_sorted = sorted(
            index,
            key=lambda p: p.get("net_deposits") or 0,
            reverse=True,
        )
        pairs_with_calls = [
            p for p in pairs_sorted
            if (p.get("recorded_calls") or 0) > 0
            and p.get("crm") and p.get("agent") and p.get("customer")
        ]
        pairs_no_calls = len(pairs_sorted) - len(pairs_with_calls)

        _push("plan", (
            f"Found {len(pairs_with_calls)} pairs with recorded calls "
            f"({pairs_no_calls} skipped — no recordings)"
        ), total=len(pairs_with_calls), skipped_no_calls=pairs_no_calls)

        if not pairs_with_calls:
            _push("done", "No pairs with recorded calls — nothing to transcribe",
                  submitted=0, skipped=0, pairs=0)
            _pop_state["last_result"] = {"submitted": 0, "skipped": 0, "pairs_processed": 0,
                                          "completed_at": datetime.now(timezone.utc).isoformat()}
            return

        # ── Stage 3: Submit transcription jobs ────────────────────────────────
        _set_stage(3)
        _push("stage", "Stage 3 / 3 — Submitting transcription jobs", stage=3)

        from ui.backend.routers.transcription_process import (
            BatchPairsRequest, PairSpec, batch_transcribe_pairs,
        )

        CHUNK = 100
        total_submitted = 0
        total_skipped = 0

        for i in range(0, len(pairs_with_calls), CHUNK):
            chunk = pairs_with_calls[i: i + CHUNK]
            chunk_num = i // CHUNK + 1
            total_chunks = (len(pairs_with_calls) + CHUNK - 1) // CHUNK

            _push("progress", (
                f"Batch {chunk_num}/{total_chunks} — "
                f"submitting {len(chunk)} pairs "
                f"(#{i + 1}–{min(i + CHUNK, len(pairs_with_calls))} by deposits)"
            ), batch=chunk_num, total_batches=total_chunks)

            req = BatchPairsRequest(
                pairs=[
                    PairSpec(
                        crm_url=p["crm"],
                        account_id=str(p.get("account_id", "")),
                        agent=p["agent"],
                        customer=p["customer"],
                    )
                    for p in chunk
                ],
                smooth_model="gpt-5.4",
            )

            try:
                # batch_transcribe_pairs is async — run it in a new event loop
                result = asyncio.run(batch_transcribe_pairs(req))
                total_submitted += result.get("submitted", 0)
                total_skipped   += result.get("skipped", 0)
                _push("batch_done", (
                    f"Batch {chunk_num} done — "
                    f"{result.get('submitted', 0)} jobs submitted, "
                    f"{result.get('skipped', 0)} already done"
                ), submitted=result.get("submitted", 0), skipped=result.get("skipped", 0))
            except Exception as exc:
                _push("error", f"Batch {chunk_num} failed: {exc}")

        summary = (
            f"Populate complete — "
            f"{total_submitted} transcription jobs submitted, "
            f"{total_skipped} calls already done"
        )
        _pop_state["last_result"] = {
            "submitted": total_submitted,
            "skipped": total_skipped,
            "pairs_processed": len(pairs_with_calls),
            "completed_at": datetime.now(timezone.utc).isoformat(),
        }
        _push("done", summary,
              submitted=total_submitted, skipped=total_skipped,
              pairs=len(pairs_with_calls))
        _set_stage(4)

    except Exception as exc:
        _push("error", f"Populate pipeline failed: {exc}")
    finally:
        with _pop_lock:
            _pop_state["running"] = False


@router.post("/start")
def start_populate():
    """
    Start the populate pipeline in a background thread and return immediately.
    The frontend polls GET /populate/status to get progress.
    """
    with _pop_lock:
        if _pop_state["running"]:
            return {"ok": False, "error": "Populate already running"}
        _pop_state["running"] = True
        _pop_state["stage"] = 0
        _pop_state["log"] = []
        _pop_state["last_run"] = datetime.now(timezone.utc).isoformat()

    t = threading.Thread(target=_run_populate, daemon=True)
    t.start()
    return {"ok": True}
