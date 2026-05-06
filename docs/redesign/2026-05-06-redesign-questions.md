# Shinobi V3 — Redesign Exploration Questions

_Created: 2026-05-06. This is a living doc — answers go inline under each question._

---

## What I understand so far

Shinobi is a compliance and sales intelligence platform for a crypto/forex brokerage. Brokers make calls to UK and Australian clients, guiding them through a complex crypto deposit process. Shinobi:

1. Ingests call recordings from CRM webhooks (brtcrm.io, mlbcrm.io, sfxcrm.io)
2. Transcribes via ElevenLabs Scribe v2
3. Runs multi-stage AI pipelines (conversation analysis → compliance scoring → next-call actions)
4. Generates compliance notes, persona profiles, violation flags
5. Pushes results back into the CRM

The current system is working but has grown organically — `pipelines.py` is 9,300 lines, the run observability is split across 3+ pages, and the pipeline canvas is being built as the next-gen editor.

---

## Questions

### 1. Scope of "redesign everything"

> What does the redesign cover? Pick all that apply:
> - [ ] A) UX overhaul — same features, much better interface
> - [ ] B) Backend architecture — break up the monolith, cleaner APIs
> - [ ] C) New features — build the gaps from the competitive analysis
> - [ ] D) Product repositioning — change what Shinobi *is*, not just how it looks
> - [ ] E) Tech stack change — move away from FastAPI/Next.js

_Answer:_

---

### 2. Primary users and their daily workflow

> Who uses Shinobi day-to-day and what's their typical session?
> - A) **Compliance managers** — reviewing notes, catching violations, coaching reps
> - B) **Floor managers** — monitoring live calls, dispatching agents, real-time ops
> - C) **The system itself** — fully automated, no human in the loop most of the time
> - D) **Developers/you** — mostly you tuning pipelines and fixing things

_Answer:_

---

### 3. Biggest daily pain point right now

> What is the single most frustrating thing about the current system that you'd pay to fix immediately?

_Answer:_

---

### 4. The pipeline canvas

> The canvas (ReactFlow) is being actively built. What is its intended role?
> - A) The primary way to build and edit pipelines (visual-first, replaces the old page)
> - B) A power-user tool alongside the existing pipeline page
> - C) A demo/showcase layer — the real logic stays in code
> - D) Something else?

_Answer:_

---

### 5. Single-org vs multi-tenant

> Is this an internal tool for one operation, or is the vision to sell it as SaaS to multiple broker operations?
> - A) Internal only — one company, one setup
> - B) Multi-tenant SaaS — sell to multiple brokers
> - C) Currently internal, but multi-tenant is the target

_Answer:_

---

### 6. Language and locale

> The codebase hints at Hebrew/English handling. What's the actual breakdown?
> - A) All English — clients, agents, and system
> - B) Agents speak Hebrew internally, clients are English-speaking
> - C) Some CRM data is in Hebrew, transcripts are English
> - D) Mixed — needs full RTL/bilingual support

_Answer:_

---

### 7. The review queue and human-in-the-loop

> The competitive analysis flags a critical gap: no confidence gate before CRM push (wrong note = wrong context = real problem). How much human review do you want?
> - A) Full auto — trust the AI, push everything, flag outliers for async review
> - B) Confidence-gated — auto-push high-confidence, hold low-confidence for review
> - C) Human-approved for all — nothing goes to CRM without a human sign-off
> - D) Different rules per pipeline type

_Answer:_

---

### 8. The biggest architectural pain

> `pipelines.py` is 9,300 lines. `webhooks.py` is 3,573. Is the backend architecture a blocker for shipping new features?
> - A) Yes — it's slowing everything down, we need to break it up before adding more
> - B) Somewhat — painful but not a blocker, we can layer on top
> - C) Not really — functionality works, don't touch what isn't broken

_Answer:_

---

### 9. Real-time vs async

> How important is real-time pipeline execution visibility?
> - A) Critical — managers need live status while calls are happening
> - B) Important but not real-time — near-real-time (seconds) is fine
> - C) Batch is fine — run every hour, review in the morning

_Answer:_

---

### 10. The pipeline as a product

> Are pipelines something brokers configure themselves, or are they fixed by you?
> - A) Fixed by you — the pipeline is the product, brokers don't touch it
> - B) Configurable per-client — each broker operation gets a tuned pipeline
> - C) The canvas vision is to let operators build their own pipelines no-code

_Answer:_

---

### 11. What "10x better" looks like

> If Shinobi were 10x better in 12 months, what would be different? What would a manager say in their first 5 minutes using it?

_Answer:_

---

### 12. Compliance data sensitivity

> The notes and call analyses contain sensitive compliance data (violations, secret codes, client behavior). Any hard requirements around data residency, encryption, or access control?
> - A) No — internal tool, current setup is fine
> - B) Some — specific fields need to be encrypted or masked
> - C) Significant — regulatory requirements we haven't addressed yet

_Answer:_

---

### 13. Deployment model going forward

> Should the redesigned Shinobi still run on a single GCP VM?
> - A) Yes — keep it simple, VM is fine for the scale
> - B) No — need containerization (Docker/K8s) for reliability/scale
> - C) Serverless/managed (Cloud Run, Vercel, etc.)
> - D) Undecided

_Answer:_

---

## Market Research (in progress)

See companion file: `2026-05-06-market-research.md`

Key competitors and alternatives being investigated:
- **Conversation intelligence**: Gong, Chorus (ZoomInfo), Avoma, Jiminny, Observe.AI, Salesloft
- **Compliance monitoring**: Verint, NICE Nexidia, Observe.AI
- **Workflow/automation**: n8n, Zapier, Make
- **AI pipeline builders**: Langflow, Flowise, Dify, Rivet
- **CRM intelligence**: Salesforce Einstein, HubSpot AI, Pipedrive AI
- **Broker-specific**: Specific fin-tech CRM tools for crypto/forex brokers

---

## Key Tensions to Resolve

1. **Canvas vs. code** — Visual pipeline editor vs. programmatic pipeline definition
2. **Auto-push vs. review queue** — Speed vs. accuracy on CRM writes
3. **Monolith vs. decomposition** — Ship fast now vs. sustainable architecture
4. **Single-org vs. SaaS** — Simple internal tool vs. productizable platform
5. **Real-time vs. batch** — Immediate feedback vs. simpler infrastructure

