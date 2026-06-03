#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

mkdir -p work/app-data

if [[ -f work/app-data/server.pid ]] && kill -0 "$(cat work/app-data/server.pid)" 2>/dev/null; then
  kill "$(cat work/app-data/server.pid)" || true
fi

if [[ -f work/app-data/tunnel.pid ]] && kill -0 "$(cat work/app-data/tunnel.pid)" 2>/dev/null; then
  kill "$(cat work/app-data/tunnel.pid)" || true
fi

nohup npm start > work/app-data/server.log 2>&1 &
echo "$!" > work/app-data/server.pid

for _ in {1..30}; do
  if curl -fsS http://127.0.0.1:4173/api/status >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ! curl -fsS http://127.0.0.1:4173/api/status >/dev/null 2>&1; then
  echo "Local server did not start. Check work/app-data/server.log"
  exit 1
fi

nohup npx --yes localtunnel --port 4173 --local-host 127.0.0.1 > work/app-data/tunnel.log 2>&1 &
echo "$!" > work/app-data/tunnel.pid

for _ in {1..30}; do
  if grep -q "your url is:" work/app-data/tunnel.log; then
    grep "your url is:" work/app-data/tunnel.log | tail -1
    exit 0
  fi
  sleep 1
done

echo "Tunnel started, but no URL was printed yet. Check work/app-data/tunnel.log"
