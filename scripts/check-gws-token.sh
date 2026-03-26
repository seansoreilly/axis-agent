#!/usr/bin/env bash
# Check if the gws OAuth token is valid.
# Used as a checkCommand for the gws-token-health scheduled task.
# - If token is valid: exits 0 with empty stdout (task skipped)
# - If token is invalid: exits 0 with error text on stdout (task runs)

CREDS="$HOME/.config/gws/credentials.json"

if [ ! -f "$CREDS" ]; then
  echo "gws credentials file not found at $CREDS"
  exit 0
fi

# Try a lightweight Gmail API call via gws
result=$(gws gmail users getProfile --params '{"userId":"me"}' 2>&1)

if echo "$result" | grep -q '"emailAddress"'; then
  # Token is valid — return empty stdout so the monitor task is skipped
  exit 0
else
  # Token is invalid — return error so the agent gets alerted
  echo "gws OAuth token is invalid or expired. Error: $result"
  exit 0
fi
