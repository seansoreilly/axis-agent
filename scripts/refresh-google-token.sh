#!/usr/bin/env bash
# Keep Google OAuth refresh token alive by making a lightweight API call.
# Runs via cron every 3 days. Google "testing" app tokens expire after 7 days
# of inactivity, so this provides a safety margin.
set -euo pipefail

LOG_TAG="google-token-refresh"
GWS_CREDS="$HOME/.config/gws/credentials.json"

if [ ! -f "$GWS_CREDS" ]; then
  logger -t "$LOG_TAG" "No gws credentials found at $GWS_CREDS, skipping"
  exit 0
fi

# Lightweight call — list 1 calendar entry to force token refresh
RESULT=$(gws calendar calendarList list --params '{"maxResults":1}' 2>&1) || true

if echo "$RESULT" | grep -q '"kind"'; then
  logger -t "$LOG_TAG" "Google token refreshed successfully"
else
  logger -t "$LOG_TAG" "Google token refresh failed: $RESULT"
  exit 1
fi
