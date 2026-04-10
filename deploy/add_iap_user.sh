#!/bin/bash
# Grant a user IAP SSH access to the VM.
# Usage: bash deploy/add_iap_user.sh user@example.com
set -euo pipefail

PROJECT_ID="shinobi-v2-prod"
VM_NAME="shinobi-v3-vm"
ZONE="us-central1-a"
USER_EMAIL="${1:-}"

if [[ -z "$USER_EMAIL" ]]; then
  echo "Usage: bash deploy/add_iap_user.sh user@example.com"
  exit 1
fi

echo "▶ Granting IAP SSH access to $USER_EMAIL..."
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="user:$USER_EMAIL" \
  --role="roles/iap.tunnelResourceAccessor"

gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="user:$USER_EMAIL" \
  --role="roles/compute.osLogin"

echo "✓ Done. $USER_EMAIL can now SSH via:"
echo "  gcloud compute ssh --tunnel-through-iap $VM_NAME --zone=$ZONE --project=$PROJECT_ID"
