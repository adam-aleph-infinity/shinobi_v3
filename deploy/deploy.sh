#!/bin/bash
# Deploy latest code from Mac → GCP VM
# Usage: bash deploy/deploy.sh [branch]
set -euo pipefail

PROJECT_ID="shinobi-v2-prod"
VM_NAME="shinobi-v3-vm"
ZONE="us-central1-a"
BRANCH="${1:-main}"

echo "▶ Deploying Shinobi V3 to $VM_NAME (branch: $BRANCH)..."

gcloud compute ssh $VM_NAME \
  --tunnel-through-iap \
  --zone=$ZONE \
  --project=$PROJECT_ID \
  --command="
    set -euo pipefail
    cd ~/shinobi_v3

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

    echo '▶ Build frontend...'
    cd ui/frontend
    npm install --legacy-peer-deps -q
    rm -rf .next
    npm run build
    cp -r .next/static .next/standalone/.next/static
    cp -r public .next/standalone/public
    cd ~/shinobi_v3

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
