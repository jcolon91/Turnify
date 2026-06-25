#!/usr/bin/env bash
# ============================================================================
#  Bukéame — DEPLOY seguro: pull, valida TODO el backend, reinicia y comprueba
#  salud. Aborta si node --check falla; avisa si /api/health no responde.
#
#  Uso (en el VPS, como deploy):  bash /var/www/bukeame/scripts/deploy.sh
# ============================================================================
set -euo pipefail

APP_DIR="/var/www/bukeame"
PM2_NAME="bukeame-api"
PORT="${BUKEAME_PORT:-3002}"

cd "$APP_DIR"

echo "→ git pull origin main"
git pull origin main

echo "→ node --check (todos los .js del backend)"
for f in backend/*.js; do node --check "$f"; done
echo "  ✓ sintaxis OK"

echo "→ reiniciando $PM2_NAME"
pm2 restart "$PM2_NAME" --update-env

echo "→ comprobando salud…"
sleep 3
if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null; then
  echo "✓ DEPLOY OK — /api/health responde"
else
  echo "✗ /api/health NO responde. Revisa:  pm2 logs $PM2_NAME --lines 40"
  exit 1
fi
