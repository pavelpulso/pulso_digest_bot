#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

if [ -f .deploy.env ]; then
  set -a
  source .deploy.env
  set +a
fi

if [ -z "$DEPLOY_SSH" ] || [ -z "$DEPLOY_PATH" ]; then
  echo "Set DEPLOY_SSH and DEPLOY_PATH (in .deploy.env or env)."
  echo "Example: cp .deploy.env.example .deploy.env && edit .deploy.env"
  exit 1
fi

echo "Deploying via SSH to $DEPLOY_SSH..."
ssh "$DEPLOY_SSH" "cd $DEPLOY_PATH && ./deploy.sh"
echo "Done."
