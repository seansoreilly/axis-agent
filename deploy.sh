#!/usr/bin/env bash
set -euo pipefail

SSH_KEY="$HOME/.ssh/claude-code-agent-key.pem"
REMOTE_HOST="${DEPLOY_HOST:-ubuntu@claude-code-agent}"
REMOTE_DIR="/home/ubuntu/agent"

SYNC_SECRETS=false
for arg in "$@"; do
  [[ "$arg" == "--sync-secrets" ]] && SYNC_SECRETS=true
done

echo "Building locally..."
npm run build

echo "Syncing to Lightsail..."
rsync -avz --delete \
  --exclude node_modules \
  --exclude .env \
  --exclude .git \
  -e "ssh -i $SSH_KEY" \
  ./ "$REMOTE_HOST:$REMOTE_DIR/"

echo "Installing dependencies on remote..."
ssh -i "$SSH_KEY" "$REMOTE_HOST" "cd $REMOTE_DIR && npm install --omit=dev"

echo "Installing systemd service..."
ssh -i "$SSH_KEY" "$REMOTE_HOST" "sudo cp $REMOTE_DIR/systemd/claude-agent.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable claude-agent && sudo systemctl restart claude-agent"

if $SYNC_SECRETS; then
  echo "Syncing secrets from Bitwarden..."
  bash scripts/sync-secrets.sh
fi

echo "Checking status..."
ssh -i "$SSH_KEY" "$REMOTE_HOST" "sudo systemctl status claude-agent --no-pager"

echo "Deploy complete."
