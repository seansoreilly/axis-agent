#!/usr/bin/env bash
set -euo pipefail

SSH_KEY="$HOME/.ssh/claude-code-agent-key.pem"
REMOTE_HOST="${DEPLOY_HOST:-ubuntu@claude-code-agent}"
REMOTE_DIR="/home/ubuntu/agent"

SYNC_SECRETS=false
DRY_RUN=false
for arg in "$@"; do
  [[ "$arg" == "--sync-secrets" ]] && SYNC_SECRETS=true
  [[ "$arg" == "--dry-run" ]] && DRY_RUN=true
done

# Pre-deploy: pull agent-created files from instance (additive only)
echo "Pulling agent-created files from instance..."
rsync -avz \
  --exclude node_modules \
  --exclude dist \
  --exclude .env \
  --exclude .git \
  --exclude logs \
  --exclude '__pycache__' \
  --exclude memories.json \
  --exclude store.json \
  --exclude '*.json.bak' \
  --ignore-existing \
  -e "ssh -i $SSH_KEY" \
  "$REMOTE_HOST:$REMOTE_DIR/" ./

# Warn about new untracked files
NEW_FILES=$(git status --short --porcelain | grep '^??' || true)
if [[ -n "$NEW_FILES" ]]; then
  echo ""
  echo "⚠  New files pulled from instance:"
  echo "$NEW_FILES"
  echo "Consider committing these before deploying."
  echo ""
fi

if $DRY_RUN; then
  echo "Dry run — previewing what rsync would sync/delete..."
  rsync -avzn --delete \
    --exclude node_modules \
    --exclude .env \
    --exclude .git \
    --exclude logs \
    -e "ssh -i $SSH_KEY" \
    ./ "$REMOTE_HOST:$REMOTE_DIR/"
  echo "Dry run complete. No changes made."
  exit 0
fi

echo "Building locally..."
npm run build

echo "Syncing to Lightsail..."
rsync -avz --delete \
  --exclude node_modules \
  --exclude .env \
  --exclude .git \
  --exclude logs \
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
