#!/usr/bin/env bash
# Rollback: restores server secrets from a local backup directory.
# Usage: bash scripts/rollback-secrets.sh /path/to/backup/dir
set -euo pipefail

BACKUP_DIR="${1:?Usage: bash scripts/rollback-secrets.sh <backup-dir>}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/claude-code-agent-key.pem}"
REMOTE_HOST="${DEPLOY_HOST:-ubuntu@REDACTED_SERVER_IP}"
REMOTE_AGENT_DIR="/home/ubuntu/agent"
REMOTE_CLAUDE_DIR="/home/ubuntu/.claude-agent"

if [ ! -d "$BACKUP_DIR" ]; then
  echo "Error: backup directory not found: $BACKUP_DIR"
  exit 1
fi

echo "Restoring secrets from: $BACKUP_DIR"

restore_file() {
  local local_file="$1" remote_path="$2"
  if [ -f "$local_file" ]; then
    scp -i "$SSH_KEY" "$local_file" "$REMOTE_HOST:$remote_path"
    ssh -i "$SSH_KEY" "$REMOTE_HOST" "chmod 600 '$remote_path'"
    echo "  -> $(basename "$local_file") -> $remote_path"
  else
    echo "  (skipped: $(basename "$local_file") not in backup)"
  fi
}

restore_file "$BACKUP_DIR/env"                        "$REMOTE_AGENT_DIR/.env"
restore_file "$BACKUP_DIR/gmail_app_password.json"    "$REMOTE_AGENT_DIR/gmail_app_password.json"
restore_file "$BACKUP_DIR/facebook-page-token.json"   "$REMOTE_CLAUDE_DIR/facebook-page-token.json"
restore_file "$BACKUP_DIR/google-service-account.json" "$REMOTE_CLAUDE_DIR/google-service-account.json"
restore_file "$BACKUP_DIR/google-credentials.json"    "$REMOTE_CLAUDE_DIR/google-credentials.json"

echo ""
echo "Secrets restored. Restart the service:"
echo "  ssh -i $SSH_KEY $REMOTE_HOST 'sudo systemctl restart claude-agent'"
