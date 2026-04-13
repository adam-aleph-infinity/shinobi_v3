"""Global in-memory log buffer — captures all stdout and queues it for SSE streaming.

Design: emit() is called from any thread and just appends to a deque.
SSE generators poll get_after(seq) every 0.3 s on the event loop — no
cross-thread asyncio communication, no call_soon_threadsafe, no Queue.
"""
import logging
import sys
import threading
from collections import deque
from dataclasses import dataclass
from datetime import datetime
from typing import Optional

_MAX_LINES = 2000
_lock = threading.Lock()

# Thread-local job context — set by job_runner when a pipeline thread starts
_current_job: threading.local = threading.local()


@dataclass
class LogLine:
    seq: int
    ts: str
    text: str
    level: str = "info"   # info | warn | error | stage
    job_id: Optional[str] = None  # set when emitted from a pipeline thread


# Circular buffer + monotonic sequence counter
_buffer: deque[LogLine] = deque(maxlen=_MAX_LINES)
_seq: int = 0


def _classify(text: str) -> str:
    t = text.upper()
    if any(x in t for x in ("ERROR", "EXCEPTION", "TRACEBACK", "FAILED")):
        return "error"
    if any(x in t for x in ("WARNING", "WARN")):
        return "warn"
    if any(x in t for x in ("STAGE", "PIPELINE", "✅", "🚀", "📡", "🎵", "📝", "📊")):
        return "stage"
    # LLM operations — vote, smooth, persona, session analysis
    if any(t.startswith(p) for p in ("[VOTE]", "[SMOOTH]", "[LLM]", "[PERSONA]", "[SESSION", "[VOTE-BATCH]", "[SMOOTH-BATCH]", "[MERGE]", "[FPA]")):
        return "llm"
    return "info"


_job_hooks: list = []  # populated by job_runner to forward lines to per-job streams


def set_job_context(job_id: Optional[str]):
    """Mark the current thread as belonging to a job (or clear it). Thread-safe."""
    _current_job.job_id = job_id


def emit(text: str):
    """Append a line to the buffer. Thread-safe — no asyncio interaction."""
    global _seq
    job_id = getattr(_current_job, "job_id", None)
    with _lock:
        _seq += 1
        line = LogLine(
            seq=_seq,
            ts=datetime.utcnow().strftime("%H:%M:%S"),
            text=text,
            level=_classify(text),
            job_id=job_id,
        )
        _buffer.append(line)
    for hook in _job_hooks:
        try:
            hook(text)
        except Exception:
            pass


def clear():
    """Clear the in-memory log buffer. Thread-safe.

    Does NOT reset the sequence counter so existing SSE subscribers continue
    receiving new lines after the buffer is cleared without missing anything.
    """
    with _lock:
        _buffer.clear()


def get_recent(n: int = 200) -> list[LogLine]:
    return list(_buffer)[-n:]


def get_after(seq: int) -> list[LogLine]:
    """Return all lines with seq > the given value (for SSE polling)."""
    return [l for l in list(_buffer) if l.seq > seq]


def get_by_job(job_id: str) -> list[LogLine]:
    """Return all buffered lines for a specific job_id."""
    return [l for l in list(_buffer) if l.job_id == job_id]


class _LogInterceptor:
    """Wraps sys.stdout so every write also goes to the log buffer."""
    def __init__(self, original):
        self._original = original

    def write(self, text: str):
        self._original.write(text)
        for chunk in text.split("\n"):
            if chunk.strip():
                emit(chunk)

    def flush(self):
        self._original.flush()

    def __getattr__(self, name):
        return getattr(self._original, name)


class _LogHandler(logging.Handler):
    """Feeds Python logging records (WARNING+) into the log buffer."""
    def emit(self, record: logging.LogRecord):
        msg = self.format(record)
        level = "error" if record.levelno >= logging.ERROR else "warn"
        emit(f"[{level.upper()}] {msg}")


def install():
    """Install stdout interceptor + logging handler. Call once at app startup."""
    if not isinstance(sys.stdout, _LogInterceptor):
        sys.stdout = _LogInterceptor(sys.stdout)
    handler = _LogHandler()
    handler.setLevel(logging.WARNING)
    handler.setFormatter(logging.Formatter("%(name)s: %(message)s"))
    root = logging.getLogger()
    if not any(isinstance(h, _LogHandler) for h in root.handlers):
        root.addHandler(handler)
