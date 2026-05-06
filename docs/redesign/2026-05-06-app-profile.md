# Shinobi V3 — App Profile

_Created: 2026-05-06. Living document — updated as we learn more._

---

## What It Is

Shinobi is a **generalizable sales intelligence and compliance platform** that connects to any CRM, ingests call recordings, and gives managers full AI-powered visibility into every sales conversation. The crypto broker use case is the current test/playground — the real product is designed for any company with sales agents making calls.

---

## The Problem It Solves

Sales teams make hundreds of calls. Managers can't listen to all of them. Key questions go unanswered:

- Are agents following company protocol and script?
- Is each customer feeling safe, honest, and engaged — or being put off?
- Which agents are performing well and why? What specifically makes them effective?
- Which agents need coaching, and on what exactly?
- Is the sales process working, or is there systematic friction somewhere?

Shinobi automates all of this — every call analyzed, scored, and turned into actionable intelligence.

---

## Core Data Flow

```
CRM (brtcrm.io / mlbcrm.io / sfxcrm.io)
  → webhook: call ended
    → Shinobi ingests recording URL
      → ElevenLabs Scribe v2 transcribes
        → AI pipeline (3 stages):
            Stage 1: Business context + compliance rules
            Stage 2: Conversation analysis (what happened)
            Stage 3: Scoring + violation detection + next-call actions
              → Output: compliance note, persona profile, COMPLIANT/VIOLATION flags
                → Push back to CRM
```

---

## Core Design Principle

**"The customer is smart enough to buy the system, but shouldn't need to know what's possible with AI."**

Shinobi must be proactively intelligent — surfacing insights, flagging things, suggesting actions even when the user didn't know to ask for them. The system should feel like it has a senior analyst working in the background on every call.

---

## Differentiators (the edge competitors don't have)

1. **Customer Journey + Milestone Tracking** — user-defined milestones (FTD, wallet open, verification complete, etc.) tracked per call and over time, PLUS AI auto-detection of milestone events even if not explicitly defined. Full timeline of when each client hit each stage.

2. **Voice & Tone Analysis** — agent voice analysis (tone, pacing, energy, confidence) AND customer emotional state detection (worried, resistant, engaged, trusting). Not just transcript sentiment — actual audio signal.

3. **Configurable Pipeline Canvas** — any company defines their own compliance rules, scoring criteria, output format. Not a fixed framework. Multi-LLM.

4. **Pre-Call Intelligence Briefing** — before the agent picks up, they see: what to accomplish this call, compliance reminders (don't forget secret code), customer persona summary, where the customer is in their journey, last call context. The agent walks in prepared.

5. **Dual Personas** — sales agent personas (style, tone, technique fingerprint) AND customer personas (what approach works for this type of client). Cross-reference to surface: "agent X with persona style Y works best for customer type Z."

---

## Use Cases

### 1. Protocol & Policy Compliance
Every call is scored against the company's defined procedures — automatically, at scale. Violations are flagged per-call with exact descriptions. Managers get a record of what was done, what was missed. The compliance rules are configurable per company/use-case.

### 2. Customer Sentiment & Trust Analysis
Understand the customer side of the call — are they feeling safe? Honest? Engaged? Resistant? Detect friction points, emotional signals, and trust indicators. Flag calls where the customer felt pressured or confused.

### 3. Agent Ranking & Performance Analytics
Every agent gets a score. Rankings surface top and bottom performers. Identify what the best agents do differently — tone, pacing, objection handling, rapport-building, procedure adherence.

### 4. Coaching Intelligence
Specific, actionable coaching instructions generated per call. Not generic ("be more empathetic") but grounded in what actually happened ("you skipped the trust-building step after the customer expressed hesitation at 4:20"). Coaching plans derived from best-agent patterns.

### 5. Persona Profiling
Client personas built from call history — psychological profile, risk tolerance, trust level, objection patterns. Informs agent strategy for next interaction.

### 6. CRM Note Generation
Structured, consistent notes pushed to CRM per call. Replaces ad-hoc agent self-reporting. Every note anchored to call_id + customer + agent + run context.

### 7. Live Pipeline Monitoring
Real-time visibility into what jobs are running, queued, succeeded, failed. Operators can retry, inspect, and replay.

### 8. Configurable AI Pipeline Canvas
Visual canvas for building the analysis pipeline. Any company defines their own compliance rules, scoring criteria, and output format — without touching code. Multi-LLM support (OpenAI, Anthropic, Gemini, Grok).

### 9. Pre-Call Intelligence Briefing
Before each call, the agent receives a prepared briefing card: where this customer is in their journey, what milestones are pending, last call summary, compliance checklist for this call stage, what objections to expect based on customer persona, and what tone/approach worked last time.

### 10. Customer Journey Tracking
Every customer has a timeline — which call triggered which milestone, how long between stages, where they are now. Milestones are user-defined (FTD, wallet open, KYC complete, etc.) but also AI-auto-detected from call content. Managers see a fleet-level view: how many customers are at each stage.

### 11. Voice & Tone Intelligence (roadmap)
Audio signal analysis beyond transcription — detect agent energy, pacing, confidence, empathy. Detect customer emotional states: worried, resistant, trusting, hesitant. Flag calls where the customer's state degraded. Previously built, shelved for speed — will be re-integrated.

---

## User Roles (4 Types)

### 1. Sales Team Leader
Manages a team of sales agents. Needs a bird's-eye view of performance and customer progress.
- Dashboard: all agents ranked, scored, trending
- Per-agent drill-down: persona, call history, coaching queue, compliance score trend
- Customer journey view: which customers are at which milestone, who's stalling, who's progressing
- Call-level detail: what happened, what went wrong, what to coach on

### 2. Floor Manager (Pipeline Builder)
Configures what the system produces. This is the product designer role within each client organization.
- Builds and publishes AI pipelines (what gets analyzed, how, with which LLMs)
- Defines compliance rules, scoring criteria, note templates
- Defines milestone types for customer journey tracking
- Manages pipeline versions (draft → test → production)
- No need to write code — visual canvas is their tool

### 3. Shinobi Worker (Internal Superadmin — Shinobi employee)
A Shinobi-side implementation employee who onboards and configures each client. Has full system access including features that are hidden/disabled for client users.
- Full access to pipeline builder, workflow editor, all system internals
- Can generate pipelines and workflows on behalf of a client
- Features locked for clients (for safety) are accessible to this role
- Bridges client needs to system capabilities
- Not a role the client ever sees or controls

### 4. CRM Manager (Ops)
Technical/ops role — keeps the jobs running.
- Views all active/queued/failed jobs
- Deploys new pipeline jobs, reruns failures
- Monitors webhook health, queue lag, SLA
- No pipeline design — purely operational

---

## Current Stack

| Layer | Tech |
|---|---|
| Backend | FastAPI + SQLModel (Python) |
| Frontend | Next.js 14 App Router + Tailwind + SWR + Radix UI |
| DB (local) | SQLite |
| DB (prod) | PostgreSQL |
| Transcription | ElevenLabs Scribe v2 |
| LLMs | OpenAI (primary), Anthropic, Gemini, xAI/Grok |
| Pipeline canvas | @xyflow/react (ReactFlow) |
| Infra | GCP e2-standard-4, Nginx, systemd |
| CRM integrations | brtcrm.io, mlbcrm.io, sfxcrm.io |

---

## Current Pain Points (from codebase analysis)

1. **Monolithic backend** — `pipelines.py` is 9,300 lines; everything lives in one file
2. **Fragmented observability** — run status split across Live, Pipeline, and Dashboard pages
3. **No confidence gate** — AI output goes straight to CRM with no human approval step for risky cases
4. **No pipeline release lifecycle** — no draft/publish/rollback; edits go live immediately
5. **Automation UX is technical** — cron-based, not accessible to non-developer managers
6. **No team views** — no shared saved filters, watchlists, or manager collaboration flows

---

## UI Decisions

| Element | Decision |
|---|---|
| Visual direction | Dark Professional, light mode toggle |
| Navigation | Icon rail — hover for labels, all sections always accessible |
| Home screen | Operations console (system health, live jobs, review queue) |
| Nav sections | **Ops Console** · **Analytics** · **CRM** · **Agents** · **Customers** · **Artifacts** · **Pipelines** · **Automations** · **Settings** + floating Copilot |
| Merges | Live+History+Ops+ReviewQueue → Ops Console · AgentDashboard → Analytics · Calls+Notes+Personas+FullPersonaAgent → Artifacts · Workspace+Logs+User → Settings |
| Clients section | Removed as top-level — client management lives in Settings (superadmin) |
| Pipeline canvas | Node palette left + canvas center + node config right + **bottom drawer** for run output and artifacts |
| Customer journey | Vertical milestone timeline (left) + detail panel (right) — click any milestone/call |
| Agent profile | Sticky left column (identity, all scores, persona) + scrollable right (coaching, calls, violations, voice) |

---

## Navigation & Dashboard Decisions

- **Navigation:** Icon rail (minimal, hover for labels)
- **Home screen:** Operations console — system health, live jobs, review queue
- **All views available in sidebar:** Analytics, Clients, Jobs, Pipeline Builder, Settings — all accessible as top-level icon rail sections
- **Role visibility:** Other roles see the same rail with irrelevant sections hidden

---

## Goals of the Redesign

1. **Simpler** — fewer concepts, clearer flows, nothing that requires explanation
2. **Consistent** — one design language across all pages, shared components, no "this page looks different from that one"
3. **Robust** — changes to one part don't break another; decoupled frontend + backend
4. **Flexible** — easy to extend without regression; the canvas is the future for power users
5. **Proactively intelligent** — system surfaces insights without being asked
6. **Role-appropriate** — each of the 4 user types sees exactly what they need, nothing more

**Root cause of current state:** Patch-on-patches over multiple iterations. No consistent design system. Tight coupling between features. Result: every change risks a regression, and the app feels inconsistent across views.

---

## Agent-Facing Output Model

Sales agents **do not log into Shinobi**. Everything agent-facing is delivered via CRM note API push:
- Pre-call briefing → pushed as a note before the call
- Post-call compliance note → pushed after pipeline run
- Coaching instructions → pushed as next-call note

The CRM is the agent's interface. Shinobi is invisible to them.

---

## Tech Decision — Option B: Next.js 15 + Hono + Python AI Worker

**New project. Do not modify the current shinobi_v3 repo.**

| Layer | Tech |
|---|---|
| Frontend | Next.js 15, React 19, shadcn/ui, Framer Motion, TanStack Query — **dark mode default, light mode toggle** — **icon rail navigation** |
| API | Hono (TypeScript), tRPC for type-safe frontend↔API |
| AI Worker | Python FastAPI microservice (transcription, LLM pipeline, audio analysis) |
| DB | PostgreSQL (primary), Redis for queues/real-time |
| Auth | Role-based: Shinobi Worker (superadmin) > Floor Manager > Sales Team Leader = CRM Manager |
| Deployment | TBD — design to support single-tenant and multi-tenant |

**Build sequence:** Superadmin (Shinobi Worker) full-access interface first. Then progressively disable/hide features per role.

## Context & Navigation Model

### Global Scope Pill (Entity Context)
No persistent context bar by default. When a user selects an agent, customer, or call anywhere in the app, a scope pill appears in the top-right: `Agent: John Smith × | Customer: Acme Corp ×`. This scope passively carries across sections — Customers section pre-filters to this agent's customers, Artifacts section jumps to this agent/customer, etc. Clear by clicking ×.

**Context as actions:** The scope pill is also a command hub — "Run Pipeline", "View in Artifacts", "View Journey" are one click away from wherever context is set, without forcing a section switch.

**URL-driven:** Context is encoded in the URL (`?agent=john-smith&customer=acme`), not just localStorage — bookmarkable, shareable, no stale state across sessions.

**Command palette (Cmd+K):** Global search across agents, customers, calls. Sets context directly without navigating section-by-section.

### EntityPicker Component (Inline CRM Browser)
A reusable React component (not an iframe) that can be summoned as a slide-over panel from any surface that needs to select a CRM entity — pipeline test run, scope pill quick-switch, batch run trigger. Two-step flow: agent list (sortable/filterable) → customer list → call list, all in one panel. No navigation away from the current page.

The Pipeline page "Test Run" button opens the EntityPicker in the right-side panel (same column as node config). Canvas stays visible behind it. Select target → confirm → run → results appear in bottom drawer.

---

## Campaign & Batch Runs

### Campaign as a Filter Dimension
Campaign is a first-class filter in the CRM section — managers can filter calls by campaign, see disposition stats (answered/hung up/no answer) without any AI pipeline. A campaign with 60% hang-ups is visible immediately from CRM data alone.

### Batch Run Trigger
From the CRM section: checkbox-select calls (or "select all answered in this campaign") → "Run Pipeline" button → pick pipeline from dropdown → confirm. Each call spawns one individual pipeline run.

### Jobs Table (Ops Console)
Batch runs land in the Ops Console jobs table as individual job rows, all tagged with a shared Batch label (e.g. `Campaign: Spring-2026`). Managers filter the jobs table by batch to see all runs from that campaign. Batch-level actions: "Retry all failed in this batch" — same pattern as the existing failed-state retry system.

**Batch record in DB:** Unlike V3 (where batches are display-time groupings only), V4 stores an explicit batch record with: batch ID, label, pipeline used, total count, completed/failed counts, triggered by. This enables filtering, sharing, and audit trail.

---

## Three-Tier Logging Model

### Tier 1 — Operational Logs (main log viewer)
Clean, structured, fast to scan. No payload content. Lives in Settings → Logs tab. Filterable by category (pipeline, llm, transcription, crm, webhook, system, http, auth), level, component, date range, free text. Real-time SSE streaming for live view.

```
[TRANSCRIPTION] Started · call abc123 · ElevenLabs Scribe v2
[TRANSCRIPTION] ✓ Done · 847 words · 2.3s · call abc123
[PIPELINE] ▶ Step 2/3: compliance-agent [gpt-4o]
[PIPELINE] ✓ Step 2/3 → done · 1800 tokens in · 620 out · 1.8s
[ARTIFACT] ✓ Saved: compliance-note · run abc · call abc123
[CRM-PUSH] ✓ Note sent · call abc123
```

### Tier 2 — Run Trace (per pipeline run)
Structured event timeline for each run. Every event typed with fields, not just text lines. Accessible from Ops Console: click any job → see its full trace. Covers: run started, transcript requested/returned (duration + word count, not full text), each step start/complete, LLM call token counts, repair pass triggered/result, artifact saved, CRM push sent.

### Tier 3 — Payload Archive (stored separately, accessible on drill-in)
Full text of: transcripts received from ElevenLabs, LLM system+user prompts, LLM responses. Stored as files referenced by `run_id + step_index`. Never shown in the main log viewer or run trace by default. Accessible via:
- Artifacts section → per-call detail → "View LLM I/O" per step
- Run trace → click any LLM or transcription step → "Show payload"

This keeps compliance audit trails complete without polluting operational views with 40,000-word transcripts.

---

## Output Contracts & Taxonomy Enforcement

### The Problem
LLM agents can produce slight taxonomy drift between runs — "Missing disclosure" vs "Undisclosed conflict of interest" vs "Disclosure not provided". Downstream aggregation pipelines that count violations by type break silently when labels vary.

### V4 Solution: Output Contracts with Real Validation + Repair Pass

**1. Schema validation after every step**
Each Agent node defines an output schema (required keys, structure) and an optional canonical taxonomy (fixed list of allowed labels). After the LLM call, output is validated: fit score computed (schema marker coverage + taxonomy label match). Result logged in Tier 1. Does not rely on LLM compliance with prompt guidance alone.

**2. Repair pass (optional per node, fully visible)**
Each Agent node has an optional "Repair pass" toggle in the node config panel. When enabled and fit score is below threshold: a second focused LLM call fires with a repair prompt — *"Rewrite this output to strictly match this taxonomy and schema. Do not change meaning, only structure."* The repair prompt is visible and editable by the Floor Manager. The repair call appears explicitly in the run trace:
```
[STEP 2] Main call → fit score 67% (below 80% threshold)
[STEP 2] Repair pass → gpt-4o-mini → fit score 94% ✓
[STEP 2] Output accepted
```
In the pipeline canvas, nodes with an active repair pass show a visual sub-badge. Full prompts + responses for both calls stored in Tier 3 payload archive.

**3. Taxonomy lock**
The node config lets the Floor Manager define a canonical taxonomy list. If a novel label appears in the output, it is either auto-remapped to the nearest canonical label (embedding similarity) or flagged to the review queue if confidence is low. Guarantees that downstream aggregation always sees consistent labels.

**Visibility principle:** No LLM operation in V4 is hidden from the manager. Every smoothing step, repair pass, and format transform is surfaced in the run trace and node config — not buried in backend-only logs.

---

## Open Questions (being answered in session)

- Multi-tenant vs. per-client deployment — **TBD, design should support both**
- Priority order for building — which role/feature ships first?

