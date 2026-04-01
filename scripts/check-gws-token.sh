#!/usr/bin/env bash
# Check if the gws OAuth token is valid.
# Used as a checkCommand for the gws-token-health scheduled task.
# - If token is valid: exits 0 with empty stdout (task skipped)
# - If token is invalid: exits 0 with error text on stdout (task runs)

CREDS="$HOME/.config/gws/credentials.json"

if [ ! -f "$CREDS" ]; then
  echo "gws OAuth config is missing. Re-authentication required via /admin/gws-auth endpoint."
  exit 0
fi

# Check that the file contains OAuth user type, not a service account
cred_type=$(python3 -c "import json; print(json.load(open('$CREDS')).get('type',''))" 2>/dev/null)
if [ "$cred_type" != "authorized_user" ]; then
  echo "CRITICAL: gws OAuth config has wrong type '$cred_type' (expected 'authorized_user'). May have been overwritten with a service account key. Re-authentication required."
  exit 0
fi

# Verify refresh_token exists
has_refresh=$(python3 -c "import json; d=json.load(open('$CREDS')); print('yes' if d.get('refresh_token') else 'no')" 2>/dev/null)
if [ "$has_refresh" != "yes" ]; then
  echo "gws OAuth config is missing refresh_token. Re-authentication required."
  exit 0
fi

# Try a lightweight Gmail API call via gws
result=$(gws gmail users getProfile --params '{"userId":"me"}' 2>&1)

if echo "$result" | grep -q '"emailAddress"'; then
  # Token is valid — return empty stdout so the monitor task is skipped
  exit 0
else
  # Token is invalid — return a sanitised message (raw gws output may contain
  # file paths that trigger the sensitive-file policy and block the job).
  echo "gws OAuth token is invalid or expired. Notify the user to re-authenticate via the /admin/gws-auth gateway endpoint."
  exit 0
fi
