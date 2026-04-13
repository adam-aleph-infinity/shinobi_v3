# Compare Personas — Implementation Spec

This document describes two related but separate pages in Shinobi v2:

1. **`/comparison`** — "Persona Comparison": compare persona cards (stored LLM output) side by side with charts and scores. **This is the primary "compare personas" feature.**
2. **`/agent-comparison`** — "Agent Comparison": upload raw transcripts to xAI Grok, then query Grok with arbitrary questions about the agents. A completely separate workflow.

---

## 1. Persona Comparison (`/comparison`)

### Purpose
Select 2+ persona cards from the database and compare them side by side. Shows a radar chart, bar chart, section score table, and full persona content columns. The **critical constraint**: personas are filtered so you can only compare personas created by the **same persona agent** (same prompt preset). This prevents meaningless comparisons between personas scored on different rubrics.

### Route
`ui/frontend/app/comparison/page.tsx` — rendered at `/comparison`

### API Endpoints Used
| Endpoint | Method | Purpose |
|---|---|---|
| `GET /api/personas` | GET | Fetch all personas |
| `GET /api/persona-agents` | GET | Fetch all persona agent presets (for sidebar filter) |

No write endpoints — this page is read-only.

### Data Model

**`Persona` interface** (from `ui/frontend/lib/types.ts`):
```typescript
interface Persona {
  id: string;
  type: "agent_overall" | "customer" | "pair";
  agent: string;
  customer?: string;
  label?: string;
  content_md: string;          // full markdown persona card
  prompt_used: string;
  model: string;
  temperature?: number;
  transcript_paths: string;
  script_path?: string;
  version: number;
  parent_id?: string;
  persona_agent_id?: string;   // KEY FIELD — which preset created this persona
  sections_json?: string;      // JSON-encoded section array (unused in comparison)
  score_json?: string;         // JSON-encoded score object (see Score Format below)
  created_at: string;
}
```

**Score JSON format** (stored in `persona.score_json`):
```json
{
  "_overall": 78,
  "_summary": "Strong sales approach, some compliance gaps",
  "_strengths": ["rapport building", "tonality"],
  "_weaknesses": ["disclosure timing"],
  "_assessment": "Overall solid performance...",
  "Sales Techniques & Tactics": { "score": 82, "reasoning": "..." },
  "Compliance & Risk": { "score": 61, "reasoning": "..." },
  "Communication Style & Tone": { "score": 85, "reasoning": "..." },
  "Customer Handling & Approach": { "score": 74, "reasoning": "..." }
}
```

Keys starting with `_` are metadata. All other keys are section scores where the value is `{ score: number, reasoning: string }`.

**PersonaAgent** (from `GET /api/persona-agents`):
```typescript
{
  id: string;
  name: string;                // used as persona_agent_id in personas
  persona_type?: string;       // "agent_overall" | "pair" | "customer"
  is_default?: boolean;
  sections?: unknown[];        // section definitions
}
```

---

### Layout

```
┌─────────────────────────────────────────────────────────────────┐
│ Persona Comparison                                               │
│ Select a persona agent → add personas to compare side by side    │
├──────────┬──────────────────────────────────────────────────────┤
│ PERSONA  │ ┌─ Picker panel ─────────────────────────────────────┐│
│ AGENTS   │ │ [chip] Ron Silver [1]  [chip] Dan Brooks [2]  [×]  ││
│ sidebar  │ │                                                     ││
│          │ │ [Search bar…]          [Browse ▼]                  ││
│ All      │ │                                                     ││
│          │ │ ┌── Browse dropdown (max-h-60, scrollable) ───────┐││
│ ★ Full   │ │ │  RON SILVER                                      │││
│   Persona│ │ │  [Pair] Ron Silver · Full Persona v2 · ...  +Add│││
│   Agent  │ │ │  [Pair] Ron Silver · Full Persona v1 · ...  +Add│││
│          │ │ │  DAN BROOKS                                      │││
│ Coaching │ │ │  [Agent] Dan Brooks · gpt-5.4 · ...         +Add│││
│ Preset   │ │ └──────────────────────────────────────────────────┘││
│          │ └─────────────────────────────────────────────────────┘│
│          │                                                         │
│          │ ┌─ Charts (2-col grid) ──────────────────────────────┐ │
│          │ │ Radar View          │  Bar View                    │ │
│          │ │ recharts Radar      │  recharts BarChart           │ │
│          │ └─────────────────────────────────────────────────────┘ │
│          │                                                         │
│          │ ┌─ Section Scores table ─────────────────────────────┐ │
│          │ │ Section    [1]  [2]                                 │ │
│          │ │ Sales       82   91                                 │ │
│          │ │ Compliance  61   88                                 │ │
│          │ │ Overall     78   90                                 │ │
│          │ └─────────────────────────────────────────────────────┘ │
│          │                                                         │
│          │ ┌─ Persona columns (n-col grid, 1 per persona) ──────┐ │
│          │ │  [PersonaColumn]  [PersonaColumn]  ...             │ │
│          │ └─────────────────────────────────────────────────────┘ │
└──────────┴─────────────────────────────────────────────────────────┘
```

---

### Same-Persona-Agent Constraint (Critical)

The sidebar shows all persona agent presets. When a user clicks a preset:
- `filterPersonaAgent` state is set to that preset's `name`
- The persona picker **only shows personas where `persona.persona_agent_id === filterPersonaAgent`**
- If "All" is selected (`filterPersonaAgent === null`), all personas are shown

This prevents comparing personas created by different presets (different scoring rubrics produce incomparable scores).

The empty state message explicitly says: `"Only compare personas created by the same preset"`

**Implementation**:
```typescript
const filteredByPersonaAgent = useMemo(() => {
  const all = personas ?? [];
  if (!filterPersonaAgent) return all;
  return all.filter(p => p.persona_agent_id === filterPersonaAgent);
}, [personas, filterPersonaAgent]);
```

---

### State

```typescript
const [slots, setSlots] = useState<string[]>([]);          // ordered persona IDs
const [search, setSearch] = useState("");
const [showPicker, setShowPicker] = useState(false);
const [filterPersonaAgent, setFilterPersonaAgent] = useState<string | null>(null);
```

`slots` is a list of persona IDs in order. Adding a persona appends to `slots`; removing filters it out by index.

---

### Persona Agent Sidebar

- Fixed width `w-44`, left panel
- Header: "PERSONA AGENTS" label
- "All" button at top: sets `filterPersonaAgent = null`, opens picker
- Per-preset buttons:
  - Shows preset `name` (truncated), `★` if `is_default`, type badge (Agent/Pair/Customer), count of personas with that `persona_agent_id`, and section count (`{n}§`)
  - Active state: `bg-indigo-600/20 border-indigo-500/30 text-white`
  - Inactive: `border-transparent text-gray-400 hover:bg-gray-800`
  - Clicking sets `filterPersonaAgent = pa.name` and `showPicker = true`

**Type colors**:
```typescript
const typeColor = pa.persona_type === "agent_overall" ? "text-violet-400"
                : pa.persona_type === "pair"           ? "text-indigo-400"
                : "text-emerald-400";  // customer
```

---

### Picker Panel

Appears in the main area above the charts. Contains:

1. **Selected persona chips** (if `slots.length > 0`): each chip shows:
   - Colored border (COLORS[i % 7])
   - `chartKey` label (e.g. `Ron S [1]`)
   - Agent name (bold)
   - Label (truncated, optional)
   - Model (first 2 segments, dimmed)
   - Overall score if `scoreMap[p.id]` exists (color-coded)
   - `×` remove button

2. **Empty state** (if `filterPersonaAgent === null && slots.length === 0`): "← Select a persona agent to browse"

3. **Browse UI** (when `showPicker = true`):
   - Search input + Browse toggle button
   - Scrollable list grouped by agent name
   - Each persona shows type badge, label/agent name, model, date, customer, version
   - `+ Add` on hover
   - Clicking calls `addSlot(p.id)`

4. **Single slot hint**: "Add at least one more persona to compare"

**chartKey** generation:
```typescript
function slotChartKey(p: Persona, idx: number): string {
  const base = p.label
    ? p.label.split("·")[0].trim().slice(0, 18)
    : p.agent.split(" ").slice(0, 2).join(" ");
  return `${base} [${idx + 1}]`;
}
```

---

### Score Extraction

`scoreMap` is built client-side from `persona.score_json` — no additional API call:

```typescript
const scoreMap = useMemo(() => {
  const map: Record<string, PersonaScores> = {};
  for (const p of selectedPersonas) {
    if (!p.score_json) continue;
    try {
      const raw = JSON.parse(p.score_json);
      const entry: PersonaScores = {
        _overall: raw._overall ?? 0,
        _summary: raw._summary ?? "",
      };
      for (const [k, v] of Object.entries(raw)) {
        if (k.startsWith("_")) continue;
        // Section scores are stored as { score, reasoning }
        if (typeof (v as any)?.score === "number") entry[k] = (v as any).score;
      }
      map[p.id] = entry;
    } catch {}
  }
  return map;
}, [selectedPersonas]);
```

`PersonaScores` interface:
```typescript
interface PersonaScores {
  _overall: number;
  _summary: string;
  [section: string]: number | string | null;  // section name → numeric score
}
```

---

### Section Short Labels

Section names are normalized to short labels for charts:
```typescript
const SECTION_SHORT_MAP: Record<string, string> = {
  "Sales Techniques & Tactics":        "Sales",
  "Sales Techniques & Approach":       "Sales",
  "Compliance & Risk":                 "Compliance",
  "Compliance & Risk Flags":           "Compliance",
  "Communication Style & Tone":        "Communication",
  "Communication Style & Rapport":     "Communication",
  "Customer Handling & Approach":      "Handling",
  "Customer Relationship Dynamics":    "Handling",
  "Key Patterns & Summary":            "Patterns",
  "Key Patterns & Tendencies":         "Patterns",
  "Strengths & Weaknesses Assessment": "Strengths",
  "Recommended Coaching Actions":      "Coaching",
  "Financial Overview & Goals":        "Financial",
  "Objections & Resistance Patterns":  "Objections",
  "Relationship Dynamics & Approach":  "Relationship",
  "Risk Assessment & Vulnerabilities": "Risk",
};

// Fallback for unknown section names
function sectionShortLabel(title: string): string {
  if (SECTION_SHORT_MAP[title]) return SECTION_SHORT_MAP[title];
  return title
    .replace(/^[\d]+\.\s+/, "")   // "1. Sales..." → "Sales..."
    .replace(/^[A-Z]+\.\s+/, "")  // "A. Relationship..." → "Relationship..."
    .replace(/\s*[&–]\s*.+$/, "") // "Sales & Tactics" → "Sales"
    .split(/\s+/).slice(0, 2).join(" ");
}
```

---

### Charts

Both charts only render if `selectedPersonas.length >= 2`.

**Data preparation**:
```typescript
const allSectionNames: [string, string][] = // [fullName, shortName]
const radarData = allSectionNames.map(([full, short]) => {
  const entry: Record<string, string | number> = { dim: short };
  selectedPersonas.forEach((p, i) => {
    entry[chartKeys[i]] = scoreMap[p.id]?.[full] ?? 0;
  });
  return entry;
});
const barData = allSectionNames.map(([full, short]) => {
  const entry = { name: short };
  // same structure but key is "name" not "dim"
  return entry;
});
```

**Colors** (7-color cycle):
```typescript
const COLORS = ["#6366f1", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4", "#f97316"];
```

**Radar chart** (`recharts`):
- `RadarChart` with `PolarGrid`, `PolarAngleAxis` (dataKey="dim"), and one `Radar` per persona
- Each Radar: `stroke=COLORS[i]`, `fill=COLORS[i]`, `fillOpacity=0.15`
- Height: 280px, `ResponsiveContainer width="100%"`

**Bar chart** (`recharts`):
- `BarChart` with `CartesianGrid`, `XAxis` (dataKey="name"), `YAxis` (domain [0,100])
- `Tooltip` dark styled
- One `Bar` per persona, each `fill=COLORS[i]`, `radius={[3,3,0,0]}`

---

### Section Scores Table (`ScoreTable` component)

Only renders when `allSections.length > 0` and `hasAnyScores = true`.

Structure:
- Header row: "Section" column + one column per persona (colored by COLORS[i])
- Body rows: one per section, each showing score per persona (color-coded by threshold)
- Footer: "Overall" row with bold scores

Score color function:
```typescript
function scoreColor(s: number) {
  if (s >= 75) return "text-emerald-400";
  if (s >= 50) return "text-amber-400";
  return "text-red-400";
}
```

Missing score shown as `—` (`text-gray-700`).

---

### Persona Column (`PersonaColumn` component)

Props: `{ persona, color, chartKey, scores? }`

Uses `parsePersonaSections(persona.content_md)` from `@/components/personas/PersonaSections` to extract sections from the markdown.

**Header** (left-border colored by persona's chart color):
- Agent name (bold, white)
- Label (optional, truncated)
- Type badge (violet=Agent, indigo=Pair, emerald=Customer)
- Model (`font-mono`, tiny)
- Customer name, version badge, date
- `chartKey` (monospace, in persona color)
- If scores exist: "Overall X/100" + mini progress bar in persona color
- If `scores._summary`: italic summary text

**Content** (scrollable):
- If no sections parsed: raw markdown via `ReactMarkdown`
- If sections: `SectionNav` (jump links) + `SectionCard` for each section
  - `SectionCard` receives `score` (numeric, from `sectionScores` map) to render a score bar

The `SectionCard` and `SectionNav` components live in `ui/frontend/components/personas/PersonaSections.tsx`. They handle category-based styling (Sales=amber, Compliance=red, Communication=blue, Customer=emerald, etc.).

---

### Type/Color Badges

```typescript
const TYPE_COLOR: Record<string, string> = {
  agent_overall: "text-violet-400 border-violet-500/30 bg-violet-500/10",
  pair:          "text-indigo-400 border-indigo-500/30 bg-indigo-500/10",
  customer:      "text-emerald-400 border-emerald-500/30 bg-emerald-500/10",
};
function typeLabel(t: string) {
  return t === "agent_overall" ? "Agent" : t === "pair" ? "Pair" : "Customer";
}
```

---

### Empty / Loading States

| Condition | State shown |
|---|---|
| `slots.length === 0` | BarChart3 icon + "Select a preset and agent, then add personas" + "Only compare personas created by the same preset" |
| `slots.length === 1` | BarChart3 icon centered + "Add one more persona to see the comparison" |
| `slots.length >= 2` | Full comparison (charts + table + columns) |
| No `personaAgents` | "Loading…" in sidebar |
| `personaAgents.length === 0` | "No agents yet" |

---

### Dependencies

- `recharts` — RadarChart, BarChart
- `react-markdown`, `remark-gfm` — not used directly in this page but in PersonaColumn
- `swr` — data fetching
- `@/components/personas/PersonaSections` — `SectionCard`, `SectionNav`, `parsePersonaSections`, `MD`

---

## 2. Agent Comparison (`/agent-comparison`)

This is a **separate** feature from persona comparison. It does not compare stored persona cards — it uploads raw call transcripts and landmarks to xAI Grok, then sends arbitrary queries.

### Route
`ui/frontend/app/agent-comparison/page.tsx` — rendered at `/agent-comparison`

### Overview

4-step workflow on a single page:
1. Select agents + customers (with data status indicators)
2. Quick Run (optional — transcribe + smooth + annotate landmarks)
3. Upload to Grok (uploads transcript + landmarks files to xAI Files API)
4. Query Grok (send system + user prompt, get Grok response)

### API Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `GET /api/agent-comparison/agents` | GET | List all agent folders |
| `GET /api/agent-comparison/customers?agent=X` | GET | List customers for agent |
| `GET /api/agent-comparison/agent-stats` | GET | Aggregate stats per agent |
| `GET /api/agent-comparison/customer-stats?agent=X` | GET | Per-customer stats |
| `GET /api/agent-comparison/status?agent=X&customer=Y` | GET | Call-level transcript/landmark counts |
| `POST /api/agent-comparison/prepare` | POST | Annotate missing landmarks (background task) |
| `POST /api/agent-comparison/quick-run` | POST | Run EL → smooth → landmarks for selected pairs |
| `GET /api/agent-comparison/quick-run/status?run_id=X` | GET | Poll quick run progress |
| `POST /api/agent-comparison/upload` | POST | Upload transcript+landmarks to xAI |
| `GET /api/agent-comparison/files` | GET | List uploaded xAI file IDs |
| `DELETE /api/agent-comparison/files?agent=X&customer=Y` | DELETE | Delete xAI files |
| `POST /api/agent-comparison/query` | POST | Query Grok with uploaded files |
| `POST /api/agent-comparison/reformat` | POST | Reformat Grok response as nice markdown |
| `GET /api/agent-comparison/presets` | GET | List saved query presets |
| `POST /api/agent-comparison/presets` | POST | Save a preset |
| `PATCH /api/agent-comparison/presets/{name}/default` | PATCH | Set default preset |
| `DELETE /api/agent-comparison/presets/{name}` | DELETE | Delete preset |

### Models

**Query models (GROK_MODELS)**:
```
grok-4.20-0309-reasoning       → "Grok 4.20 Reasoning"
grok-4.20-0309-non-reasoning   → "Grok 4.20 Fast"
grok-4-1-fast-reasoning        → "Grok 4.1 Fast Reasoning"
grok-4-1-fast-non-reasoning    → "Grok 4.1 Fastest"
```

**Smooth models (SMOOTH_MODELS)**:
```
gpt-5.4, gpt-4.1, claude-opus-4-6
```

**Landmark models (LANDMARK_MODELS)**:
```
grok-4.20-0309-non-reasoning, gpt-4.1, gpt-5.4
```

**Reformat models** (in response section):
```
gpt-4.1, gpt-5.4, claude-opus-4-6, grok-4.20-0309-non-reasoning
```

### Agent Slot Component

Two side-by-side `AgentSlot` panels (AGENT 1 and AGENT 2). Each:
- Agent `<select>` dropdown — sorted agents list (Grok-uploaded first, then with transcripts)
  - Options include stats: `{agent}  (N customers · T/C transcripts · L/C landmarks)`
  - Agents with any xAI upload show `✦ Grok` suffix
- Agent-level stats bar (StatPill components for transcripts and landmarks)
- Customer search input (filtered by `search` state)
- Customer list sorted by: both transcript+landmark → transcript only → nothing
- Per-customer row shows:
  - Checkbox + name
  - StatPill for transcripts and landmarks
  - "Annotate N missing" button (if transcripts > landmarks, triggers `/prepare`)
  - xAI file IDs if uploaded (green, `font-mono`)
  - "Upload to Grok" button (if selected and has transcripts, no file yet)
  - "Re-upload" link if already uploaded

`StatPill` colors: `text-emerald-400` (all done), `text-amber-400` (partial), `text-gray-600` (none)

### Auto-Selection
On mount (once, controlled by `autoSelected1/2.current` refs): auto-select all customers that already have uploaded Grok files for that agent.

### Quick Run (Step 2)

Collapsible section (shown when `selectedPairs.length > 0`).

Settings:
- Smooth model selector
- Landmarks model selector
- Landmarks extra prompt (optional free text)
- "Run landmarks" checkbox (default: true)
- "Force re-transcribe" checkbox (amber, reruns EL + smooth)
- "Force re-annotate" checkbox (amber, reruns landmark annotation)

Progress bar polls `/api/agent-comparison/quick-run/status?run_id=X` every 2500ms.

**Backend** (`POST /api/agent-comparison/quick-run`):
For each selected pair:
1. For each call: get S3 presigned URL → EL transcription → smooth → landmarks
2. Steps are skipped if output already exists (unless `force` flags set)
3. Returns `run_id` for polling

### Upload (Step 3)

**Backend** (`POST /api/agent-comparison/upload`):
1. Builds `merged_transcript.txt`: concatenates all `smoothed.txt` files with call headers (date, duration, net deposits if available)
2. Builds landmarks content: concatenates all `landmarks.json` files with call headers
3. Uploads each as a `.txt` file to `POST /v1/files` (xAI Files API, purpose=`assistants`)
4. Stores xAI file IDs in `comparison_file` SQLite table

File naming: `{safe_agent}__{safe_customer}__transcripts.txt` and `__landmarks.txt`

Caching: if file IDs already exist in DB and `force=False`, returns cached IDs.

`ComparisonFile` DB model (SQLModel):
```python
class ComparisonFile(SQLModel, table=True):
    id: str  # UUID
    agent: str
    customer: str
    file_type: str  # "transcript" | "landmarks"
    xai_file_id: str
    filename: str
    uploaded_at: str
```

### Query (Step 4)

**Backend** (`POST /api/agent-comparison/query`):
- Looks up all xAI file IDs for selected pairs
- Calls xAI `/v1/responses` endpoint (not `/v1/chat/completions` — file content is unsupported there)
- Payload structure:
  ```python
  payload = {
      "model": model,
      "input": [{"role": "user", "content": [
          {"type": "input_file", "file_id": fid},  # one per file
          {"type": "input_text", "text": user_prompt},
      ]}],
      "temperature": temperature,
      "instructions": system_prompt,  # only if non-empty
  }
  ```
- Response parsed from `data["output"][0]["content"][0]["text"]`

**IMPORTANT**: xAI file queries MUST use `/v1/responses`. The `/v1/chat/completions` endpoint returns `"File content is not supported on /v1/chat/completions. Please use /v1/responses instead."` error.

**Frontend error handling**: All API calls use text-first JSON parsing to handle plain-text error responses from Starlette's error middleware:
```typescript
const text = await r.text();
let data: any;
try { data = JSON.parse(text); } catch { data = { detail: text }; }
```

### Reformat

After getting a Grok response, "Nice View" button sends it to `/api/agent-comparison/reformat` which calls an LLM (default: `gpt-4.1`) to reformat it as clean GitHub-flavored Markdown.

Reformat system prompt instructs: preserve all information, use `##`/`###` headings, convert comparison data to markdown tables, bold key terms.

The response area shows:
- `displayResponse` (reformatted, if done) or raw Grok response
- "Raw" link to revert to original
- "Copy" button
- React-Markdown renderer with sortable tables (`SortableTable` component)

### Presets System

Query prompts can be saved as named presets (stored as JSON files in `ui/data/_comparison_presets/`).

Each preset stores:
```json
{
  "name": "Sales Comparison",
  "model": "grok-4.20-0309-reasoning",
  "system_prompt": "...",
  "user_prompt": "...",
  "temperature": 0.0,
  "is_default": false,
  "created_at": "..."
}
```

Only one preset can be default at a time. Default is shown with `★`. Applying a preset fills model, system prompt, user prompt, and temperature.

### Sortable Tables

`SortableTable` component wraps `recharts`-generated markdown tables. Clicking a column header sorts rows ascending/descending (numeric-aware: tries `parseFloat` first, falls back to `localeCompare`). Sort icons: `ArrowUpDown` (unsorted), `ArrowUp`/`ArrowDown` (sorted). Tables have sticky headers and alternating row backgrounds.

### Merged Transcript Format

```
════════════════════════════════════════════════════════════
MERGED TRANSCRIPTS
Agent:    Ron Silver
Customer: Chris Odendaal
Net Deposits: $304,123.00     ← only if available in DB
Calls:    42
Generated: 2026-04-13 10:22 UTC
════════════════════════════════════════════════════════════

────────────────────────────────────────────────────────────
CALL 113195  |  2025-08-11  |  7m27s
────────────────────────────────────────────────────────────
{smoothed.txt content}

────────────────────────────────────────────────────────────
CALL 114200  |  ...
────────────────────────────────────────────────────────────
...
```

Saved to `{agents_dir}/{agent}/{customer}/merged_transcript.txt` on disk.

---

## 3. Backend Router Registration

Both routers are in `ui/backend/main.py`:
```python
from ui.backend.routers.agent_comparison import router as agent_comparison_router
app.include_router(agent_comparison_router, prefix="/api")
```

The `/comparison` (Persona Comparison) page has **no dedicated backend router** — it uses only `GET /api/personas` and `GET /api/persona-agents` which are part of the personas and full_persona_agent routers.

---

## 4. Sidebar Navigation

In `ui/frontend/components/layout/AppSidebar.tsx`:
```typescript
{ href: "/comparison",      icon: BarChart3, label: "Compare Personas" },  // quick nav + ANALYSE section
{ href: "/agent-comparison", icon: Users,    label: "Agent Comparison" },  // quick nav + ANALYSE section
```

---

## 5. File Locations

```
ui/frontend/app/comparison/page.tsx          # Compare Personas page
ui/frontend/app/agent-comparison/page.tsx    # Agent Comparison page
ui/backend/routers/agent_comparison.py       # Agent Comparison API router
ui/backend/models/comparison_file.py         # ComparisonFile SQLModel
ui/frontend/components/personas/PersonaSections.tsx  # Shared section renderer
ui/frontend/lib/types.ts                     # Persona interface
```

---

## 6. Key Implementation Notes

1. **Same-persona-agent constraint is enforced in the frontend only** — filtering `personas` by `persona_agent_id`. There is no backend enforcement.

2. **Score data comes from `persona.score_json`** — no live LLM call on the comparison page. Scores were already computed and stored when the persona was created via Full Persona Agent.

3. **Chart data is 0 for sections where a persona has no score** — missing sections show `0` in charts.

4. **Persona columns render full markdown** using `parsePersonaSections` (parses `## Section Name` headings from `content_md`) and `SectionCard` with score overlays.

5. **The comparison supports 2+ personas** — grid layout adjusts dynamically: `gridTemplateColumns: repeat(N, 1fr)`.

6. **Agent comparison xAI files persist** across sessions in the SQLite DB. Uploading with `force=true` deletes the old xAI file first (via `DELETE /v1/files/{id}`), then re-uploads.

7. **`GROK_API_KEY` env var** (or `XAI_API_KEY`) required for agent comparison. Resolved via `shared/llm_client.resolve_grok_key()`.
