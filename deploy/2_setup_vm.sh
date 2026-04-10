#!/bin/bash
# Run this script ON THE VM after SSHing in via IAP.
# gcloud compute ssh --tunnel-through-iap shinobi-v3-vm --zone=us-central1-a
set -euo pipefail

APP_DIR="/home/$USER/shinobi_v3"
REPO_URL="https://github.com/adam-aleph-infinity/shinobi_v3.git"
BRANCH="main"

echo "▶ System packages..."
export DEBIAN_FRONTEND=noninteractive
sudo apt-get update -qq
sudo -E apt-get install -y \
  python3.11 python3.11-venv python3-pip \
  nginx git curl ffmpeg screen build-essential \
  libsndfile1 libffi-dev libssl-dev

echo "▶ Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo -E apt-get install -y nodejs

echo "▶ Clone repo..."
git clone --branch $BRANCH $REPO_URL $APP_DIR
cd $APP_DIR

echo "▶ Python venv..."
python3.11 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip -q
pip install -r requirements.txt -q
pip install -r ui/backend/requirements.txt -q

echo "▶ Create data directories..."
mkdir -p ui/data/agents
mkdir -p ui/database
mkdir -p ui/data/_persona_agents
mkdir -p ui/data/_fpa_generator_presets
mkdir -p ui/data/_fpa_scorer_presets
mkdir -p ui/data/_comparison_presets

echo "▶ Frontend build..."
cd ui/frontend
npm install --legacy-peer-deps -q
npm run build
cp -r .next/static .next/standalone/.next/static
cp -r public .next/standalone/public
cd $APP_DIR

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
Description=Shinobi V3 FastAPI Backend
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
Description=Shinobi V3 Next.js Frontend
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

echo ""
echo "✓ VM setup complete."
echo ""
echo "Now upload secrets from your Mac:"
echo "  gcloud compute scp .env .env.crm shinobi-v3-vm:~/shinobi_v3/ --tunnel-through-iap --zone=us-central1-a"
echo ""
echo "Then verify:"
echo "  sudo systemctl status shinobi-backend"
echo "  sudo systemctl status shinobi-frontend"
echo "  curl http://127.0.0.1:8000/health"
