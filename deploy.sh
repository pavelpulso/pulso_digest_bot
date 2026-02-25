#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
git pull origin main
npm ci --omit=dev
pm2 restart tg-digest-bot 2>/dev/null || pm2 start ecosystem.config.js --name tg-digest-bot
pm2 save
echo "Done."
