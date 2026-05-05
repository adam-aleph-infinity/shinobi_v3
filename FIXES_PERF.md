# Shinobi V3 — Performance Fix: Page Navigation Delay

**Problem:** Navigating between pages (especially CRM Browser) takes 1–3 seconds due to
double-fetching and unbounded queries. All file paths relative to
`/Users/adamleeperelman/Documents/AI/shinobi_v3/ui/`.

---

## FIX 1 — CRM Browser: Eliminate double-fetch on every mount (biggest impact)

**Root cause:**  
`CRMBrowserPage.tsx` initializes all filter state to empty defaults, then a
`useEffect` (line 239) restores the real filters from sessionStorage after mount.
This causes the SWR key to change one frame after mount:

```
Mount → SWR fires with key "/crm/pairs?sort=agent&dir=asc" (empty filters)
         └─ network request A starts
useEffect fires → filters restored → SWR key changes to "/crm/pairs?sort=agent&dir=asc&agent=xyz&..."
         └─ network request A abandoned/ignored, request B starts
```

Result: two network round-trips on every visit instead of one.

**Fix — `frontend/components/crm/CRMBrowserPage.tsx`:**

Add a `filtersReady` flag and gate the SWR key on it. SWR with a `null` key does
nothing. The `useEffect` fires synchronously after the first render (within one
frame); `filtersReady` flips to `true`; SWR fires exactly once with the correct key.

**Step 1** — Add `filtersReady` state (add alongside other `useState` declarations,
around line 235):

```tsx
const [filtersReady, setFiltersReady] = useState(false);
```

**Step 2** — At the END of the existing `useEffect` that restores from sessionStorage
(currently ends around line 279), add:

```tsx
    setFiltersReady(true);
```

So the final line of that `useEffect` body sets `filtersReady = true`.

**Step 3** — Gate the filtered-pairs SWR key on `filtersReady`.  
Current (line 325):
```tsx
const { data: pairs, isLoading, error, mutate } = useSWR<AgentCustomerPair[]>(
  `/crm/pairs?${params.toString()}`, fetcher, { refreshInterval: 0 }
);
```

Replace with:
```tsx
const { data: pairs, isLoading, error, mutate } = useSWR<AgentCustomerPair[]>(
  filtersReady ? `/crm/pairs?${params.toString()}` : null,
  fetcher,
  { refreshInterval: 0, keepPreviousData: true }
);
```

**Also gate `allPairs`** (line 300):
```tsx
const { data: allPairs } = useSWR<AgentCustomerPair[]>(
  filtersReady ? `/crm/pairs?sort=agent&dir=asc` : null,
  fetcher
);
```

**Also gate `artifactMetricsPath`** — it already has a `null` guard via `useMemo`
(line 332–338), no change needed there.

**Result:** On every navigation to CRM Browser, exactly one network request fires,
with the correct filter params, and SWR returns cached data instantly if the same
filters were used on the last visit.

---

## FIX 2 — CRM Browser: Replace `allPairs` with a lightweight CRM-list endpoint

**Root cause:**  
`allPairs` (line 300) fetches the full unbounded pairs list — all fields, all rows —
just to extract the list of distinct CRM URLs for the filter dropdown. This is a
heavy query for a tiny result.

**Step 1 — Backend: add a new endpoint in `backend/routers/crm.py`**

Add after the existing `get_pairs` function (after line 170):

```python
@router.get("/crm-urls")
def get_crm_urls(db: Session = Depends(get_session)):
    """Returns the list of distinct CRM base URLs — used to populate the CRM filter dropdown."""
    from sqlalchemy import select as sa_select, distinct
    try:
        rows = db.exec(sa_select(distinct(CRMPair.crm_url)).order_by(CRMPair.crm_url)).all()
        return [r for r in rows if r]
    except Exception as e:
        raise HTTPException(500, str(e))
```

**Step 2 — Frontend: replace `allPairs` SWR with the new endpoint**

In `CRMBrowserPage.tsx`, replace line 300:
```tsx
const { data: allPairs } = useSWR<AgentCustomerPair[]>(
  filtersReady ? `/crm/pairs?sort=agent&dir=asc` : null,
  fetcher
);
const allPairsSafe: AgentCustomerPair[] = Array.isArray(allPairs) ? allPairs : [];
const crms = Array.from(new Set(allPairsSafe.map((p) => p.crm_url))).sort();
```

With:
```tsx
const { data: crmUrls } = useSWR<string[]>(
  filtersReady ? `/crm/crm-urls` : null,
  fetcher
);
const crms: string[] = Array.isArray(crmUrls) ? crmUrls.filter(Boolean).sort() : [];
```

Remove the `allPairsSafe` line — it is no longer needed.

Search the rest of `CRMBrowserPage.tsx` for any other uses of `allPairs` or
`allPairsSafe` and confirm they are only for `crms`. (They are, as of the April 2026
audit — but verify before deleting.)

**Result:** The CRM dropdown fetch becomes a tiny `SELECT DISTINCT crm_url` instead
of loading all pair rows. Payload drops from potentially hundreds of KB to ~1 KB.

---

## FIX 3 — All pages: SWR stale-while-revalidate via `keepPreviousData`

**Root cause:**  
When any SWR key changes (e.g. filter change, sort change), `data` goes to
`undefined` and `isLoading` goes to `true`. If the page renders a blank/spinner
based on `isLoading`, the user sees a flash of empty content.

**File:** `frontend/components/crm/CRMBrowserPage.tsx`

Find every `useSWR` call in this file and add `keepPreviousData: true` to its
options object. Specifically:

- Line 325 (already included in Fix 1 above)
- Line 330 (txStats): add `keepPreviousData: true` to its options
- Line 340 (artifactIndex): add `keepPreviousData: true` to its options

The `keepPreviousData: true` option tells SWR to continue returning the last good
data while a new fetch is in-flight, instead of returning `undefined`. The table
stays populated during any filter/sort changes; a spinner can optionally be shown
in the header to indicate background refresh.

---

## FIX 4 — All pages: SWR global `dedupingInterval` increase

**Root cause:**  
SWR's default `dedupingInterval` is 2000ms. If the same key is requested within
2 seconds of a previous request, SWR deduplicates. But across page navigations
that happen within that window, SWR still fires a revalidation on remount (because
`revalidateOnMount: true` by default).

**File:** `frontend/app/providers.tsx`

Add `dedupingInterval` and `revalidateOnMount` to the global `SWRConfig`:

```tsx
<SWRConfig
  value={{
    dedupingInterval: 10000,        // don't re-fetch same key within 10s
    revalidateOnMount: true,        // still fetch fresh on first load, but...
    focusThrottleInterval: 30000,   // ...throttle focus-based revalidation
    onErrorRetry: ...               // keep existing
    onError: ...                    // keep existing
    revalidateOnFocus: false,       // keep existing
  }}
>
```

Setting `dedupingInterval: 10000` means: if you navigate to CRM Browser, then
immediately to Live, then back to CRM Browser — the data is returned from SWR's
in-memory cache with no network request if less than 10 seconds have passed.

**Important:** Do NOT set `revalidateOnMount: false` globally — that would stop
data from refreshing ever. Only increase the dedup window.

---

## FIX 5 — CRM Browser: Show skeleton rows while loading (perceived performance)

**Root cause:**  
While `isLoading` is true (or `!filtersReady`), the table area is empty or shows a
single spinner. The user sees a blank page.

**File:** `frontend/components/crm/CRMBrowserPage.tsx`

Find where the table rows are rendered (search for `.map((pair` or `pairsSafe.map`).
Above that map, add a skeleton block:

```tsx
{(!filtersReady || isLoading) && pairsSafe.length === 0 ? (
  // Skeleton rows — 8 placeholder rows during initial load
  Array.from({ length: 8 }).map((_, i) => (
    <tr key={i} className="border-b border-gray-800 animate-pulse">
      <td className="px-3 py-2"><div className="h-3 bg-gray-800 rounded w-24" /></td>
      <td className="px-3 py-2"><div className="h-3 bg-gray-800 rounded w-32" /></td>
      <td className="px-3 py-2"><div className="h-3 bg-gray-800 rounded w-16" /></td>
      <td className="px-3 py-2"><div className="h-3 bg-gray-800 rounded w-8" /></td>
      <td className="px-3 py-2"><div className="h-3 bg-gray-800 rounded w-12" /></td>
    </tr>
  ))
) : pairsSafe.map((pair) => (
  // existing row render...
))}
```

Adjust the number of `<td>` elements and their widths to match the actual column
count. The goal is to show the table structure immediately, not a spinning loader.

---

## Summary of Changes

| File | Change |
|---|---|
| `backend/routers/crm.py` | Add `GET /crm/crm-urls` endpoint (Fix 2) |
| `frontend/components/crm/CRMBrowserPage.tsx` | filtersReady gate (Fix 1), crm-urls endpoint (Fix 2), keepPreviousData (Fix 3), skeleton rows (Fix 5) |
| `frontend/app/providers.tsx` | dedupingInterval + focusThrottleInterval (Fix 4) |

**Deploy order:** Backend first (Fix 2 adds new endpoint), then frontend.

---

## Testing Checklist

After applying all fixes:

- [ ] Navigate to CRM Browser — should render table immediately (skeleton or cached data), no blank flash
- [ ] Navigate away (e.g. to Live) and back — data should appear instantly (SWR cache hit), background revalidation should update silently
- [ ] Apply a filter (agent name) — table should stay populated with previous results while new results load
- [ ] Clear all filters — table should reload without going blank
- [ ] CRM filter dropdown should still show all CRM URLs regardless of other filters applied
- [ ] Artifacts mode (if enabled) — artifact metrics panel should still load and display correctly
- [ ] `pairPickerMode` usage (called from other pages) — verify CRM picker still works
