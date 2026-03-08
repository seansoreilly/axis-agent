#!/usr/bin/env bash
set -euo pipefail

SSH_KEY="$HOME/.ssh/claude-code-agent-key.pem"
REMOTE_HOST="${DEPLOY_HOST:-ubuntu@claude-code-agent}"
REMOTE_DIR="/home/ubuntu/agent"
SELF_HEAL_MAX=2
SELF_HEAL_ATTEMPT_FILE="/tmp/claude-agent-deploy-attempt"

# Send a Telegram message to the first allowed user (for alerts)
notify_telegram() {
  local message="$1"
  local bot_token admin_chat_id
  bot_token=$(ssh $SSH_OPTS "$REMOTE_HOST" "grep -oP 'TELEGRAM_BOT_TOKEN=\K.*' /home/ubuntu/agent/.env" 2>/dev/null || echo "")
  admin_chat_id=$(ssh $SSH_OPTS "$REMOTE_HOST" "grep -oP 'TELEGRAM_ALLOWED_USERS=\K[^,]+' /home/ubuntu/agent/.env" 2>/dev/null || echo "")
  if [ -n "$bot_token" ] && [ -n "$admin_chat_id" ]; then
    curl -sf "https://api.telegram.org/bot${bot_token}/sendMessage" \
      -d "chat_id=${admin_chat_id}" \
      -d "text=${message}" \
      -d "parse_mode=HTML" >/dev/null 2>&1 || echo "WARNING: Failed to send Telegram alert"
  else
    echo "WARNING: Could not read bot token or admin chat ID for Telegram alert"
  fi
}

SSH_OPTS="-i $SSH_KEY -o ConnectTimeout=10 -o BatchMode=yes"

SYNC_SECRETS=false
DRY_RUN=false
SELF_HEAL=false
for arg in "$@"; do
  [[ "$arg" == "--sync-secrets" ]] && SYNC_SECRETS=true
  [[ "$arg" == "--dry-run" ]] && DRY_RUN=true
  [[ "$arg" == "--self-heal" ]] && SELF_HEAL=true
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
ssh -i "$SSH_KEY" "$REMOTE_HOST" "cd $REMOTE_DIR && npm install --omit=dev && npm ls @livekit/rtc-node-linux-x64-gnu 2>/dev/null || npm install @livekit/rtc-node-linux-x64-gnu@0.13.24 --no-save 2>/dev/null || true"

echo "Installing systemd service..."
ssh -i "$SSH_KEY" "$REMOTE_HOST" "sudo cp $REMOTE_DIR/systemd/claude-agent.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable claude-agent && sudo systemctl restart claude-agent"

if $SYNC_SECRETS; then
  echo "Syncing secrets from Bitwarden..."
  bash scripts/sync-secrets.sh
fi

echo "Checking status..."
ssh -i "$SSH_KEY" "$REMOTE_HOST" "sudo systemctl status claude-agent --no-pager"

# --- Post-deploy regression checks ---
echo ""
echo "Running post-deploy regression checks..."

# Give the service a moment to fully start up
sleep 3

CHECK_OUTPUT=$(REPORT_MODE=1 bash scripts/post-deploy-check.sh 2>&1) || true
echo "$CHECK_OUTPUT"

# Extract failure count from output
FAIL_COUNT=$(echo "$CHECK_OUTPUT" | grep -oP '^\d+(?= check\(s\) failed)' || echo "0")

if [ "$FAIL_COUNT" -eq 0 ]; then
  # Success — reset attempt counter
  rm -f "$SELF_HEAL_ATTEMPT_FILE"
  echo "Deploy complete."
  exit 0
fi

# --- Self-heal logic ---
if ! $SELF_HEAL; then
  echo ""
  echo "Post-deploy checks failed. Re-run with --self-heal to auto-fix."
  exit 1
fi

# Track attempt count to prevent infinite loops
ATTEMPT=1
if [ -f "$SELF_HEAL_ATTEMPT_FILE" ]; then
  ATTEMPT=$(cat "$SELF_HEAL_ATTEMPT_FILE")
  ATTEMPT=$((ATTEMPT + 1))
fi
echo "$ATTEMPT" > "$SELF_HEAL_ATTEMPT_FILE"

if [ "$ATTEMPT" -gt "$SELF_HEAL_MAX" ]; then
  echo ""
  echo "Self-heal exhausted ($SELF_HEAL_MAX attempts). Sending Telegram alert..."
  rm -f "$SELF_HEAL_ATTEMPT_FILE"
  notify_telegram "Deploy self-heal failed after $SELF_HEAL_MAX attempts. Manual intervention needed.\n\n$CHECK_OUTPUT"
  exit 1
fi

echo ""
echo "Self-heal attempt $ATTEMPT/$SELF_HEAL_MAX..."

# Extract failure details for the agent prompt
FAIL_LINES=$(echo "$CHECK_OUTPUT" | grep "FAIL:" || echo "unknown failure")
LOG_LINES=$(echo "$CHECK_OUTPUT" | sed -n '/Recent service logs:/,$ p' | tail -25 || echo "no logs captured")

# Try webhook first (gateway may be up even if other checks failed)
SSH_OPTS="-i $SSH_KEY -o ConnectTimeout=10 -o BatchMode=yes"
GATEWAY_UP=$(ssh $SSH_OPTS "$REMOTE_HOST" "curl -sf http://localhost:8080/health 2>/dev/null" || echo "")

HEAL_PROMPT="Post-deploy regression checks failed (attempt $ATTEMPT/$SELF_HEAL_MAX). Diagnose and fix the issue, then redeploy using: cd /home/ubuntu/agent && bash scripts/deploy-self.sh

Failed checks:
$FAIL_LINES

Recent service logs:
$LOG_LINES

Do NOT modify deploy.sh or post-deploy-check.sh. Focus on fixing the root cause (config, code, dependencies, systemd unit, etc)."

if [ -n "$GATEWAY_UP" ]; then
  echo "Gateway is up — sending fix request via webhook..."
  # Build JSON payload locally, send via SSH
  HEAL_JSON=$(python3 -c "import sys,json; print(json.dumps({'prompt': sys.stdin.read()}))" <<< "$HEAL_PROMPT")
  WEBHOOK_RESULT=$(echo "$HEAL_JSON" | ssh $SSH_OPTS "$REMOTE_HOST" \
    "curl -sf -X POST http://localhost:8080/webhook -H 'Content-Type: application/json' -d @- 2>/dev/null" \
    || echo "WEBHOOK_FAILED")

  if [ "$WEBHOOK_RESULT" != "WEBHOOK_FAILED" ]; then
    echo "Self-heal request sent via webhook. The agent will attempt to fix and redeploy."
    echo "Deploy complete (pending self-heal)."
    exit 0
  fi
  echo "Webhook call failed, falling back to Telegram alert..."
fi

# Fallback: send Telegram message
echo "Sending failure details to Telegram..."
notify_telegram "Deploy check failed (attempt $ATTEMPT/$SELF_HEAL_MAX):\n\n$FAIL_LINES\n\nPlease investigate. Run: DEPLOY_HOST=\"$REMOTE_HOST\" ./deploy.sh --self-heal"
echo "Deploy complete (alert sent)."
exit 1
