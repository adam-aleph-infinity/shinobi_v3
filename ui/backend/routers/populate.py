"""
Populate pipeline — one button to rule them all.

Stages:
  1. CRM Sync      — fetch pairs, deposit data, rebuild index.json, upsert DB
  2. Sort & Plan   — read index.json, sort pairs by net_deposits desc
  3. Transcribe    — submit every untranscribed call to the job queue
                     (skips calls that already have smoothed.txt)

Can be re-run safely: sync is idempotent, transcription skips already-done calls.
"""
from __future__ import annotations

import asyncio
import json
import queue
import threading
from datetime import datetime, timezone

from fastapi import APIRouter
from fastapi.responses import StreamingResponse

from ui.backend.config import settings
from ui.backend.routers.sync import _run_sync

router = APIRouter(prefix="/populate", tags=["populate"])

_pop_lock = threading.Lock()
_pop_state: dict = {"running": False, "last_run": None, "last_result": None}


def _sse(event: str, msg: str, **kw) -> str:
    return f"event: {event}\ndata: {json.dumps({'msg': msg, **kw})}\n\n"


@router.get("/status")
def populate_status():
    return _pop_state


@router.post("/reset")
def populate_reset():
    """Force-clear the running flag (e.g. after a dropped SSE connection)."""
    with _pop_lock:
        _pop_state["running"] = False
    return {"ok": True}


@router.post("/start")
async def start_populate():
    """
    Start the full populate pipeline. Returns an SSE stream of progress events.
    Only one populate run may be active at a time.
    """
    with _pop_lock:
        if _pop_state["running"]:
            async def _already():
                yield _sse("error", "Populate already running")
            return StreamingResponse(_already(), media_type="text/event-stream")
        _pop_state["running"] = True
        _pop_state["last_run"] = datetime.now(timezone.utc).isoformat()

    loop = asyncio.get_event_loop()

    async def stream():
        try:
            # ── Stage 1: CRM Sync ────────────────────────────────────────────
            yield _sse("stage", "Stage 1 / 3 — CRM sync", stage=1)
            # Padding to flush proxy buffer
            yield ": " + " " * 4096 + "\n\n"

            sync_q: queue.Queue = queue.Queue()
            sync_thread = threading.Thread(target=_run_sync, args=(sync_q,), daemon=True)
            sync_thread.start()

            _last_keepalive = asyncio.get_event_loop().time()
            while True:
                try:
                    item = sync_q.get_nowait()
                except queue.Empty:
                    await asyncio.sleep(0.1)
                    # Emit a keepalive comment every 10s so the proxy doesn't drop the connection
                    now = asyncio.get_event_loop().time()
                    if now - _last_keepalive >= 10:
                        yield ": keepalive\n\n"
                        _last_keepalive = now
                    continue
                if item is None:
                    break
                # Forward sync events; mark errors but keep going
                evt = "error" if item.get("error") else "sync"
                yield _sse(evt, item.get("msg", ""), **{k: v for k, v in item.items() if k != "msg"})
                _last_keepalive = asyncio.get_event_loop().time()

            # ── Stage 2: Sort pairs by net deposits ──────────────────────────
            yield _sse("stage", "Stage 2 / 3 — Sorting pairs by net deposits", stage=2)

            index: list[dict] = []
            if settings.index_file.exists():
                try:
                    index = json.loads(settings.index_file.read_text())
                except Exception as e:
                    yield _sse("error", f"Failed to read index.json: {e}")
                    return

            # Sort highest net deposits first; pairs with no deposit data go last
            pairs_sorted = sorted(
                index,
                key=lambda p: p.get("net_deposits") or 0,
                reverse=True,
            )

            # Only include pairs that have recorded calls
            pairs_with_calls = [
                p for p in pairs_sorted
                if (p.get("recorded_calls") or 0) > 0
                and p.get("crm") and p.get("agent") and p.get("customer")
            ]
            pairs_no_calls = len(pairs_sorted) - len(pairs_with_calls)

            yield _sse("plan", (
                f"Found {len(pairs_with_calls)} pairs with recorded calls "
                f"({pairs_no_calls} skipped — no recordings)"
            ), total=len(pairs_with_calls), skipped_no_calls=pairs_no_calls)

            if not pairs_with_calls:
                yield _sse("done", "No pairs with recorded calls — nothing to transcribe",
                           submitted=0, skipped=0)
                _pop_state["last_result"] = {"submitted": 0, "skipped": 0}
                return

            # ── Stage 3: Submit transcription jobs ───────────────────────────
            yield _sse("stage", "Stage 3 / 3 — Submitting transcription jobs", stage=3)
            yield ": " + " " * 4096 + "\n\n"

            from ui.backend.routers.transcription_process import (
                BatchPairsRequest, PairSpec, batch_transcribe_pairs,
            )

            # Submit in chunks of 100 so we can report progress
            CHUNK = 100
            total_submitted = 0
            total_skipped = 0

            for i in range(0, len(pairs_with_calls), CHUNK):
                chunk = pairs_with_calls[i: i + CHUNK]
                chunk_num = i // CHUNK + 1
                total_chunks = (len(pairs_with_calls) + CHUNK - 1) // CHUNK

                yield _sse("progress", (
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
                    yield ": keepalive\n\n"
                    result = await batch_transcribe_pairs(req)
                    total_submitted += result.get("submitted", 0)
                    total_skipped   += result.get("skipped", 0)
                    yield _sse("batch_done", (
                        f"Batch {chunk_num} done — "
                        f"{result.get('submitted', 0)} jobs submitted, "
                        f"{result.get('skipped', 0)} already done"
                    ), submitted=result.get("submitted", 0), skipped=result.get("skipped", 0))
                except Exception as exc:
                    yield _sse("error", f"Batch {chunk_num} failed: {exc}")

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
            yield _sse("done", summary,
                       submitted=total_submitted, skipped=total_skipped,
                       pairs=len(pairs_with_calls))

        except Exception as exc:
            yield _sse("error", f"Populate pipeline failed: {exc}")
        finally:
            with _pop_lock:
                _pop_state["running"] = False

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
