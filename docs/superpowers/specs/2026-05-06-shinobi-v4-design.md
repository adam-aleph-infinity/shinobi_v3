# Shinobi V4 — Design Spec

**Date:** 2026-05-06
**Status:** Approved for implementation planning
**New project — do not modify shinobi_v3 repo**

---

## 1. Product Vision

Shinobi V4 is a **generalizable sales intelligence and compliance platform** that connects to any CRM, ingests call recordings, runs configurable AI pipelines, and delivers structured intelligence back to managers — while sales agents remain entirely in their own CRM (Shinobi is invisible to them).

The current crypto/forex broker use case is a test deployment. The product is designed for any company with sales agents, phone calls, and a CRM.

### Core Design Principle
> The user shouldn't need to know what's possible with AI. Shinobi surfaces insights proactively — the system is the expert, not just a tool.

---

## 2. Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 15, React 19, shadcn/ui, Framer Motion, TanStack Query |
| API | Hono (TypeScript) + tRPC — end-to-end type safety |
| AI Worker | Python FastAPI microservice — transcription, LLM pipeline, audio analysis |
| Database | PostgreSQL (primary), Redis (queues, real-time pub/sub) |
| Auth | Role-based JWT — 4 roles (see below) |
| Deployment | Designed to support single-tenant and multi-tenant (decision deferred) |

**Performance targets:** Sub-second page loads, no loading spinners on navigation, smooth Framer Motion transitions throughout. Animation capability is a requirement, not an afterthought.

---

## 3. User Roles & Permissions

Four roles, strictly layered. Each lower role is a subset of the one above it.

| Role | Who | Access |
|---|---|---|
| **Shinobi Worker** | Shinobi employee — implementation/onboarding | Full access to everything, including system internals hidden from clients |
| **Floor Manager** | Client-side power user | Pipeline builder, compliance rules, milestone config, pipeline publish/rollback |
| **Sales Team Leader** | Client-side manager | Analytics, agent profiles, customer journeys, coaching, artifacts — read + export |
| **CRM Manager** | Client-side ops | Jobs, queue, webhook status, retry/replay — no analytics, no pipeline editing |

Role gating: the same 9-section nav is rendered for all roles; sections and actions are hidden/disabled based on role. The Shinobi Worker sees everything unlocked.

### Agent-Facing Output
Sales agents **never log into Shinobi**. All agent-facing content is delivered as CRM note API pushes:
- Pre-call briefing note → pushed before the call
- Post-call compliance note → pushed after pipeline run
- Coaching instructions → pushed as next-call action note

---

## 4. Visual Language

- **Default:** Dark Professional — deep dark backgrounds (#0a0a0f base), vivid accent colors, high-contrast data. Inspired by Vercel, Linear, trading terminals.
- **Light mode:** Full toggle — all components support both themes.
- **Typography:** Clean sans-serif (Inter or Geist), monospace accents for data/labels.
- **Animations:** Framer Motion throughout — page transitions, panel open/close, data loading states. Never janky, never blocking.
- **Design system:** shadcn/ui as the component foundation — all primitives consistent across every page.

---

## 5. Navigation

**Icon rail** — narrow (~56px), always visible. Each icon is the section entry point. Hover reveals a floating label. No text visible by default — maximum content space.

### 9 Sections (+ Floating Copilot)

| # | Section | Icon position | Role visibility |
|---|---|---|---|
| 1 | **Ops Console** | Top (home) | All roles |
| 2 | **Analytics** | Top | Shinobi Worker, Floor Manager, Sales Team Leader |
| 3 | **CRM** | Top | All roles |
| 4 | **Agents** | Middle | Shinobi Worker, Floor Manager, Sales Team Leader |
| 5 | **Customers** | Middle | Shinobi Worker, Floor Manager, Sales Team Leader |
| 6 | **Artifacts** | Middle | All roles |
| 7 | **Pipelines** | Middle | Shinobi Worker, Floor Manager |
| 8 | **Automations** | Middle | Shinobi Worker, Floor Manager |
| 9 | **Settings** | Bottom (always) | All roles (scoped per role) |
| — | **Copilot** | Floating dock panel | All roles |

User avatar at the very bottom of the rail. Settings icon pinned above avatar.

---

## 6. Page Designs

### 6.1 Ops Console (Home)

The first screen after login. Built for active monitoring.

**Layout:** Full-width, no sidebar panel.
- **Top bar:** System health indicators (API, webhooks, queue lag, ElevenLabs) — color-coded dots, last-checked timestamp
- **KPI strip:** Calls today, compliance rate, active jobs, alerts requiring action — 4 cards
- **Main split (2 columns):**
  - Left: Live jobs table — real-time, status chips (running/queued/failed), agent/customer/pipeline context per row, one-click retry/replay
  - Right: Review queue — AI outputs held for human approval, approve/reject with optional reason, confidence score badge
- **Bottom:** Run history (collapsed by default, expandable) — all completed runs filterable by date/pipeline/agent/status/batch, 24h throughput chart
- **Batch runs:** Jobs from a campaign or manual batch share a Batch label (e.g. `Campaign: Spring-2026`). Table filterable by batch. Batch-level actions: "Retry all failed in this batch." Batch record stored in DB with label, pipeline used, total/completed/failed counts, triggered-by. Per-job: click any row → opens run trace (Tier 2 log — full event timeline for that run).
- **Review queue** also surfaces voice fraud flags: when voice similarity analysis detects a potential duplicate identity across customers, a review item is auto-created with both customer records, similarity score, and audio comparison context.
- **Merged from V3:** `/live`, `/history`, `/ops`, `/review-queue`

### 6.2 Analytics

Performance intelligence for managers.

**Layout:** Dashboard grid, no drill-in panels on this page.
- KPI cards: compliance rate, conversion rate, avg call score, top/bottom agent delta
- Compliance trend chart (30/60/90 day, per-pipeline breakdown)
- Agent leaderboard: ranked list with score bars, trend arrows, violation count
- Pipeline performance: runs per pipeline, avg score, failure rate
- Floor summary: all agents at a glance — one row per agent, score, rank, trend, last active
- **Merged from V3:** `/agent-dashboard`

### 6.3 CRM Browser

Direct port of the V3 CRM browser with UI refresh.

**Layout:** Filter sidebar (left) + data table (right).
- Browse and search agent–customer pairs
- Per-pair: call count, last sync, health status
- Drill into a pair: all call records, dates, duration, transcription status
- Manual sync trigger (per-pair or global)
- Filter by CRM source (brtcrm, mlbcrm, sfxcrm, etc.)
- **Filter by campaign** — campaign is a first-class filter dimension. Call disposition stats (answered/hung up/no answer) visible immediately from CRM data, no pipeline required.
- **Batch run trigger** — checkbox-select calls (or "select all answered in this campaign") → "Run Pipeline" button → pick pipeline → confirm. Each call spawns one job in the Ops Console jobs table.
- **Kept from V3:** `/crm` — same functionality, redesigned UI

### 6.4 Agents

Three sub-views accessible from a tab bar within the section.

#### 6.4a Agent List
- Ranked table: rank, name, compliance score bar, conversion %, call count, trend arrow, persona tag
- Click any row → Agent Profile

#### 6.4b Agent Profile
**Layout:** Sticky left column + scrollable right content.
- **Left column (fixed):** Avatar, name, rank badge, all score bars (compliance, conversion, tone/voice), persona type label + tags, client assignment
- **Right (scrolling sections):**
  1. Coaching Priority — AI-generated, specific and grounded, with "Assign coaching task" CTA
  2. Compliance violations — top violations by frequency, each with call count
  3. Recent calls — last 10 rows: customer, duration, score, date, status
  4. Voice & tone analysis — energy level, pacing, empathy score, trend
  5. Persona detail — full agent persona card with section breakdown

#### 6.4c Agent Deep Dive
Carried from V3 with UI revision.
- CRM browser in artifact mode: navigate agent → customer → call
- Cross-tab all pipeline artifacts: per call, see every output (note, persona, score) grouped by pipeline
- Compare artifacts across calls for the same customer
- Export/share individual artifacts

#### 6.4d Agent Comparison (revised)
Replaces both V3 `/agent-comparison` and `/comparison`.
- Select 2–4 agents
- Side-by-side: scores, persona types, top violations, voice analysis, conversion rates
- LLM-powered narrative comparison (revised from V3's Grok-based approach)

### 6.5 Customers

#### 6.5a Customer List
- Table: name, assigned agent, milestone stage, compliance risk flag, last call date, journey progress bar
- Click any row → Customer Journey

#### 6.5c Voice Identity (fraud detection)
- **Voice Identity card** on each customer profile: fingerprint status (analyzed / not analyzed), and if a cross-customer match exists — "Voice match: 91% similarity to [Customer: Jane Smith] across 3 calls" with links to both profiles.
- Match detected → auto-flagged to Review Queue in Ops Console for human decision. Approve → creates a "Duplicate Identity Alert" artifact with full audit trail. Reject → clears flag with reason.
- Voice characteristics shown: speaker embedding status, cadence profile, vocabulary pattern tag, pitch range.

#### 6.5b Customer Journey
**Layout:** Vertical timeline (left) + detail panel (right).
- **Left:** Vertical milestone timeline — each milestone is a dot with label and date
  - Completed milestones: filled purple dot
  - Pending next milestone: amber pulsing dot
  - Future milestones: empty dot
  - Milestones are user-defined (Floor Manager sets them) + AI-auto-detected
- **Right:** Click any milestone or call to see:
  - Call compliance results (COMPLIANT/VIOLATION per procedure)
  - Next-call actions generated
  - Customer sentiment at that point
  - Transcript snippet
- Customer persona card accessible via header button

### 6.6 Artifacts

Unified content browser — replaces `/calls`, `/notes`, `/personas`, `/full-persona-agent`.

**Layout:** Three-column — agent list (far left, narrow) → customer list (middle-left) → call list (middle) → call detail (right, expandable).

Navigation: select agent → select customer → select call → see all artifacts for that call.

**Per-call detail panel:**
- Transcript viewer with speaker labels, search, timestamp navigation
- Audio player (if available)
- All AI pipeline outputs grouped by pipeline:
  - Each pipeline section: pipeline name + run status + all artifacts it produced
  - Artifacts: compliance note, persona card, compliance score + violation list, next-call actions
- Manual re-run button per pipeline
- Full Persona Agent accessible as an action button → opens as a panel (not a separate page)
- Persona list: all personas for this customer accessible inline

### 6.7 Pipelines

Canvas-based pipeline builder.

**Layout:** Node palette (left, ~90px) + canvas (center, ReactFlow) + node config (right, ~130px) + bottom drawer (run output + artifacts).

- **Node palette:** Draggable node types — Input (webhook/CRM), Agent (LLM step), Note, Persona, Score, Condition/Branch, Output (CRM push), **Voice Analysis** (speaker embedding, cross-customer match)
- **Canvas:** ReactFlow. Nodes connect via edges. Pipelines are not complex (5–10 nodes typical). Agent nodes with an active repair pass show a visual sub-badge on the canvas.
- **Node config (right panel):** Appears when a node is selected — model selector, system/user prompt editor, temperature, output format, **Output Contract** section (schema definition, canonical taxonomy list, fit threshold, repair pass toggle + repair prompt editor).
- **Output Contracts:** Each Agent node validates its output against a defined schema after the LLM call. If fit score is below threshold and repair pass is enabled, a second focused LLM call fires to restructure the output to match the taxonomy. Both the main prompt and repair prompt are visible and editable by the Floor Manager. All repair pass calls appear in the run trace (Tier 2 log). Prevents taxonomy drift between runs, enabling reliable downstream aggregation.
- **Test Run flow:** Clicking "Test Run" opens the **EntityPicker** in the right-side panel — a full inline CRM browser (sortable/filterable by earnings, campaign, etc.) without leaving the pipeline page. Select agent → customer → call → confirm → run. No iframe, no page navigation. Results appear in bottom drawer.
- **Bottom drawer:** Snaps open after a test run — shows all output artifacts as clickable chips (note, persona, score, voice analysis), expandable to full output. Repair pass results visible per step.
- **Top bar:** Pipeline name + draft/published badge + Undo + Test Run + Publish buttons
- **Pipeline list:** All pipelines with version status, last published, last run stats
- **Version control:** Draft → Publish → Rollback. Immutable published snapshots. Change notes on publish.

### 6.8 Automations (revised)

Upgraded from V3's cron-only scheduler.

**Layout:** Two-panel — automation list (left) + detail/config (right).

- List: name, schedule, enabled toggle, last run status, next run time
- Detail: schedule editor, action config, run history for this automation
- **New:** Auto CRM sync rules — define sync schedule per CRM source
- **New:** Event → action triggers (webhook received → run pipeline, call ended → transcribe)
- Safety limits: max runs/hour, kill switch per automation
- Dry-run simulation button
- **Revised from V3:** `/automations`

### 6.9 Settings

Admin hub. Tabbed internally.

**Tabs:**
1. **Users & Privileges** — invite users, assign roles, deactivate accounts
2. **System Config** — concurrent jobs limit, concurrent transcription limit, VM size / parallel CPUs config
3. **Logs** — three-tier log viewer:
   - **Tier 1 (Operational):** Structured events — pipeline steps, LLM call token counts, transcription durations, CRM push results, artifact saves. No payload content. Filterable by category, level, component, date range, free text. Real-time SSE streaming.
   - **Tier 2 (Run Trace):** Per-run event timeline — accessible from Ops Console (click any job) or inline here filtered by run ID. Every event typed with fields: step index, model, token counts, fit score, repair pass triggered/result.
   - **Tier 3 (Payload Archive):** Full LLM prompts + responses + raw transcripts, stored as files by `run_id + step_index`. Accessible on drill-in from Artifacts ("View LLM I/O" per step) or run trace ("Show payload"). Never shown in bulk log views.
   Carried from V3 `/logs` — same real-time streaming, vastly extended structure.
4. **Workspace** — file/data browser for raw agent/customer/call directory structure. Carried from V3 `/workspace`.
5. **Tools** — CRM connection management, API keys, webhook endpoints, other integrations
6. **Profile** — user profile, password, notification preferences

### Floating Copilot

Context-aware AI assistant panel docked to the icon rail. Toggle show/hide. Knows which page and entity you're viewing. Can answer questions about runs, agents, pipelines, call content. Not a separate page — always available.

---

## 7. Key Features & Differentiators

### 7.1 Customer Journey + Milestone Tracking
- User-defined milestone types (Floor Manager creates: "FTD", "Wallet Created", "KYC Complete", etc.)
- AI auto-detection: pipeline can emit milestone events automatically when it detects qualifying content
- Per-customer timeline with exact call + date for each milestone
- Fleet view: how many customers at each stage across all agents

### 7.2 Voice & Tone Analysis
- Agent-side: energy level, pacing, confidence, empathy markers
- Customer-side: emotional state detection (worried, resistant, trusting, engaged)
- Trend over calls: is the customer becoming more or less trusting?
- **Note:** Built on improved transcription pipeline (to be re-integrated — previously built, shelved for speed)

### 7.3 Configurable Pipeline Canvas
- Floor Manager defines their own compliance rules, scoring criteria, output templates
- No code required — visual drag-and-drop
- Multi-LLM: OpenAI, Anthropic, Gemini, xAI/Grok selectable per node
- Draft/publish lifecycle prevents accidental live changes

### 7.4 Pre-Call Intelligence Briefing
- Before each call, Shinobi pushes a structured CRM note to the agent's CRM record
- Contains: customer journey stage, pending milestones, last call summary, compliance checklist for this stage, persona summary, what tone/approach worked last time
- Agent sees it in their CRM — Shinobi is invisible to them

### 7.5 Dual Personas
- **Agent personas:** Behavioral fingerprint — style, tone, technique, typical strengths and gaps. Named archetypes (e.g., "The Closer", "The Nurturer").
- **Customer personas:** What approach works for this type of client — trust drivers, objection patterns, risk tolerance.
- Cross-reference: "agent type X works best with customer type Y" — surfaced proactively in coaching.

### 7.6 Context & EntityPicker
- **Scope pill:** Selecting any agent/customer/call anywhere in the app sets a scope pill (top-right). Scope passively pre-filters all sections — navigate to Customers and it's already scoped to this agent's customers. Clear with ×.
- **URL-driven context:** Context encoded in URL params — bookmarkable, shareable, no stale localStorage state across sessions.
- **EntityPicker component:** Reusable inline CRM browser (React component, not iframe). Summoned as a slide-over panel from any surface that needs to pick a CRM entity — pipeline test run, scope pill quick-switch, batch trigger. Single two-step flow: agent/customer/call column navigation with full sort/filter.
- **Command palette (Cmd+K):** Global search across all agents, customers, calls. Sets context directly.

### 7.7 Output Contracts & Taxonomy Enforcement
- Each Agent node defines an output schema + canonical taxonomy list. Output is validated post-generation, not just guided via prompt.
- Repair pass: optional second LLM call to restructure drifted output back to taxonomy. Visible in canvas (sub-badge on node) and in run trace.
- Taxonomy lock: novel labels auto-remapped to nearest canonical label via embedding similarity, or flagged to review queue.
- Prevents silent aggregation failures when downstream pipelines count or group by label.

### 7.8 Voice Fraud Detection
- **Speaker fingerprinting:** Python AI worker computes voice embeddings per customer per call using acoustic features (spectral profile, cadence, pitch, vocabulary patterns).
- **Cross-customer matching:** Cosine similarity comparison across the customer database. Matches above threshold auto-flagged to the Review Queue.
- **Review Queue integration:** Reviewer sees both customer profiles, similarity score, triggering calls, audio comparison context. Approve → Duplicate Identity Alert artifact with audit trail. Reject → clears flag with reason.
- **Campaign-level fraud risk:** Analytics surfaces duplicate identity count per campaign, trend over time.
- **Pipeline node:** `Voice Analysis` node available in the node palette — Floor Manager can include it in any pipeline.

### 7.9 Review Queue (Confidence Gate)
- AI outputs with low confidence scores or high-risk flags are held before CRM push
- Human reviewer approves/rejects with optional reason
- Full audit trail: who reviewed, when, what decision, what outcome
- Compliance documentation artifact — the review log is a regulatory record

---

## 8. Data Flow

```
CRM webhook → call ended
  → AI Worker: transcription (ElevenLabs Scribe v2)
    → AI Worker: pipeline execution
        → Node 1: conversation analysis
        → Node 2: compliance scoring
        → Node 3: persona update
        → Node 4: next-call actions
        → [voice/tone analysis if enabled]
      → confidence check → review queue (if low confidence)
      → CRM push: compliance note + pre-call briefing for next call
        → milestone detection → journey update
          → analytics update
```

---

## 9. V3 → V4 Feature Mapping

| V3 Page | V4 Destination |
|---|---|
| `/live` | Ops Console (merged) |
| `/history` | Ops Console (merged) |
| `/ops` | Ops Console (merged) |
| `/review-queue` | Ops Console (merged) |
| `/agent-dashboard` | Analytics (merged) |
| `/crm` | CRM (kept, UI refreshed) |
| `/agent-deep-dive` | Agents → Deep Dive sub-view (kept, revised) |
| `/agent-comparison` + `/comparison` | Agents → Comparison sub-view (revised, merged) |
| `/calls` + `/notes` + `/personas` + `/full-persona-agent` | Artifacts (merged, revised) |
| `/canvas` | Pipelines (continued, same ReactFlow foundation) |
| `/pipeline` | Replaced by Pipelines canvas |
| `/automations` | Automations (revised) |
| `/workspace` | Settings → Workspace tab |
| `/logs` | Settings → Logs tab |
| `/user` | Settings → Profile tab |
| `/settings` | Settings (expanded) |
| `/copilot` | Floating Copilot dock panel |
| `/agents`, `/artifacts` | Removed (were already placeholders) |
| `/populate` | Removed (was a redirect) |

---

## 10. Out of Scope for V4 Initial Build

- Multi-tenant billing/provisioning (architecture supports it, not built yet)
- Mobile app or responsive mobile layout
- Real-time voice analysis during live calls (post-call analysis only in V4)
- Advanced voice transcription pipeline (previously built, to be re-integrated in a later phase)
- External webhook delivery to third-party systems beyond CRM

---

## 11. Build Sequence

Start with the superadmin (Shinobi Worker) full-access interface. Then progressively restrict features per role using the permission layer.

Suggested order:
1. Project scaffold — Next.js 15 + Hono + tRPC + shadcn/ui + design tokens
2. Auth — role-based JWT, session management
3. Icon rail navigation + layout shell
4. Ops Console (highest operational value, proves the real-time infrastructure)
5. CRM section (direct port, proves CRM integration works)
6. Pipelines canvas (core differentiator, builds on existing ReactFlow work)
7. Artifacts section (unified content browser)
8. Agents section (profile + deep dive + comparison)
9. Customers section (journey + milestones)
10. Analytics
11. Automations
12. Settings
13. Copilot integration
14. Role gating (disable features per role)
15. Light mode theme
