#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
# Load nvm or shell profile so npm/pm2 are in PATH when run via SSH
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh"
[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"
git pull origin main
npm ci --omit=dev
pm2 delete tg-digest-bot 2>/dev/null || true
pm2 start ecosystem.config.cjs --name tg-digest-bot
pm2 save
echo "Done."
