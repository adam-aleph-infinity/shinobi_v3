#!/bin/bash
# Migrate/deploy Shinobi V3 to the development VM/domain.
# Dev target: shinobi-vm -> shinobi.aleph-infinity.com
# Usage: bash deploy/deploy-dev.sh [branch]
set -euo pipefail

PROJECT_ID="shinobi-v2-prod"
VM_NAME="shinobi-vm"
ZONE="us-central1-a"
BRANCH="${1:-main}"
APP_DIR="~/shinobi_v3"
LEGACY_DIR="~/shinobi_v2"
REPO_URL="https://github.com/adam-aleph-infinity/shinobi_v3.git"

echo "▶ Deploying Shinobi V3 to DEV VM $VM_NAME (branch: $BRANCH)..."

gcloud compute ssh "$VM_NAME" \
  --tunnel-through-iap \
  --zone="$ZONE" \
  --project="$PROJECT_ID" \
  --command="
    set -euo pipefail

    APP_DIR=$APP_DIR
    LEGACY_DIR=$LEGACY_DIR
    REPO_URL=$REPO_URL
    BRANCH=$BRANCH

    if [ ! -d \"\$APP_DIR/.git\" ]; then
      echo '▶ First-time setup: cloning shinobi_v3...'
      git clone --branch \"\$BRANCH\" \"\$REPO_URL\" \"\$APP_DIR\"
    fi

    cd \"\$APP_DIR\"

    echo '▶ Pull latest code...'
    git fetch origin
    git stash || true
    git checkout \"\$BRANCH\"
    git pull origin \"\$BRANCH\"

    echo '▶ Ensure data directories...'
    mkdir -p ui/data ui/database ui/data/agents

    echo '▶ Migrate env files from legacy app (if present)...'
    if [ -f \"\$LEGACY_DIR/.env\" ] && [ ! -f .env ]; then
      cp \"\$LEGACY_DIR/.env\" .env
      echo '  copied .env from legacy'
    fi
    if [ -f \"\$LEGACY_DIR/.env.crm\" ] && [ ! -f .env.crm ]; then
      cp \"\$LEGACY_DIR/.env.crm\" .env.crm
      echo '  copied .env.crm from legacy'
    fi

    echo '▶ One-time data bootstrap from legacy app (safe copy)...'
    if [ ! -f .dev_migrated_from_v2 ]; then
      if [ -d \"\$LEGACY_DIR/ui/data\" ]; then
        rsync -a \"\$LEGACY_DIR/ui/data/\" ui/data/ || true
      fi
      if [ -f \"\$LEGACY_DIR/ui/database/shinobi.db\" ] && [ ! -f ui/database/shinobi.db ]; then
        cp \"\$LEGACY_DIR/ui/database/shinobi.db\" ui/database/shinobi.db
      fi
      date -u +%Y-%m-%dT%H:%M:%SZ > .dev_migrated_from_v2
    fi

    echo '▶ Python dependencies...'
    if [ ! -d .venv ]; then
      python3.11 -m venv .venv || python3 -m venv .venv
    fi
    source .venv/bin/activate
    pip install --upgrade pip -q
    pip install -r requirements.txt -q

    echo '▶ Frontend build...'
    cd ui/frontend
    npm install --legacy-peer-deps -q
    rm -rf .next
    npm run build
    cp -r .next/static .next/standalone/.next/static
    cp -r public .next/standalone/public
    cd \"\$APP_DIR\"

    echo '▶ Update systemd units to point to shinobi_v3...'
    sudo tee /etc/systemd/system/shinobi-backend.service >/dev/null <<UNIT
[Unit]
Description=Shinobi DEV — FastAPI Backend (v3)
After=network.target
Wants=network-online.target

[Service]
Type=simple
User=\$USER
WorkingDirectory=\$APP_DIR
Environment=PATH=\$APP_DIR/.venv/bin:/usr/local/bin:/usr/bin:/bin
EnvironmentFile=\$APP_DIR/.env
ExecStart=\$APP_DIR/.venv/bin/uvicorn ui.backend.main:app --host 127.0.0.1 --port 8000 --workers 1 --timeout-keep-alive 75
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
WorkingDirectory=\$APP_DIR/ui/frontend
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

    echo '▶ Service summary:'
    sudo systemctl --no-pager --full status shinobi-backend shinobi-frontend | sed -n '1,40p'

    echo '✓ DEV deploy complete'
  "
