#!/bin/bash
# Run backend + frontend locally for development.
# Usage: bash dev.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"

# Check secrets
if [[ ! -f "$ROOT/.env" ]]; then
  echo "✗ Missing .env — copy from shinobi_v2 or the VM"
  exit 1
fi
if [[ ! -f "$ROOT/.env.crm" ]]; then
  echo "✗ Missing .env.crm — copy from shinobi_v2 or the VM"
  exit 1
fi

# Python venv
PYTHON=$(command -v python3.11 || command -v python3.12 || command -v python3 || true)
if [[ -z "$PYTHON" ]]; then
  echo "✗ No Python 3 found — install via: brew install python@3.12"
  exit 1
fi

if [[ ! -f "$ROOT/.venv/bin/uvicorn" ]]; then
  echo "▶ Creating venv ($($PYTHON --version))..."
  "$PYTHON" -m venv "$ROOT/.venv"
  source "$ROOT/.venv/bin/activate"
  pip install -r "$ROOT/requirements.txt" -q
else
  source "$ROOT/.venv/bin/activate"
fi

# Frontend deps
if [[ ! -d "$ROOT/ui/frontend/node_modules" ]]; then
  echo "▶ Installing frontend deps..."
  cd "$ROOT/ui/frontend"
  npm install --legacy-peer-deps -q
  cd "$ROOT"
fi

# Trap to kill both processes on exit
trap 'kill $(jobs -p) 2>/dev/null' EXIT

echo "▶ Starting backend on :8000..."
cd "$ROOT"
uvicorn ui.backend.main:app --host 127.0.0.1 --port 8000 --reload &

echo "▶ Starting frontend on :3000..."
cd "$ROOT/ui/frontend"
npm run dev &

echo ""
echo "✓ Shinobi V3 running locally"
echo "  http://localhost:3000"
echo ""
echo "Press Ctrl+C to stop."
wait
