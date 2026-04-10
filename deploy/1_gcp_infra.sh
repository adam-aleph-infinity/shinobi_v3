#!/bin/bash
set -euo pipefail

PROJECT_ID="shinobi-v2-prod"
ZONE="us-central1-a"
REGION="us-central1"
VM_NAME="shinobi-vm"
DOMAIN="${1:-shinobi.prod.aleph-infinity.com}"

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
gcloud compute addresses create shinobi-ip --global || true

echo "▶ Creating SSL certificate..."
gcloud compute ssl-certificates create shinobi-cert \
  --domains=$DOMAIN --global || true

echo "▶ Creating instance group..."
gcloud compute instance-groups unmanaged create shinobi-group --zone=$ZONE || true
gcloud compute instance-groups unmanaged add-instances shinobi-group \
  --instances=$VM_NAME --zone=$ZONE || true

echo "▶ Creating named port..."
gcloud compute instance-groups unmanaged set-named-ports shinobi-group \
  --named-ports=http:80 --zone=$ZONE

echo "▶ Creating health check..."
gcloud compute health-checks create http shinobi-health \
  --request-path=/api/health --port=80 || true

echo "▶ Creating backend service..."
gcloud compute backend-services create shinobi-backend-svc \
  --protocol=HTTP --port-name=http --health-checks=shinobi-health --global || true
gcloud compute backend-services add-backend shinobi-backend-svc \
  --instance-group=shinobi-group \
  --instance-group-zone=$ZONE --global || true

echo "▶ Creating URL map + HTTPS proxy + forwarding rule..."
gcloud compute url-maps create shinobi-map \
  --default-service=shinobi-backend-svc || true
gcloud compute target-https-proxies create shinobi-https-proxy \
  --url-map=shinobi-map --ssl-certificates=shinobi-cert || true
IP=$(gcloud compute addresses describe shinobi-ip --global --format='value(address)')
gcloud compute forwarding-rules create shinobi-https-rule \
  --address=$IP --global --target-https-proxy=shinobi-https-proxy --ports=443 || true

echo ""
echo "✓ Infrastructure ready."
echo "  Load balancer IP: $IP"
echo "  Point your DNS A record: $DOMAIN → $IP"
echo "  SSL cert provisioning takes 10-60 min after DNS propagates."
echo ""
echo "Next steps:"
echo "  1. Point DNS: $DOMAIN → $IP"
echo "  2. SSH into VM:"
echo "     gcloud compute ssh --tunnel-through-iap $VM_NAME --zone=$ZONE"
echo "  3. On VM, run: bash ~/shinobi_v3/deploy/2_setup_vm.sh"
echo "  4. From Mac, upload secrets:"
echo "     gcloud compute scp .env .env.crm $VM_NAME:~/shinobi_v3/ --tunnel-through-iap --zone=$ZONE"
