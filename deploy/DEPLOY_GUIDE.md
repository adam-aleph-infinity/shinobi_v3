# Shinobi V3 Deployment Guide

## One-time GCP infra setup (run from Mac)

```bash
bash deploy/1_gcp_infra.sh shinobi.prod.aleph-infinity.com
```

Note the printed LB IP, then update DNS in Squarespace:
`shinobi.prod.aleph-infinity.com → <new IP>`

SSL cert provisions automatically once DNS propagates (10–60 min).

---

## One-time VM setup

### 1. SSH into the VM

```bash
gcloud compute ssh --tunnel-through-iap shinobi-v3-vm --zone=us-central1-a
```

### 2. Bootstrap the VM (run ON the VM)

The repo does not exist yet — download and run the setup script directly:

```bash
curl -fsSL https://raw.githubusercontent.com/adam-aleph-infinity/shinobi_v3/main/deploy/2_setup_vm.sh | bash
```

This installs system deps, clones the repo, builds the frontend, configures Nginx, and starts systemd services.

### 3. Upload secrets (run from Mac)

```bash
gcloud compute scp .env .env.crm shinobi-v3-vm:~/shinobi_v3/ --tunnel-through-iap --zone=us-central1-a
```

### 4. Restart backend after secrets are in place

```bash
gcloud compute ssh --tunnel-through-iap shinobi-v3-vm --zone=us-central1-a \
  --command="sudo systemctl restart shinobi-backend shinobi-frontend"
```

---

## Ongoing deploys (run from Mac)

```bash
bash deploy/deploy.sh
```

Pulls latest `main`, rebuilds frontend, restarts services.

### Development deploy (separate VM/domain)

```bash
bash deploy/deploy-dev.sh
```

Deploys/migrates Shinobi V3 to the dev stack:

- VM: `shinobi-vm`
- Domain: `shinobi.aleph-infinity.com` (IAP protected)

Production remains isolated on:

- VM: `shinobi-v3-vm`
- Domain: `shinobi.prod.aleph-infinity.com`

---

## Add IAP SSH access for a new user

```bash
bash deploy/add_iap_user.sh user@example.com
```

---

## Verify services on VM

```bash
sudo systemctl status shinobi-backend
sudo systemctl status shinobi-frontend
curl http://127.0.0.1:8000/health
```

---

## Key details

| Item | Value |
|------|-------|
| GCP Project | `shinobi-v2-prod` |
| VM | `shinobi-v3-vm` |
| Zone | `us-central1-a` |
| LB IP | `34.8.8.251` |
| Domain | `shinobi.prod.aleph-infinity.com` |
| Backend port | `8000` (uvicorn) |
| Frontend port | `3000` (Next.js standalone) |
| DB | `~/shinobi_v3/ui/database/shinobi.db` |
| Secrets | `.env`, `.env.crm` (not in repo — SCP from Mac) |
