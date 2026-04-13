import asyncio
import json

from fastapi import APIRouter
from fastapi.responses import StreamingResponse

from ui.backend.services import log_buffer

router = APIRouter(prefix="/logs", tags=["logs"])


@router.delete("/buffer")
def clear_buffer():
    """Clear the in-memory log buffer."""
    log_buffer.clear()
    return {"cleared": True}


@router.get("/recent")
def get_recent(n: int = 300):
    return [{"ts": l.ts, "text": l.text, "level": l.level, "job_id": l.job_id} for l in log_buffer.get_recent(n)]


@router.get("/stream")
async def stream_logs():
    async def generator():
        # Send backlog (last 500 lines already in buffer)
        backlog = log_buffer.get_recent(500)
        last_seq = backlog[-1].seq if backlog else 0
        for line in backlog:
            yield f"data: {json.dumps({'ts': line.ts, 'text': line.text, 'level': line.level, 'job_id': line.job_id})}\n\n"

        # Poll for new lines every 0.3 s — no asyncio.Queue, no call_soon_threadsafe
        heartbeat_ticks = 0
        while True:
            await asyncio.sleep(0.3)
            new_lines = log_buffer.get_after(last_seq)
            for line in new_lines:
                last_seq = line.seq
                yield f"data: {json.dumps({'ts': line.ts, 'text': line.text, 'level': line.level, 'job_id': line.job_id})}\n\n"
            heartbeat_ticks += 1
            if heartbeat_ticks >= 100:  # ~30 s
                heartbeat_ticks = 0
                yield "data: {\"heartbeat\": true}\n\n"

    return StreamingResponse(
        generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
