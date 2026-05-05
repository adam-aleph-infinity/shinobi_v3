# Shinobi Production Rebuild Specification

> **For the coding agent:** Read this document fully before writing any code.
> Then read the source repo at `github.com/adam-aleph-infinity/shinobi_v2` (branch `simple`).
> This spec tells you exactly what to build, what to include, what to omit, and how to deploy.

---

## 1. What You Are Building

A clean production web application called **Shinobi** — a sales agent analysis platform.

It has two processes running on a single GCP VM:
- **Backend:** Python FastAPI (port 8000)
- **Frontend:** Next.js 14 (port 3000)

They sit behind Nginx, which proxies:
- `/api/*` → FastAPI backend
- `/*` → Next.js frontend

The app is accessed via a GCP HTTPS load balancer with a Google-managed SSL certificate.

---

## 2. Scope — What To Include

Build **only** these features from the source repo. Everything else is excluded.

| Feature | Source Router | Source Frontend Route |
|---|---|---|
| Sidebar navigation (Quick mode only) | `AppSidebar.tsx` | layout |
| CRM Browser | `routers/crm.py` | `/crm` |
| Sync Button | `routers/sync.py` | component in sidebar |
| Transcription (ElevenLabs + smoothing) | `routers/transcription_process.py`, `routers/final_transcript.py` | `/transcription`, `/transcription/create`, `/transcription/[jobId]` |
| Full Persona Agent | `routers/full_persona_agent.py` | `/full-persona-agent` |
| Personas | `routers/personas.py` | `/personas`, `/personas/[personaId]` |
| Agent Comparison | `routers/agent_comparison.py` | `/agent-comparison` |
| Agent Dashboard | `routers/agent_stats.py` | `/agent-dashboard` |
| Logs | `routers/logs.py` | `/logs` |
| Workspace | `routers/workspace.py` | `/workspace` |
| Jobs | `routers/jobs.py` | backend only |
| Audio | `routers/audio.py` | `/audio` |
| Persona Agents | `routers/persona_agents.py` | `/persona-agents` |
| Health check | `main.py` | `/health` |

### What to EXCLUDE (do not port these)

- `/pipeline` route and pipeline router
- `/analyzer` route
- `/comparison` route (keep `/agent-comparison`)
- `/journey` route
- `/session` route and session router
- `/profiles` route
- `/transcription/final` route
- `/optimize` route
- `/simple` route
- Stages 0101, 03, 04, 05 (audio preprocessing, speaker diarization, transcript processing, analysis)
- `orchestrator/` directory
- Multi-mode pipeline
- MLX Whisper / faster-whisper (no local transcription — ElevenLabs only)
- `stages/` directory (transcription engine code is re-implemented inline in the backend)
- Agent dashboard: keep the page but note it should later be integrated with CRM browser (TODO comment in code)

### Sidebar

Use only the **Quick mode** sidebar. Remove the Full/Quick toggle entirely — sidebar is always Quick mode. Quick nav items:

```
Audio Pipeline     → /pipeline       (EXCLUDE — remove this item)
Persona Analyzer   → /analyzer       (EXCLUDE — remove this item)
Full Persona Agent → /full-persona-agent
Personas           → /personas
Compare Personas   → /agent-comparison
Journey            → /journey        (EXCLUDE — remove this item)
Agent Dashboard    → /agent-dashboard
Agent Comparison   → /agent-comparison  (same as Compare Personas, deduplicate)
```

**Final sidebar nav items:**
```
CRM Browser        → /crm
Full Persona Agent → /full-persona-agent
Personas           → /personas
Compare Agents     → /agent-comparison
Agent Dashboard    → /agent-dashboard
Audio Library      → /audio
Transcription      → /transcription
```

---

## 3. Technology Stack

| Layer | Technology | Version |
|---|---|---|
| Backend | Python + FastAPI + uvicorn | Python 3.11, FastAPI latest |
| Frontend | Next.js (App Router) + TypeScript | 14.2.3 |
| Database | SQLite + SQLModel | latest |
| Styling | Tailwind CSS + lucide-react | as in source |
| ORM | SQLModel (Pydantic + SQLAlchemy) | latest |
| Transcription | ElevenLabs Scribe v2 | elevenlabs>=1.50.3 |
| LLM | OpenAI, Anthropic, Gemini, xAI/Grok | latest SDKs |
| Storage | AWS S3 (read-only via presigned URLs) | boto3>=1.34.0 |
| Reverse Proxy | Nginx | Ubuntu package |
| Process manager | systemd | built-in |
| Infrastructure | GCP Compute Engine + Load Balancer + IAP | |

---

## 4. GCP Infrastructure

### 4.1 VM Spec

```
Name:          shinobi-prod
Machine type:  e2-standard-4 (4 vCPU, 16 GB RAM)
OS:            Ubuntu 22.04 LTS
Boot disk:     300 GB SSD persistent disk
Region/Zone:   us-central1-a
Tags:          http-server, https-server, iap-ssh
```

### 4.2 GCP Services Required

- **Compute Engine** — VM
- **Cloud Load Balancing** — HTTPS load balancer with Google-managed SSL cert
- **Cloud IAP** — SSH access without public IP on VM (VM has no external IP)
- **Cloud DNS** — Domain management (or use existing DNS provider)
- **Secret Manager** — Store all API keys (optional but recommended)
- **VPC** — Default VPC, allow ingress on 80/443 from load balancer health check ranges

### 4.3 Firewall Rules

```bash
# Allow load balancer health checks and traffic
gcloud compute firewall-rules create allow-lb-health-checks \
  --allow tcp:80 \
  --source-ranges 130.211.0.0/22,35.191.0.0/16 \
  --target-tags http-server

# Allow IAP SSH
gcloud compute firewall-rules create allow-iap-ssh \
  --allow tcp:22 \
  --source-ranges 35.235.240.0/20 \
  --target-tags iap-ssh

# Internal traffic only — no public IP on VM
```

### 4.4 Load Balancer Setup

```
Frontend (HTTPS) → SSL cert (Google-managed for your domain)
Backend service  → Instance group containing shinobi-prod VM
Health check     → HTTP /api/health on port 80
```

### 4.5 Infrastructure Bootstrap Script

Create `deploy/1_gcp_infra.sh`:

```bash
#!/bin/bash
set -euo pipefail

PROJECT_ID="shinobi-prod"          # change me
ZONE="us-central1-a"
REGION="us-central1"
VM_NAME="shinobi-vm"
DOMAIN="app.yourdomain.com"        # change me

echo "▶ Setting project..."
gcloud config set project $PROJECT_ID

echo "▶ Enabling APIs..."
gcloud services enable compute.googleapis.com \
  iap.googleapis.com \
  certificatemanager.googleapis.com \
  secretmanager.googleapis.com

echo "▶ Creating VM..."
gcloud compute instances create $VM_NAME \
  --zone=$ZONE \
  --machine-type=e2-standard-4 \
  --image-family=ubuntu-2204-lts \
  --image-project=ubuntu-os-cloud \
  --boot-disk-size=300GB \
  --boot-disk-type=pd-ssd \
  --tags=http-server,https-server,iap-ssh \
  --no-address

echo "▶ Creating firewall rules..."
gcloud compute firewall-rules create allow-lb-health \
  --allow tcp:80 \
  --source-ranges 130.211.0.0/22,35.191.0.0/16 \
  --target-tags http-server || true

gcloud compute firewall-rules create allow-iap-ssh \
  --allow tcp:22 \
  --source-ranges 35.235.240.0/20 \
  --target-tags iap-ssh || true

echo "▶ Reserving static IP..."
gcloud compute addresses create shinobi-ip --global

echo "▶ Creating SSL certificate..."
gcloud compute ssl-certificates create shinobi-cert \
  --domains=$DOMAIN --global

echo "▶ Creating instance group..."
gcloud compute instance-groups unmanaged create shinobi-group --zone=$ZONE
gcloud compute instance-groups unmanaged add-instances shinobi-group \
  --instances=$VM_NAME --zone=$ZONE

echo "▶ Creating backend service..."
gcloud compute health-checks create http shinobi-health \
  --request-path=/api/health --port=80
gcloud compute backend-services create shinobi-backend-svc \
  --protocol=HTTP --port-name=http --health-checks=shinobi-health --global
gcloud compute backend-services add-backend shinobi-backend-svc \
  --instance-group=shinobi-group \
  --instance-group-zone=$ZONE --global

echo "▶ Creating URL map + HTTPS proxy + forwarding rule..."
gcloud compute url-maps create shinobi-map \
  --default-service=shinobi-backend-svc
gcloud compute target-https-proxies create shinobi-https-proxy \
  --url-map=shinobi-map --ssl-certificates=shinobi-cert
IP=$(gcloud compute addresses describe shinobi-ip --global --format='value(address)')
gcloud compute forwarding-rules create shinobi-https-rule \
  --address=$IP --global --target-https-proxy=shinobi-https-proxy --ports=443

echo "✓ Infra ready. VM IP for LB: $IP"
echo "  Point your DNS: $DOMAIN → $IP"
echo "  Then run: gcloud compute ssh --tunnel-through-iap $VM_NAME --zone=$ZONE"
```

---

## 5. VM Setup Script

Create `deploy/2_setup_vm.sh` — run **on the VM** after SSHing in:

```bash
#!/bin/bash
set -euo pipefail

APP_DIR="/home/$USER/shinobi"
REPO_URL="https://github.com/adam-aleph-infinity/shinobi_v2.git"
BRANCH="simple"

echo "▶ System packages..."
sudo apt-get update -qq
sudo apt-get install -y \
  python3.11 python3.11-venv python3-pip \
  nginx git curl ffmpeg screen build-essential \
  libsndfile1 libffi-dev libssl-dev

echo "▶ Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

echo "▶ Clone repo..."
git clone --branch $BRANCH $REPO_URL $APP_DIR
cd $APP_DIR

echo "▶ Python venv..."
python3.11 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip -q
pip install -r requirements.txt -q
pip install -r ui/backend/requirements.txt -q

echo "▶ Frontend build..."
cd ui/frontend
npm install --legacy-peer-deps -q
npm run build
# Keep previous chunks available during rollout to reduce ChunkLoadError in open tabs.
rsync -a .next/static/ .next/standalone/.next/static/
rsync -a --delete public/ .next/standalone/public/
cd $APP_DIR

echo "▶ Create data directories..."
mkdir -p ui/data/agents
mkdir -p ui/database
mkdir -p ui/data/_persona_agents
mkdir -p ui/data/_fpa_generator_presets
mkdir -p ui/data/_fpa_scorer_presets
mkdir -p ui/data/_comparison_presets

echo "▶ Nginx config..."
sudo tee /etc/nginx/sites-available/shinobi <<'NGINX'
server {
    listen 80;
    server_name _;
    client_max_body_size 500M;

    location /api/ {
        proxy_pass http://127.0.0.1:8000/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 600;
        proxy_send_timeout 600;
        # SSE support
        proxy_buffering off;
        proxy_cache off;
        proxy_set_header Connection '';
        chunked_transfer_encoding on;
    }

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 120;
    }
}
NGINX

sudo ln -sf /etc/nginx/sites-available/shinobi /etc/nginx/sites-enabled/shinobi
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl enable nginx && sudo systemctl restart nginx

echo "▶ Systemd services..."
sudo tee /etc/systemd/system/shinobi-backend.service <<UNIT
[Unit]
Description=Shinobi FastAPI Backend
After=network.target

[Service]
User=$USER
WorkingDirectory=$APP_DIR
Environment=PATH=$APP_DIR/.venv/bin:/usr/bin:/bin
EnvironmentFile=$APP_DIR/.env
ExecStart=$APP_DIR/.venv/bin/uvicorn ui.backend.main:app --host 127.0.0.1 --port 8000 --workers 1 --timeout-keep-alive 75
Restart=on-failure
RestartSec=5
StartLimitIntervalSec=60
StartLimitBurst=5
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
UNIT

sudo tee /etc/systemd/system/shinobi-frontend.service <<UNIT
[Unit]
Description=Shinobi Next.js Frontend
After=network.target

[Service]
User=$USER
WorkingDirectory=$APP_DIR/ui/frontend
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=HOSTNAME=127.0.0.1
ExecStart=/usr/bin/node .next/standalone/server.js
Restart=on-failure
RestartSec=5
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable shinobi-backend shinobi-frontend
sudo systemctl start shinobi-backend shinobi-frontend

echo "✓ VM setup complete."
echo "  Upload .env and .env.crm, then verify:"
echo "  sudo systemctl status shinobi-backend"
echo "  sudo systemctl status shinobi-frontend"
```

---

## 6. Environment Variables

### `.env` (main app secrets — place at repo root on VM)

```bash
# ── LLM Providers ──────────────────────────────────────────
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
GEMINI_API_KEY=AIzaSy...
XAI_API_KEY=xai-...
ELEVENLABS_API_KEY=...

# ── AWS S3 (CRM audio — read-only access) ──────────────────
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...

# ── App config ─────────────────────────────────────────────
FRONTEND_ORIGIN=https://app.yourdomain.com

# ── GitHub (for deploy script to pull latest) ──────────────
GITHUB_PAT=github_pat_...
```

### `.env.crm` (CRM credentials — place at repo root on VM)

```bash
# Format: one CRM per block
BRT_URL=https://brtcrm.io
BRT_API_KEY=...
BRT_USERNAME=...
BRT_PASSWORD=...

MLB_URL=https://mlbcrm.io
MLB_API_KEY=...
MLB_USERNAME=...
MLB_PASSWORD=...

# Add more CRMs as needed — see shared/crm_client.py for parsing
```

### Upload secrets to VM

```bash
# From your Mac (run from shinobi_v2/):
gcloud compute scp .env .env.crm \
  shinobi-vm:/home/$USER/shinobi/ \
  --tunnel-through-iap --zone=us-central1-a
```

---

## 7. Backend Architecture

### 7.1 Entry Point

`ui/backend/main.py` — copied exactly from source with only the following router registrations (remove all others):

```python
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from ui.backend.routers import (
    crm, sync, transcription_process, final_transcript,
    full_persona_agent, personas, agent_comparison,
    agent_stats, audio, jobs, logs, workspace,
    persona_agents,
)

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=[settings.frontend_origin], ...)

# Register only these routers:
app.include_router(crm.router)
app.include_router(sync.router)
app.include_router(transcription_process.router)
app.include_router(final_transcript.router)
app.include_router(full_persona_agent.router)
app.include_router(personas.router)
app.include_router(agent_comparison.router)
app.include_router(agent_stats.router)
app.include_router(audio.router)
app.include_router(jobs.router)
app.include_router(logs.router)
app.include_router(workspace.router)
app.include_router(persona_agents.router)

@app.get("/health")
def health(): return {"ok": True}
```

### 7.2 Database

**File:** `ui/database/shinobi.db` (SQLite)

Tables needed (copy model files exactly from source):
- `persona` — `ui/backend/models/persona.py`
- `job` — `ui/backend/models/job.py`
- `crm_pair` — `ui/backend/models/crm.py`
- `crm_call` — `ui/backend/models/crm.py`
- `comparison_file` — `ui/backend/models/comparison_file.py`
- `persona_agent` — `ui/backend/models/persona_agent.py` (if exists, else create from router)

DB is created automatically on first startup via SQLModel `create_all()`.

Schema migrations in `main.py` startup (copy existing ALTER TABLE additions from source `main.py`).

### 7.3 Config

`ui/backend/config.py` — copy exactly. Key paths:

```python
ui_data_dir  = {project_root}/ui/data        # agent/customer hierarchy
agents_dir   = {project_root}/ui/data/agents
index_file   = {project_root}/ui/data/index.json
db_path      = {project_root}/ui/database/shinobi.db
```

### 7.4 Transcription — ElevenLabs Only

**Important:** In production, transcription uses **ElevenLabs Scribe v2 only**. No local Whisper, no MLX, no faster-whisper.

**Flow:**
1. CRM call record path → generate S3 presigned URL (boto3)
2. Pass presigned URL directly to ElevenLabs API (`source_url` param) — **no local download**
3. ElevenLabs transcribes → returns word-level JSON with speaker diarization
4. Smoothing pass: LLM cleans up transcript (uses `_smooth_call()` in `quick.py`)
5. Save smoothed transcript to `ui/data/agents/{agent}/{customer}/{call_id}/transcribed/llm_final/smoothed.txt`

**Remove the 2-minute minimum filter** — transcribe ALL calls regardless of duration.

Source for transcription logic:
- `ui/backend/routers/quick.py` — `_transcribe_call()`, `_smooth_call()`, `_s3_presigned_url()`
- `stages/02_transcription/engines/elevenlabs.py` — raw ElevenLabs API call
- `ui/backend/routers/transcription_process.py` — job-based transcription UI flow

### 7.5 S3 Bucket Map

Copy `_CRM_S3_BUCKETS` from `quick.py` exactly — maps CRM hostname to S3 bucket + region:

```python
_CRM_S3_BUCKETS = {
    "mlbcrm.io":        {"bucket": "mlb-bucket-prod",    "region": "us-east-1"},
    "brtcrm.io":        {"bucket": "brt-production",     "region": "us-east-1"},
    "sfxcrm.io":        {"bucket": "sfx-bucket-prod",    "region": "us-east-1"},
    "sa-ret.coperato.net": {"bucket": "...",             "region": "..."},
}
```

---

## 8. Frontend Architecture

### 8.1 Pages to Include

Copy these pages exactly from source `ui/frontend/app/`:

```
/crm                    → app/crm/page.tsx
/transcription          → app/transcription/page.tsx
/transcription/create   → app/transcription/create/page.tsx
/transcription/[jobId]  → app/transcription/[jobId]/page.tsx
/full-persona-agent     → app/full-persona-agent/page.tsx
/personas               → app/personas/page.tsx
/personas/[personaId]   → app/personas/[personaId]/page.tsx (if exists)
/agent-comparison       → app/agent-comparison/page.tsx
/agent-dashboard        → app/agent-dashboard/page.tsx
/audio                  → app/audio/page.tsx
/logs                   → app/logs/page.tsx
/workspace              → app/workspace/page.tsx
/persona-agents         → app/persona-agents/page.tsx
```

### 8.2 Sidebar

Copy `ui/frontend/components/layout/AppSidebar.tsx` but:
- Remove the Quick/Full mode toggle — always Quick mode
- Remove nav items for excluded routes (`/pipeline`, `/analyzer`, `/journey`, `/session`, `/comparison`)
- Keep: `/crm`, `/full-persona-agent`, `/personas`, `/agent-comparison`, `/agent-dashboard`, `/audio`, `/transcription`
- Keep `SyncButton` and `BackendStatus` components
- Version: set to `v1.0.0` (new project, new versioning)

### 8.3 Shared Components

Copy all components from `ui/frontend/components/` exactly:
- `layout/` — AppSidebar, SyncButton, DragHandle, CollapsiblePanel
- `shared/` — All shared UI components
- `personas/` — PersonaSections, SectionBuilder
- Any other component directories referenced by included pages

### 8.4 API Config

`ui/frontend/next.config.mjs` — copy exactly:

```js
const nextConfig = {
  output: "standalone",
  experimental: { missingSuspenseWithCSRBailout: false },
  async rewrites() {
    return [{ source: "/api/:path*", destination: "http://127.0.0.1:8000/:path*" }];
  },
};
```

### 8.5 Next.js API Routes

Copy only the API routes needed for included features from `ui/frontend/app/api/`:
- `api/sync/full/` — SSE sync passthrough
- `api/crm/calls/[accountId]/refresh/` — CRM refresh
- `api/personas/[personaId]/regenerate/` — Persona regen

---

## 9. Python Dependencies

`requirements.txt` (root):

```
# LLM providers
openai>=1.55.0
anthropic>=0.50.0
google-generativeai>=0.8.3

# Transcription
elevenlabs>=1.50.3

# AWS
boto3>=1.34.0

# Audio processing (smoothing only, no local transcription)
librosa>=0.10.2
soundfile>=0.12.1
scipy>=1.11.0
numpy>=1.24.0

# Utilities
python-dotenv>=1.0.1
requests>=2.31.0
```

`ui/backend/requirements.txt`:

```
fastapi>=0.111.0
uvicorn[standard]>=0.29.0
sqlmodel>=0.0.19
pydantic>=2.7.0
pydantic-settings>=2.2.0
python-multipart>=0.0.9
httpx>=0.27.0
aiofiles>=23.2.1
```

---

## 10. Deployment Script

`deploy/deploy.sh` — run from your Mac to deploy latest code to GCP:

```bash
#!/bin/bash
set -euo pipefail

PROJECT_ID="shinobi-prod"      # change me
VM_NAME="shinobi-vm"
ZONE="us-central1-a"
BRANCH="main"
APP_DIR="/home/$(gcloud compute ssh --tunnel-through-iap $VM_NAME --zone=$ZONE --command='echo $USER' 2>/dev/null)/shinobi"

echo "▶ Deploying to $VM_NAME (branch: $BRANCH)..."

gcloud compute ssh $VM_NAME \
  --tunnel-through-iap \
  --zone=$ZONE \
  --command="
    set -euo pipefail
    cd ~/shinobi

    echo '▶ Backup DB...'
    cp ui/database/shinobi.db /tmp/shinobi_db_backup_\$(date +%Y%m%d_%H%M%S).db 2>/dev/null || true

    echo '▶ Pull latest...'
    git fetch origin
    git stash || true
    git checkout $BRANCH
    git pull origin $BRANCH

    echo '▶ Install Python deps...'
    source .venv/bin/activate
    pip install -r requirements.txt -q
    pip install -r ui/backend/requirements.txt -q

echo '▶ Build frontend...'
cd ui/frontend
npm install --legacy-peer-deps -q
npm run build
# Keep previous chunks available during rollout to reduce ChunkLoadError in open tabs.
rsync -a .next/static/ .next/standalone/.next/static/
rsync -a --delete public/ .next/standalone/public/
cd ~/shinobi

    echo '▶ Restart services...'
    sudo systemctl restart shinobi-backend shinobi-frontend

    echo '▶ Wait for backend health...'
    for i in \$(seq 1 30); do
      if curl -sf http://127.0.0.1:8000/health > /dev/null; then
        echo '  backend healthy ✓'
        break
      fi
      sleep 1
    done

    echo '✓ Deploy complete'
  "
```

### Quick commands

```bash
# Deploy
bash deploy/deploy.sh

# SSH into VM
gcloud compute ssh --tunnel-through-iap shinobi-vm --zone=us-central1-a

# Stream backend logs
gcloud compute ssh --tunnel-through-iap shinobi-vm --zone=us-central1-a \
  --command='sudo journalctl -u shinobi-backend -f'

# Restart backend only
gcloud compute ssh --tunnel-through-iap shinobi-vm --zone=us-central1-a \
  --command='sudo systemctl restart shinobi-backend'

# Upload updated .env
gcloud compute scp .env shinobi-vm:/home/$USER/shinobi/.env \
  --tunnel-through-iap --zone=us-central1-a

# Upload data directory (first time or restore)
gcloud compute scp --recurse ui/data shinobi-vm:/home/$USER/shinobi/ui/ \
  --tunnel-through-iap --zone=us-central1-a

# Download DB backup from VM
gcloud compute scp \
  shinobi-vm:/home/$USER/shinobi/ui/database/shinobi.db \
  ./shinobi_backup_$(date +%Y%m%d).db \
  --tunnel-through-iap --zone=us-central1-a
```

---

## 11. File System Structure on VM

```
~/shinobi/                          ← APP_DIR (cloned from git)
├── .env                            ← uploaded manually (never in git)
├── .env.crm                        ← uploaded manually (never in git)
├── .venv/                          ← Python virtual environment
├── requirements.txt
├── ui/
│   ├── backend/
│   │   ├── main.py
│   │   ├── config.py
│   │   ├── database.py
│   │   ├── models/
│   │   ├── routers/
│   │   ├── services/
│   │   └── requirements.txt
│   ├── database/
│   │   └── shinobi.db              ← SQLite DB (persists across deploys)
│   ├── data/                       ← All runtime data (persists across deploys)
│   │   ├── agents/
│   │   │   └── {agent}/{customer}/
│   │   │       ├── manifest.json
│   │   │       ├── calls.json
│   │   │       ├── merged_transcript.txt
│   │   │       └── {call_id}/
│   │   │           └── transcribed/llm_final/smoothed.txt
│   │   ├── index.json
│   │   ├── _persona_agents/
│   │   ├── _fpa_generator_presets/
│   │   ├── _fpa_scorer_presets/
│   │   └── _comparison_presets/
│   └── frontend/
│       ├── package.json
│       ├── .next/standalone/       ← Built Next.js app
│       └── public/
├── shared/                         ← Shared Python utilities
├── deploy/                         ← Deploy scripts
└── ...
```

**Critical:** `ui/database/shinobi.db` and `ui/data/` **must survive** every deploy. The deploy script backs up the DB before pulling. Never `git clean` these directories.

---

## 12. Shared Python Modules to Copy

These are imported by backend routers — copy them exactly:

```
shared/
├── llm_client.py       # LLMClient — OpenAI/Anthropic/Gemini/Grok abstraction
├── crm_client.py       # CRM API auth + calls
├── io_utils.py         # ensure_dir(), write_json(), read_json()
└── audio_utils.py      # Audio helpers (if used by transcription)

config/
├── settings.py         # load_config() helper (if used by shared/)
└── lexicon.py          # Domain vocabulary for smoothing prompts
```

---

## 13. Key Implementation Notes

### Transcription — No Minimum Duration Filter

In the source, `quick.py` has a check skipping calls under 2 minutes. **Remove this check in production.** All calls should be transcribed.

Search for: `duration` or `min_duration` in `quick.py` and `transcription_process.py` — remove the guard.

### ElevenLabs via S3 Presigned URL (No Download)

Do **not** download audio files to the VM. Pass S3 presigned URLs directly to ElevenLabs:

```python
resp = requests.post(
    "https://api.elevenlabs.io/v1/speech-to-text",
    data={
        "source_url": presigned_url,   # ← S3 URL, ElevenLabs fetches it directly
        "model_id": "scribe_v2",
        "diarize": "true",
        "tag_audio_events": "true",
        "timestamps_granularity": "word",
    },
    headers={"xi-api-key": ELEVENLABS_API_KEY},
    timeout=300,
)
```

### xAI File Queries Use /v1/responses

When querying Grok with uploaded files (agent comparison), use `/v1/responses` not `/v1/chat/completions`. See `agent_comparison.py` `_query_grok()` function for exact payload format.

### Scorer Receives Transcript + Persona Card

In `full_persona_agent.py`, the scorer user message should include both:
1. The generated persona card (Stage 2 output)
2. The original merged transcript (for Secret Code verification)

See the `score_user_msg` construction in `analyze()` endpoint — copy exactly.

### Agent Dashboard — Future CRM Integration

Add a TODO comment in the agent dashboard page:
```
// TODO: Integrate with CRM browser — show per-agent call stats
// alongside CRM data (deposits, call count, last activity)
```

---

## 14. First-Time Setup Checklist

```
[ ] gcloud auth login
[ ] gcloud config set project {PROJECT_ID}
[ ] bash deploy/1_gcp_infra.sh
[ ] Point DNS A record to load balancer IP
[ ] gcloud compute ssh --tunnel-through-iap shinobi-vm --zone=us-central1-a
[ ] (on VM) bash ~/shinobi_v2/deploy/2_setup_vm.sh   ← if pre-cloned, else curl the script
[ ] (from Mac) gcloud compute scp .env .env.crm shinobi-vm:~/shinobi/ --tunnel-through-iap --zone=us-central1-a
[ ] (on VM) sudo systemctl restart shinobi-backend shinobi-frontend
[ ] curl https://app.yourdomain.com/api/health   ← expect {"ok": true}
[ ] Open https://app.yourdomain.com in browser
[ ] CRM Browser → Sync → verify pairs load
[ ] Full Persona Agent → verify LLM calls work
[ ] Transcription → create job → verify ElevenLabs works
```

---

## 15. Source Repo Reference

**Repo:** `github.com/adam-aleph-infinity/shinobi_v2`
**Branch:** `simple`
**Tag:** `v8.0.0` / `final`

When in doubt about implementation details, read the source files directly. The source is the ground truth — this spec describes what to include, exclude, and modify. Implementation details (exact API calls, data structures, DB schema, LLM prompts) should be copied from source rather than reimplemented from scratch.

Key source files for each feature:
- CRM: `ui/backend/routers/crm.py`, `ui/backend/services/crm_service.py`, `shared/crm_client.py`
- Transcription: `ui/backend/routers/transcription_process.py`, `ui/backend/routers/quick.py`
- Full Persona Agent: `ui/backend/routers/full_persona_agent.py` (complete, 1000+ lines)
- Personas: `ui/backend/routers/personas.py` (complete, 1500+ lines)
- Agent Comparison: `ui/backend/routers/agent_comparison.py`
- Agent Dashboard: find in `ui/backend/routers/agent_stats.py` or similar
- Sidebar: `ui/frontend/components/layout/AppSidebar.tsx`
- Sync: `ui/backend/routers/sync.py`
