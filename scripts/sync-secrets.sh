#!/usr/bin/env bash
# Fetch secrets from Bitwarden vault and push to server via SCP.
# Runs locally (not on the server). Master password never leaves this machine.
#
# Usage: bash scripts/sync-secrets.sh
#   Or: BW_SESSION=... bash scripts/sync-secrets.sh  (skip interactive login)
set -euo pipefail

SSH_KEY="${SSH_KEY:-$HOME/.ssh/claude-code-agent-key.pem}"
REMOTE_HOST="${DEPLOY_HOST:?Set DEPLOY_HOST env var (e.g. ubuntu@<server-ip>)}"
REMOTE_AGENT_DIR="/home/ubuntu/agent"
REMOTE_CLAUDE_DIR="/home/ubuntu/.claude-agent"
FOLDER_NAME="claude-agent-lightsail"

# Bitwarden item IDs for JSON credential files
BW_GMAIL_ID="${BW_GMAIL_ID:?Set BW_GMAIL_ID env var}"
BW_FACEBOOK_ID="${BW_FACEBOOK_ID:?Set BW_FACEBOOK_ID env var}"
BW_GOOGLE_SA_ID="${BW_GOOGLE_SA_ID:?Set BW_GOOGLE_SA_ID env var}"
BW_GOOGLE_CREDS_ID="${BW_GOOGLE_CREDS_ID:?Set BW_GOOGLE_CREDS_ID env var}"
BW_GOOGLE_CONTACTS_TOKEN_ID="${BW_GOOGLE_CONTACTS_TOKEN_ID:-}"
BW_CLAUDE_OAUTH_ID="${BW_CLAUDE_OAUTH_ID:-}"

# Env var name → Bitwarden item name (looked up by name in folder)
declare -A SECRET_MAP=(
  [TELEGRAM_BOT_TOKEN]="telegram-bot-token"
  [TELEGRAM_ALLOWED_USERS]="telegram-allowed-users"
  [GH_TOKEN]="gh-token"
  [ICAL_URL]="ical-url"
  [GOOGLE_MAPS_API_KEY]="google-maps-api-key"
  [FACEBOOK_APP_ID]="facebook-app-id"
  [FACEBOOK_APP_SECRET]="facebook-app-secret"
  [FACEBOOK_PAGE_ID]="facebook-page-id"
  [FACEBOOK_PAGE_TOKEN]="facebook-page-token-env"
  [COMPOSIO_API_KEY]="composio-api-key"
  [TRELLO_API_KEY]="trello-api-key"
  [TRELLO_API_TOKEN]="trello-api-token"
  [OWNTRACKS_TOKEN]="owntracks-token"
  [VAPI_API_KEY]="vapi-api-key"
  [VAPI_PHONE_NUMBER_ID]="vapi-phone-number-id"
  [CARTESIA_VOICE_ID]="cartesia-voice-id"
)

# Authenticate / unlock Bitwarden (skip if BW_SESSION already set)
if [ -z "${BW_SESSION:-}" ]; then
  if ! bw login --check &>/dev/null; then
    echo "Logging in to Bitwarden..."
    export BW_SESSION=$(bw login --raw)
  else
    echo "Unlocking Bitwarden vault..."
    export BW_SESSION=$(bw unlock --raw)
  fi
fi
bw sync

# Find the folder ID
FOLDER_ID=$(bw list folders --search "$FOLDER_NAME" | jq -r ".[] | select(.name==\"$FOLDER_NAME\") | .id")
if [ -z "$FOLDER_ID" ]; then
  echo "ERROR: Folder '$FOLDER_NAME' not found in vault." >&2
  exit 1
fi

# Fetch all items in the folder once
echo "  Fetching all items from folder '$FOLDER_NAME'..."
FOLDER_ITEMS=$(bw list items --folderid "$FOLDER_ID")

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

# Helper: fetch from vault by ID and SCP to server with chmod 600
push_secret() {
  local item_id="$1" remote_path="$2" label="$3"
  local tmpfile="$TMPDIR/$(basename "$remote_path")"
  local content
  content=$(bw get notes "$item_id")
  if [ -z "$content" ]; then
    echo "  WARN: '$label' is empty in vault, skipping"
    return
  fi
  printf '%s\n' "$content" > "$tmpfile"
  scp -i "$SSH_KEY" "$tmpfile" "$REMOTE_HOST:$remote_path"
  ssh -i "$SSH_KEY" "$REMOTE_HOST" "chmod 600 '$remote_path'"
  echo "  -> $label -> $remote_path"
}

echo "Syncing secrets to $REMOTE_HOST..."

# 1. Env secrets: build KEY=VALUE lines from individual Bitwarden entries
echo "  Building env secrets from individual vault entries..."
ENV_SECRETS=""
MISSING=()

for env_var in "${!SECRET_MAP[@]}"; do
  bw_name="${SECRET_MAP[$env_var]}"
  value=$(echo "$FOLDER_ITEMS" | jq -r ".[] | select(.name==\"$bw_name\") | .notes" 2>/dev/null || true)
  if [ -z "$value" ] || [ "$value" = "null" ]; then
    MISSING+=("$env_var ($bw_name)")
    continue
  fi
  ENV_SECRETS="${ENV_SECRETS}${env_var}=${value}\n"
done

if [ ${#MISSING[@]} -gt 0 ]; then
  echo "  WARN: Missing vault entries:"
  for m in "${MISSING[@]}"; do
    echo "    - $m"
  done
fi

if [ -n "$ENV_SECRETS" ]; then
  # Build sed expression to remove existing secret key lines
  SED_EXPR=""
  for env_var in "${!SECRET_MAP[@]}"; do
    SED_EXPR="${SED_EXPR}/^${env_var}=/d;"
  done

  # On server: strip old secret lines from .env
  if [ -n "$SED_EXPR" ]; then
    ssh -i "$SSH_KEY" "$REMOTE_HOST" "sed -i '${SED_EXPR}' $REMOTE_AGENT_DIR/.env"
  fi

  # Append fresh secrets via stdin
  echo -e "$ENV_SECRETS" | ssh -i "$SSH_KEY" "$REMOTE_HOST" "cat >> $REMOTE_AGENT_DIR/.env && chmod 600 $REMOTE_AGENT_DIR/.env"
  echo "  -> env secrets -> $REMOTE_AGENT_DIR/.env (merged)"
else
  echo "  WARN: No env secrets found in vault, skipping .env merge"
fi

# 2. JSON credential files: full replacement
push_secret "$BW_GMAIL_ID"       "$REMOTE_AGENT_DIR/gmail_app_password.json"          "gmail"
push_secret "$BW_FACEBOOK_ID"    "$REMOTE_CLAUDE_DIR/facebook-page-token.json"        "facebook"
push_secret "$BW_GOOGLE_SA_ID"   "$REMOTE_CLAUDE_DIR/google-service-account.json"     "google-service-account"
push_secret "$BW_GOOGLE_CREDS_ID" "$REMOTE_CLAUDE_DIR/google-credentials.json"        "google-credentials"
if [ -n "$BW_GOOGLE_CONTACTS_TOKEN_ID" ]; then
  push_secret "$BW_GOOGLE_CONTACTS_TOKEN_ID" "$REMOTE_CLAUDE_DIR/google-contacts-token.json" "google-contacts-token"
fi
if [ -n "$BW_CLAUDE_OAUTH_ID" ]; then
  push_secret "$BW_CLAUDE_OAUTH_ID" "/home/ubuntu/.claude/.credentials.json" "claude-oauth"
fi

bw lock
echo ""
echo "Done. Vault locked."
