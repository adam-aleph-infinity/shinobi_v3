#!/bin/bash
# Deploy latest code to the development VM/domain.
# Dev target: shinobi-vm -> shinobi.aleph-infinity.com
# Usage: bash deploy/deploy-dev.sh [branch]
set -euo pipefail

PROJECT_ID="shinobi-v2-prod"
VM_NAME="shinobi-vm"
ZONE="us-central1-a"
BRANCH="${1:-dev}"

echo "▶ Deploying Shinobi V3 to DEV VM $VM_NAME (branch: $BRANCH)..."

gcloud compute ssh "$VM_NAME" \
  --tunnel-through-iap \
  --zone="$ZONE" \
  --project="$PROJECT_ID" \
  --command="
    set -euo pipefail
    cd ~/shinobi_v3

    PRESERVE_ROOT=/tmp/shinobi_runtime_preserve_\$(date +%Y%m%d_%H%M%S)
    PRESERVE_PATHS=(
      ui/data/_auth
      ui/data/_pipelines
      ui/data/_pipelines_folders.json
      ui/data/_universal_agents
      ui/data/_notes_agents
      ui/data/_persona_agents
      ui/data/_fpa_analyzer_presets
      ui/data/_fpa_generator_presets
      ui/data/_fpa_scorer_presets
      ui/data/_comparison_presets
      ui/data/_note_rollups
      ui/data/execution_logs
      ui/data/job_logs
      ui/data/_pipeline_states
      ui/data/_artifact_prompt_schemas
      ui/data/_webhooks
      ui/data/webhook_test
      ui/data/all_crm_agents_customers.json
    )

    echo '▶ Preserve runtime data...'
    mkdir -p \"\$PRESERVE_ROOT\"
    for p in \"\${PRESERVE_PATHS[@]}\"; do
      if [ -d \"\$p\" ]; then
        mkdir -p \"\$PRESERVE_ROOT/\$p\"
        rsync -a \"\$p/\" \"\$PRESERVE_ROOT/\$p/\"
      elif [ -f \"\$p\" ]; then
        mkdir -p \"\$PRESERVE_ROOT/\$(dirname \"\$p\")\"
        cp -f \"\$p\" \"\$PRESERVE_ROOT/\$p\"
      fi
    done

    echo '▶ Backup DB...'
    cp ui/database/shinobi.db /tmp/shinobi_db_backup_\$(date +%Y%m%d_%H%M%S).db 2>/dev/null || true

    echo '▶ Pull latest...'
    git fetch origin
    git stash push --include-untracked -m \"pre-deploy \$(date +%Y-%m-%dT%H:%M:%S)\" || true
    git checkout $BRANCH
    git pull origin $BRANCH

    echo '▶ Restore runtime data...'
    for p in \"\${PRESERVE_PATHS[@]}\"; do
      if [ -d \"\$PRESERVE_ROOT/\$p\" ]; then
        mkdir -p \"\$p\"
        rsync -a \"\$PRESERVE_ROOT/\$p/\" \"\$p/\"
      elif [ -f \"\$PRESERVE_ROOT/\$p\" ]; then
        mkdir -p \"\$(dirname \"\$p\")\"
        cp -f \"\$PRESERVE_ROOT/\$p\" \"\$p\"
      fi
    done

    echo '▶ Install Python deps...'
    if [ ! -d .venv ]; then
      python3.11 -m venv .venv || python3 -m venv .venv
    fi
    source .venv/bin/activate
    pip install -r requirements.txt -q

    echo '▶ Build frontend...'
    cd ui/frontend
    npm install --legacy-peer-deps -q
    npm run build
    mkdir -p .next/standalone/.next/static .next/standalone/public
    # Preserve prior chunk files during rollout to avoid ChunkLoadError for users
    # who still have the previous runtime in their browser tab.
    rsync -a .next/static/ .next/standalone/.next/static/
    rsync -a --delete public/ .next/standalone/public/
    cd ~/shinobi_v3

    echo '▶ Update systemd units...'
    sudo tee /etc/systemd/system/shinobi-backend.service >/dev/null <<UNIT
[Unit]
Description=Shinobi DEV — FastAPI Backend (v3)
After=network.target
Wants=network-online.target

[Service]
Type=simple
User=\$USER
WorkingDirectory=/home/\$USER/shinobi_v3
Environment=PATH=/home/\$USER/shinobi_v3/.venv/bin:/usr/local/bin:/usr/bin:/bin
EnvironmentFile=/home/\$USER/shinobi_v3/.env
ExecStart=/home/\$USER/shinobi_v3/.venv/bin/uvicorn ui.backend.main:app --host 127.0.0.1 --port 8000 --workers 2 --timeout-keep-alive 75
Restart=on-failure
RestartSec=5
StartLimitIntervalSec=300
StartLimitBurst=20
LimitNOFILE=65536
StandardOutput=journal
StandardError=journal
SyslogIdentifier=shinobi-backend

[Install]
WantedBy=multi-user.target
UNIT

    sudo tee /etc/systemd/system/shinobi-frontend.service >/dev/null <<UNIT
[Unit]
Description=Shinobi DEV — Next.js Frontend (v3)
After=network.target shinobi-backend.service
Wants=network-online.target

[Service]
Type=simple
User=\$USER
WorkingDirectory=/home/\$USER/shinobi_v3/ui/frontend
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=HOSTNAME=127.0.0.1
ExecStart=/usr/bin/node .next/standalone/server.js
Restart=on-failure
RestartSec=5
StartLimitIntervalSec=60
StartLimitBurst=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=shinobi-frontend

[Install]
WantedBy=multi-user.target
UNIT

    echo '▶ Reload and restart services...'
    sudo systemctl daemon-reload
    sudo systemctl enable shinobi-backend shinobi-frontend
    sudo systemctl restart shinobi-backend shinobi-frontend

    echo '▶ Wait for backend health...'
    for i in \$(seq 1 60); do
      if curl -sf http://127.0.0.1:8000/health > /dev/null; then
        echo '  backend healthy ✓'
        break
      fi
      sleep 1
    done

    rm -rf \"\$PRESERVE_ROOT\" 2>/dev/null || true

    echo '✓ DEV deploy complete'
  "
