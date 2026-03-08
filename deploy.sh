#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

# Load nvm explicitly
export NVM_DIR="$HOME/.nvm"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  . "$NVM_DIR/nvm.sh"
  nvm use 20 >/dev/null 2>&1 || true
fi

# Fallback: try bashrc
[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"

git pull origin main
npm ci --omit=dev
pm2 restart tg-digest-bot || pm2 start ecosystem.config.cjs --name tg-digest-bot
pm2 save
echo "Done."
