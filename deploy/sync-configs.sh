#!/bin/bash
# Sync only agent/pipeline configuration between dev and prod stacks.
# Usage:
#   bash deploy/sync-configs.sh prod-to-dev [--restart]
#   bash deploy/sync-configs.sh dev-to-prod [--restart]
set -euo pipefail

MODE="${1:-}"
RESTART="${2:-}"

PROJECT_ID="shinobi-v2-prod"
ZONE="us-central1-a"
DEV_VM="shinobi-vm"
PROD_VM="shinobi-v3-vm"
APP_SUBPATH="shinobi_v3"

DIR_PATHS=(
  "ui/data/_universal_agents"
  "ui/data/_pipelines"
  "ui/data/_notes_agents"
  "ui/data/_persona_agents"
)
FILE_PATHS=(
  "ui/data/_pipelines_folders.json"
)

usage() {
  cat <<USAGE
Sync only agent/pipeline settings between environments.

Usage:
  bash deploy/sync-configs.sh prod-to-dev [--restart]
  bash deploy/sync-configs.sh dev-to-prod [--restart]

Modes:
  prod-to-dev   copy config from production VM to development VM
  dev-to-prod   copy config from development VM to production VM

Options:
  --restart     restart backend/frontend services on destination VM after sync
USAGE
}

if [[ "$MODE" != "prod-to-dev" && "$MODE" != "dev-to-prod" ]]; then
  usage
  exit 1
fi

if [[ -n "$RESTART" && "$RESTART" != "--restart" ]]; then
  usage
  exit 1
fi

if [[ "$MODE" == "prod-to-dev" ]]; then
  SRC_VM="$PROD_VM"
  DST_VM="$DEV_VM"
else
  SRC_VM="$DEV_VM"
  DST_VM="$PROD_VM"
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "▶ Sync mode: $MODE"
echo "▶ Source VM: $SRC_VM"
echo "▶ Destination VM: $DST_VM"

SYNC_DIRS=()
SYNC_FILES=()

echo "▶ Pull config from source VM..."
for rel in "${DIR_PATHS[@]}"; do
  if gcloud compute ssh "$SRC_VM" \
    --tunnel-through-iap \
    --zone="$ZONE" \
    --project="$PROJECT_ID" \
    --command="test -d ~/$APP_SUBPATH/$rel" >/dev/null 2>&1; then
    mkdir -p "$TMP_DIR/$(dirname "$rel")"
    gcloud compute scp --recurse \
      --tunnel-through-iap \
      --zone="$ZONE" \
      --project="$PROJECT_ID" \
      "$SRC_VM:~/$APP_SUBPATH/$rel" \
      "$TMP_DIR/$(dirname "$rel")/"
    SYNC_DIRS+=("$rel")
    echo "  ✓ $rel"
  else
    echo "  - missing on source: $rel (skipped)"
  fi
done

for rel in "${FILE_PATHS[@]}"; do
  if gcloud compute ssh "$SRC_VM" \
    --tunnel-through-iap \
    --zone="$ZONE" \
    --project="$PROJECT_ID" \
    --command="test -f ~/$APP_SUBPATH/$rel" >/dev/null 2>&1; then
    mkdir -p "$TMP_DIR/$(dirname "$rel")"
    gcloud compute scp \
      --tunnel-through-iap \
      --zone="$ZONE" \
      --project="$PROJECT_ID" \
      "$SRC_VM:~/$APP_SUBPATH/$rel" \
      "$TMP_DIR/$rel"
    SYNC_FILES+=("$rel")
    echo "  ✓ $rel"
  else
    echo "  - missing on source: $rel (skipped)"
  fi
done

if [[ "${#SYNC_DIRS[@]}" -eq 0 && "${#SYNC_FILES[@]}" -eq 0 ]]; then
  echo "✗ Nothing to sync."
  exit 1
fi

TS="$(date -u +%Y%m%d_%H%M%S)"
STAGE_REL=".config_sync_stage_${MODE}_${TS}"
BACKUP_FILE="backups/config-sync/${MODE}_${TS}.tgz"

echo "▶ Prepare destination backup + staging..."
ALL_ITEMS=("${SYNC_DIRS[@]}" "${SYNC_FILES[@]}")
BACKUP_ITEMS="${ALL_ITEMS[*]}"
gcloud compute ssh "$DST_VM" \
  --tunnel-through-iap \
  --zone="$ZONE" \
  --project="$PROJECT_ID" \
  --command="
    set -euo pipefail
    cd ~/$APP_SUBPATH
    mkdir -p backups/config-sync
    mkdir -p $STAGE_REL/ui/data
    tar -czf $BACKUP_FILE $BACKUP_ITEMS 2>/dev/null || true
    echo '  backup: ~/$APP_SUBPATH/$BACKUP_FILE'
  "

echo "▶ Upload synced config to destination staging..."
for rel in "${SYNC_DIRS[@]}"; do
  gcloud compute scp --recurse \
    --tunnel-through-iap \
    --zone="$ZONE" \
    --project="$PROJECT_ID" \
    "$TMP_DIR/$rel" \
    "$DST_VM:~/$APP_SUBPATH/$STAGE_REL/$(dirname "$rel")/"
done

for rel in "${SYNC_FILES[@]}"; do
  gcloud compute scp \
    --tunnel-through-iap \
    --zone="$ZONE" \
    --project="$PROJECT_ID" \
    "$TMP_DIR/$rel" \
    "$DST_VM:~/$APP_SUBPATH/$STAGE_REL/$rel"
done

echo "▶ Apply staged config on destination..."
for rel in "${SYNC_DIRS[@]}"; do
  parent="$(dirname "$rel")"
  gcloud compute ssh "$DST_VM" \
    --tunnel-through-iap \
    --zone="$ZONE" \
    --project="$PROJECT_ID" \
    --command="
      set -euo pipefail
      APP=~/$APP_SUBPATH
      STAGE=\$APP/$STAGE_REL
      mkdir -p \$APP/$rel
      if command -v rsync >/dev/null 2>&1; then
        rsync -a --delete \$STAGE/$rel/ \$APP/$rel/
      else
        rm -rf \$APP/$rel
        mkdir -p \$APP/$parent
        cp -a \$STAGE/$rel \$APP/$rel
      fi
    "
done

for rel in "${SYNC_FILES[@]}"; do
  gcloud compute ssh "$DST_VM" \
    --tunnel-through-iap \
    --zone="$ZONE" \
    --project="$PROJECT_ID" \
    --command="
      set -euo pipefail
      APP=~/$APP_SUBPATH
      STAGE=\$APP/$STAGE_REL
      cp \$STAGE/$rel \$APP/$rel
    "
done

echo "▶ Validate JSON config on destination..."
gcloud compute ssh "$DST_VM" \
  --tunnel-through-iap \
  --zone="$ZONE" \
  --project="$PROJECT_ID" \
  --command="
    set -euo pipefail
    cd ~/$APP_SUBPATH
    python3 - <<'PY'
import json
from pathlib import Path
import sys

root = Path('.')
dirs = [
    Path('ui/data/_universal_agents'),
    Path('ui/data/_pipelines'),
    Path('ui/data/_notes_agents'),
    Path('ui/data/_persona_agents'),
]
errors = []
for d in dirs:
    if not d.exists():
        continue
    for f in sorted(d.glob('*.json')):
        try:
            json.loads(f.read_text(encoding='utf-8'))
        except Exception as e:
            errors.append(f'{f}: {e}')

folders = Path('ui/data/_pipelines_folders.json')
if folders.exists():
    try:
        val = json.loads(folders.read_text(encoding='utf-8'))
        if not isinstance(val, list):
            errors.append('ui/data/_pipelines_folders.json: expected list')
    except Exception as e:
        errors.append(f'ui/data/_pipelines_folders.json: {e}')

if errors:
    print('CONFIG VALIDATION FAILED:')
    for e in errors:
        print('-', e)
    sys.exit(1)

print('config validation ok')
PY
  "

echo "▶ Cleanup destination staging..."
gcloud compute ssh "$DST_VM" \
  --tunnel-through-iap \
  --zone="$ZONE" \
  --project="$PROJECT_ID" \
  --command="rm -rf ~/$APP_SUBPATH/$STAGE_REL"

if [[ "$RESTART" == "--restart" ]]; then
  echo "▶ Restart destination services..."
  gcloud compute ssh "$DST_VM" \
    --tunnel-through-iap \
    --zone="$ZONE" \
    --project="$PROJECT_ID" \
    --command="
      sudo systemctl restart shinobi-backend shinobi-frontend
      for i in \$(seq 1 60); do
        if curl -sf http://127.0.0.1:8000/health >/dev/null; then
          echo '  backend healthy ✓'
          exit 0
        fi
        sleep 1
      done
      echo '  backend health check timed out'
      exit 1
    "
fi

echo "✓ Config sync complete ($MODE)."
