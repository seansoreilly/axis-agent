#!/usr/bin/env bash
# Refresh Claude OAuth access token before it expires.
# Runs independently via systemd timer — works even if the agent process is down.
# Refreshes if the token expires within the next 60 minutes.

set -euo pipefail

LOG_TAG="claude-token-refresh"
CREDENTIALS_FILE="$HOME/.claude/.credentials.json"
BUFFER_MS=3600000

if [ ! -f "$CREDENTIALS_FILE" ]; then
  logger -t "$LOG_TAG" "Credentials file not found: $CREDENTIALS_FILE"
  exit 1
fi

NEEDS_REFRESH=$(python3 -c "
import json, time, sys
creds = json.load(open('$CREDENTIALS_FILE'))
expires_at = creds['claudeAiOauth']['expiresAt']
needs = time.time() * 1000 >= expires_at - $BUFFER_MS
print('yes' if needs else 'no')
" 2>/dev/null) || { logger -t "$LOG_TAG" "Failed to read credentials"; exit 1; }

if [ "$NEEDS_REFRESH" = "no" ]; then
  exit 0
fi

logger -t "$LOG_TAG" "Token expiring soon, refreshing..."

RESULT=$(python3 /home/ubuntu/agent/scripts/refresh-token.py 2>&1) || true

if [[ "$RESULT" == OK:* ]]; then
  logger -t "$LOG_TAG" "$RESULT"
else
  logger -t "$LOG_TAG" "Token refresh failed: $RESULT"
  exit 1
fi
