# Shinobi V3 — Fix Backlog for Agent

Full codebase audit completed April 2026. All file paths relative to `/Users/adamleeperelman/Documents/AI/shinobi_v3/ui/`.

Read the full analysis at:
`/Users/adamleeperelman/.claude/projects/-Users-adamleeperelman-Documents-AI-shinobi-v3/memory/project_shinobi_app_analysis.md`

---

## TIER 1 — CRITICAL (Do first, in order)

### T1-1: Add rate limiting to webhook endpoints
**File:** `backend/routers/webhooks.py`
**Problem:** No rate limiting on `POST /webhooks/call-ended` or `POST /webhooks/call-updated`. Any client can flood the server and grow the queue indefinitely.
**Fix:** Add a token bucket or sliding window rate limiter. Use `slowapi` (FastAPI-compatible) or implement a simple in-memory per-IP counter with a deque. Limit: 60 requests/min per IP. Return HTTP 429 on breach.
**Install:** `pip install slowapi`

---

### T1-2: Replace sync file I/O in webhook handler with async
**File:** `backend/routers/webhooks.py`
**Line:** ~1504 — `_persist_webhook_event()` uses `Path.write_text()` (blocking)
**Problem:** Blocking file write in the async FastAPI handler starves the event loop under load.
**Fix:** Replace `Path.write_text(...)` with `aiofiles.open(...).write(...)`. Also check `_load_queue()` and `_save_queue()` — if they use `json.load(open(...))` / `Path.write_text(...)`, make them async too.
**Install:** `pip install aiofiles`

---

### T1-3: Fix race condition in duplicate detection (queue enqueue)
**File:** `backend/routers/webhooks.py`
**Lines:** 857–920 — `_enqueue_live_item()`
**Problem:** Load queue → check duplicate → append → save is not atomic. Two concurrent webhooks can both read the queue before either writes, both pass the duplicate check, and both enqueue — causing duplicate pipeline runs.
**Fix:** Move duplicate detection inside the lock (it may already be, verify), and do not release the lock between the DB check and the file write. Better: use a database row with a unique constraint as the authoritative duplicate gate (see T1-5) instead of the JSON file.

---

### T1-4: Increase SSE pipeline startup timeout from 15s to 300s
**File:** `backend/routers/webhooks.py`
**Line:** ~829 — `asyncio.wait_for(..., timeout=15)`
**Problem:** If pipeline startup takes longer than 15s (e.g. under DB load), the `run_id` is never captured and the item is stuck in "preparing" forever.
**Fix:** Increase timeout to `300` seconds. Also add incremental event emission from the pipeline startup path so the caller knows it's alive.

---

### T1-5: Add unique DB constraint to prevent duplicate pipeline runs
**File:** `backend/models/pipeline_run.py`
**Problem:** No unique constraint on `(pipeline_id, sales_agent, customer, call_id)`. Duplicate webhooks or race conditions can create multiple `PipelineRun` rows for the same call.
**Fix:** Add a SQLModel/SQLAlchemy `UniqueConstraint`:
```python
from sqlalchemy import UniqueConstraint
# In PipelineRun model class:
__table_args__ = (
    UniqueConstraint("pipeline_id", "sales_agent", "customer", "call_id", name="uq_pipeline_run_call"),
)
```
Then handle the `IntegrityError` at enqueue time to treat it as "already exists".

---

### T1-6: Fix prompt injection — sanitize score_prompt before LLM injection
**Files:**
- `backend/routers/personas.py` line ~1318
- `backend/routers/full_persona_agent.py` lines ~900–920

**Problem:** User-supplied `score_prompt` (from DB or request body) is string-concatenated directly into the LLM system prompt:
```python
scorer_system = _DEFAULT_SCORE_SYSTEM + "\n\n" + score_prompt  # UNSAFE
```
An attacker who can write to the DB or send a crafted request can override LLM behavior.
**Fix:**
1. Validate `score_prompt` max length (e.g. 2000 chars).
2. Strip any occurrence of role-delimiter strings: `\n\nHuman:`, `\n\nAssistant:`, `<system>`, etc.
3. Wrap it in a clearly labeled section so it cannot escape its container:
```python
safe_prompt = score_prompt[:2000].replace("\n\nHuman:", "").replace("\n\nAssistant:", "")
scorer_system = _DEFAULT_SCORE_SYSTEM + "\n\n# User custom instructions:\n" + safe_prompt
```

---

### T1-7: Remove webhook token from request body
**File:** `backend/routers/webhooks.py`
**Lines:** ~527–544 — token extraction in `_extract_webhook_token()`
**Problem:** Token is accepted from the JSON payload body (`payload.token`), which means it gets logged to the inbox JSON file on disk. Headers are the correct auth channel.
**Fix:** Remove the `payload.token` candidate from the list:
```python
# REMOVE this line:
if payload.token:
    candidates.append(payload.token)
```
Also redact the `token` field from the payload before writing to the inbox JSON in `_persist_webhook_event()`.

---

### T1-8: Add PostgreSQL connection pool config
**File:** `backend/database.py`
**Line:** ~10 — `create_engine(_DATABASE_URL, echo=False, pool_pre_ping=True)`
**Problem:** Default pool_size=5, max_overflow=10. With 10 job workers + concurrent API requests, pool exhausts quickly.
**Fix:**
```python
engine = create_engine(
    _DATABASE_URL,
    echo=False,
    pool_pre_ping=True,
    pool_size=20,
    max_overflow=40,
    pool_recycle=3600,
)
```
This only applies when using PostgreSQL (the SQLite branch doesn't need pooling).

---

## TIER 2 — HIGH (After Tier 1)

### T2-1: Add queue depth limit + drop policy
**File:** `backend/routers/webhooks.py`
**Problem:** Queue file grows unbounded if dispatcher is stalled. Loading a 100k-item JSON on each dispatcher cycle will OOM.
**Fix:**
- After loading the queue, if `len(queue) > 10000`, drop the oldest non-running items (keep running ones) and log a warning.
- Add a `/webhooks/queue-depth` endpoint that returns the current queue length for monitoring.

---

### T2-2: Add job watchdog — mark stuck jobs as failed
**File:** `backend/services/job_runner.py`
**Problem:** If a worker thread dies (OOM, exception), the job stays `status=running` forever. No watchdog recovers it.
**Fix:** Add a background task (run on startup via `asyncio.create_task`) that queries the DB every 5 minutes for jobs with `status="running"` and `updated_at < now - 1 hour`, then marks them `status="failed"` with `error="watchdog: timed out"`.

---

### T2-3: Add TTL cleanup for `_streams` dict
**File:** `backend/services/job_runner.py`
**Line:** ~54 — `_streams: dict[str, _JobStream] = {}`
**Problem:** Every job that ever ran adds an entry here. No cleanup. Memory grows forever.
**Fix:** Store a `created_at` timestamp in `_JobStream`. Add a background cleanup task (every 30 min) that removes entries where `created_at < now - 24h` and `subscribers` list is empty.

---

### T2-4: Bound SSE subscriber queues and subscriber count
**File:** `backend/routers/jobs.py`
**Lines:** ~182–196 — `stream_job()` generator
**Problem:** `asyncio.Queue()` has no maxsize. If a slow client subscribes and the job is chatty, the queue grows unbounded. Also no cap on total subscribers per job.
**Fix:**
```python
queue: asyncio.Queue = asyncio.Queue(maxsize=500)
```
Add `maxsize=500` to cap the queue. If the queue is full (subscriber too slow), drop the oldest item (`queue.get_nowait()` before `put_nowait()`). Cap subscribers per job at 10.

---

### T2-5: Fix ThreadPoolExecutor leak on resize
**File:** `backend/services/job_runner.py`
**Lines:** ~27–33 — `set_max_workers()`
**Problem:** When worker count is changed, a new executor is created and the old one is abandoned — its threads keep running but are never joined.
**Fix:**
```python
def set_max_workers(n: int):
    global _executor, _max_workers
    n = max(1, min(64, n))
    if n != _max_workers:
        old = _executor
        _executor = ThreadPoolExecutor(max_workers=n)
        _max_workers = n
        old.shutdown(wait=False)  # signal threads to stop after current tasks
```

---

### T2-6: Add overall timeout to all LLM calls
**Files:**
- `backend/routers/universal_agents.py` — LLM calls with `asyncio.to_thread`
- `backend/routers/assistant.py` — `asyncio.to_thread` for chat completion
- `backend/routers/personas.py` — ThreadPoolExecutor scorer
- `backend/routers/notes.py` — LLM analysis
- `backend/routers/full_persona_agent.py` — multi-stage pipeline

**Problem:** LLM calls have no `asyncio.wait_for` timeout. A single slow/hung API call ties up a worker indefinitely.
**Fix:** Wrap every `asyncio.to_thread(llm_call, ...)` with:
```python
result = await asyncio.wait_for(
    asyncio.to_thread(llm_call, ...),
    timeout=300  # 5 minutes max per LLM call
)
```
Catch `asyncio.TimeoutError` and yield an SSE error event.

---

### T2-7: Add fetch timeout to lib/api.ts
**File:** `frontend/lib/api.ts`
**Problem:** All `fetch()` calls have no timeout. If the backend is slow or hangs, the UI just spins forever.
**Fix:** Add `AbortSignal.timeout(30_000)` to all fetch calls:
```typescript
const res = await fetch(url, {
  ...options,
  signal: AbortSignal.timeout(30_000),
})
```
Or add it as a default in the `api()` helper function so all callers get it automatically.

---

### T2-8: Add SSE reconnect logic to useJobStream
**File:** `frontend/lib/sse.ts`
**Problem:** On `onerror`, the EventSource is closed and never reconnected. A brief network blip drops all job progress.
**Fix:** Implement exponential backoff reconnect:
```typescript
let retries = 0
const connect = () => {
  const es = new EventSource(url)
  es.onerror = () => {
    es.close()
    if (retries < 5) {
      setTimeout(connect, Math.min(1000 * 2 ** retries, 30_000))
      retries++
    } else {
      setComplete(true)
    }
  }
  // ... rest of handlers
}
connect()
```

---

### T2-9: Add error boundaries to all major pages
**Files:** All files in `frontend/app/*/page.tsx`
**Problem:** No React Error Boundary anywhere. One thrown error (e.g. in artifact parsing in AgentDeepDiveView) crashes the entire page with a white screen.
**Fix:** Create `frontend/components/shared/ErrorBoundary.tsx` as a class component:
```tsx
class ErrorBoundary extends React.Component<{children: React.ReactNode}, {error: Error | null}> {
  state = { error: null }
  static getDerivedStateFromError(error: Error) { return { error } }
  render() {
    if (this.state.error) return <div className="p-8 text-red-400">Something went wrong: {this.state.error.message}</div>
    return this.props.children
  }
}
```
Wrap the content of each page and each major panel (CRMBrowserPage, AgentDeepDiveView, PipelineSidePanel) in this boundary.

---

## TIER 3 — MEDIUM (Next sprint)

### T3-1: Invalidate score cache in personas.py
**File:** `backend/routers/personas.py`
**Line:** ~1245 — `_score_cache: dict`
**Problem:** Cache never expires. Stale persona scores are served indefinitely.
**Fix:** Add a TTL: store `(result, timestamp)` tuples. On read, reject entries older than 1 hour. Or clear the cache entry when the persona is updated (on PUT endpoint).

---

### T3-2: Invalidate file ID cache in full_persona_agent.py
**File:** `backend/routers/full_persona_agent.py`
**Lines:** ~209–261 — file upload cache
**Problem:** Anthropic/OpenAI file IDs are cached forever. If a file is deleted on the provider side, subsequent requests fail silently.
**Fix:** Key the cache on file content hash + provider. Store `(file_id, uploaded_at)`. On API error with the cached file ID (404 or invalid), delete the cache entry and re-upload.

---

### T3-3: Add DB indexes for hot queries
**Files:** `backend/models/pipeline_run.py`, `backend/models/job.py`
**Fix:** Add SQLAlchemy `Index` declarations:
```python
# pipeline_run.py
from sqlalchemy import Index
__table_args__ = (Index("ix_pipeline_run_status", "status"),)

# job.py
from sqlalchemy import Index
__table_args__ = (
    Index("ix_job_pair_slug", "pair_slug"),
    Index("ix_job_batch_id", "batch_id"),
)
```

---

### T3-4: Make sync stages transactional
**File:** `backend/routers/sync.py`
**Lines:** ~385–409 — Stage 3 + Stage 4
**Problem:** Stage 3 writes `index.json` to disk, Stage 4 writes to DB. If Stage 4 fails, the on-disk index is out of sync with the DB.
**Fix:** Wrap both Stage 3 and Stage 4 in a single DB transaction. Use `aiofiles` for the file write inside the transaction. On exception, rollback the DB write and re-write the old index file (or skip the file write until DB succeeds).

---

### T3-5: Add max_workers limit to personas ThreadPoolExecutor
**File:** `backend/routers/personas.py`
**Lines:** ~745–749 — `ThreadPoolExecutor()`
**Problem:** No max_workers. A persona with 20 sections spawns 20 threads simultaneously.
**Fix:**
```python
with ThreadPoolExecutor(max_workers=4) as pool:
    futures = [pool.submit(score_section, s) for s in sections]
```

---

### T3-6: Cap assistant_knowledge row limit
**File:** `backend/services/assistant_knowledge.py`
**Line:** ~387 — `cap = max(1, min(50000, int(limit)))`
**Problem:** Caller can request 50k rows loaded into memory.
**Fix:** Change to `cap = max(1, min(500, int(limit)))`.

---

### T3-7: Sanitize log output before rendering in frontend
**File:** `frontend/app/logs/page.tsx`
**Lines:** ~596, 618 — `l.text` rendered directly into terminal DOM
**Problem:** If log text contains `<script>` tags or HTML, it would be injected. (Currently likely escaped by React, but risky if rendered via `dangerouslySetInnerHTML` anywhere.)
**Fix:** Confirm no `dangerouslySetInnerHTML` is used for log text. If logs are ever rendered as HTML, run through DOMPurify first. Add a regex strip for ANSI escape codes that the terminal renderer doesn't handle.

---

### T3-8: Add security headers to Next.js
**File:** `frontend/next.config.mjs`
**Problem:** No CSP, X-Content-Type-Options, or X-Frame-Options headers.
**Fix:** Add headers config:
```js
async headers() {
  return [{
    source: '/(.*)',
    headers: [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    ],
  }]
}
```

---

### T3-9: Fix hydration mismatch from localStorage in AppContext
**File:** `frontend/lib/app-context.tsx`
**Lines:** ~64–77
**Problem:** State initialized to `""` on server, then updated from localStorage in `useEffect`. SSR HTML and client HTML differ → React hydration warning, possible flicker.
**Fix:** Either:
- Use `suppressHydrationWarning` on the root element, OR
- Add a `mounted` state: render nothing (or skeleton) until `useEffect` fires and localStorage is read, so server and client match on first render.

---

### T3-10: Add AbortController to transcript fetch
**File:** `frontend/app/calls/page.tsx`
**Lines:** ~530–535
**Problem:** Fetching a transcript file has no AbortController. Switching calls rapidly causes the old fetch to complete and overwrite the new one.
**Fix:**
```typescript
useEffect(() => {
  const controller = new AbortController()
  fetch(transcriptUrl, { signal: controller.signal })
    .then(r => r.text())
    .then(setTranscript)
    .catch(e => { if (e.name !== 'AbortError') setTranscriptError(e) })
  return () => controller.abort()
}, [transcriptUrl])
```

---

## TIER 4 — LOW / TECH DEBT (Backlog)

### T4-1: Split PipelineSidePanel (2,092 lines)
**File:** `frontend/components/shared/PipelineSidePanel.tsx`
Split into:
- `PipelineRunController.tsx` — run trigger, status polling, job stream
- `StepDisplay.tsx` — per-step status cards and artifact badges
- `PipelineStateManager.ts` — state machine logic (pure functions, no JSX)

---

### T4-2: Split CRMBrowserPage (1,340 lines)
**File:** `frontend/components/crm/CRMBrowserPage.tsx`
Split into:
- `PairFilterBar.tsx` — all filter controls + sessionStorage persistence
- `PairTable.tsx` — the sortable pair list rows
- `ArtifactMetricsBadges.tsx` — the per-pair artifact counts

---

### T4-3: Replace `any` types in AgentDeepDiveView and PipelineSidePanel
Replace all `as any` and `Record<string, any>` with proper discriminated union types. Define the pipeline step shape in `lib/types.ts` and import it.

---

### T4-4: Move hardcoded S3 bucket mappings to config
**File:** `backend/services/job_runner.py`
**Lines:** ~110–114
```python
_CRM_S3_BUCKETS = {
    "mlbcrm.io":  ("mlb-bucket-prod", "eu-west-2"),
    "brtcrm.io":  ("brt-production",  "eu-west-2"),
    ...
}
```
Move this to a config file (`backend/crm_s3_config.json`) or a DB table so new CRM domains don't require code changes.

---

### T4-5: Add server-side pagination to live runs
**File:** `frontend/app/live/page.tsx` + `backend/routers/history.py`
**Problem:** Frontend fetches 300 runs every 2.5 seconds. As history grows this gets slow.
**Fix:** Add cursor-based pagination. Frontend requests last 50 runs, with a "load more" button. Reduce poll from 2.5s to 5s.

---

### T4-6: Persist filter state in live/page
**File:** `frontend/app/live/page.tsx`
**Problem:** All filters (type, pipeline, agent, customer, date) are lost on page reload.
**Fix:** Persist filter state to `sessionStorage` in a `useEffect`, hydrate on mount.

---

### T4-7: Add keyboard navigation and ARIA labels
**Files:** `frontend/components/crm/AgentDeepDiveView.tsx`, `frontend/components/shared/DragHandle.tsx`
- Add `onKeyDown` (Escape) to close modals
- Add `aria-label` to all icon-only buttons
- Add `role="dialog"` and `aria-modal="true"` to modal overlays

---

### T4-8: Add health check endpoint
**File:** `backend/main.py` (or new `backend/routers/health.py`)
**Fix:**
```python
@app.get("/health")
async def health():
    with Session(engine) as s:
        s.exec(text("SELECT 1"))
    return {
        "status": "ok",
        "queue_depth": len(_load_queue()),
        "workers": get_max_workers(),
        "version": version,
    }
```

---

### T4-9: Optimize startup alias merge from O(n) to O(1)
**File:** `backend/main.py`
**Lines:** ~229–264
**Problem:** For each alias, runs a separate `db.get(CRMPair, primary_id)` — N queries total.
**Fix:** Collect all primary IDs first, then do a single `select(CRMPair).where(CRMPair.id.in_(primary_ids))` and build a dict.

---

### T4-10: Add inbox file retention policy
**Directory:** `ui/data/_webhooks/inbox/`
**Problem:** Webhook inbox JSON files accumulate forever.
**Fix:** Add a startup task or cron that deletes inbox files older than 7 days.

---

## ADDITIONAL MISSING INFRA (for ops agent or deploy agent)

| Item | File | What to do |
|---|---|---|
| Nginx rate limiting | `deploy/` nginx config | Add `limit_req_zone $binary_remote_addr zone=webhooks:10m rate=60r/m;` + `limit_req zone=webhooks burst=20;` on `/webhooks/` location |
| Nginx SSE timeout | nginx config | Set `proxy_read_timeout 3600;` for `/api/logs/stream` and `/api/jobs/*/stream` locations |
| Graceful shutdown | `backend/main.py` | Add `@app.on_event("shutdown")` to drain `_executor` with `_executor.shutdown(wait=True, timeout=30)` |
| SQLite backup cron | VM crontab | `0 2 * * * cp /path/to/shinobi.db /path/to/backups/shinobi-$(date +\%Y\%m\%d).db` |
| Dead letter queue | `backend/routers/webhooks.py` | After max retries, write item to `ui/data/_webhooks/dead_letter/` instead of discarding |
| Log rotation | `ui/data/_webhooks/inbox/` | Delete files older than 7 days in startup task |

---

## NOTES FOR EXECUTING AGENT

- Always read a file before editing it.
- Run `mypy` or at minimum check for `any` type regressions when editing TypeScript.
- After each backend change, verify the app still starts: `uvicorn backend.main:app --reload`.
- After each frontend change, verify `next build` passes without errors.
- Bump `frontend/lib/version.ts` and `frontend/package.json` version before committing.
- Commit after each tier, not just at the end.
- Do not add unnecessary abstractions — fix exactly what's described.
