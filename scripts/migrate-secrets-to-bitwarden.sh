#!/usr/bin/env bash
# One-time migration: reads secrets from server, creates Bitwarden vault items.
# Run locally (not on the server). Requires: bw CLI installed.
#
# Usage: bash scripts/migrate-secrets-to-bitwarden.sh
#
# Creates a backup of all server secrets before migration for rollback.
set -euo pipefail

SSH_KEY="${SSH_KEY:-$HOME/.ssh/claude-code-agent-key.pem}"
REMOTE_HOST="${DEPLOY_HOST:?Set DEPLOY_HOST env var (e.g. ubuntu@<server-ip>)}"
REMOTE_AGENT_DIR="/home/ubuntu/agent"
REMOTE_CLAUDE_DIR="/home/ubuntu/.claude-agent"
FOLDER_NAME="claude-agent-lightsail"
BACKUP_DIR="$HOME/.claude-agent-backup-$(date +%Y%m%d-%H%M%S)"

# Secret env var names to extract from .env (everything else is config)
SECRET_KEYS=(
  TELEGRAM_BOT_TOKEN
  TELEGRAM_ALLOWED_USERS
  GH_TOKEN
  ICAL_URL
  GOOGLE_MAPS_API_KEY
  FACEBOOK_APP_ID
  FACEBOOK_APP_SECRET
  FACEBOOK_PAGE_ID
  FACEBOOK_PAGE_TOKEN
  COMPOSIO_API_KEY
  TRELLO_API_KEY
  TRELLO_API_TOKEN
  OWNTRACKS_TOKEN
  LIVEKIT_URL
  LIVEKIT_API_KEY
  LIVEKIT_API_SECRET
  LIVEKIT_SIP_TRUNK_ID
  CARTESIA_VOICE_ID
)

# Env var name → Bitwarden item name (kebab-case)
declare -A NAME_MAP=(
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
  [LIVEKIT_URL]="livekit-url"
  [LIVEKIT_API_KEY]="livekit-api-key"
  [LIVEKIT_API_SECRET]="livekit-api-secret"
  [LIVEKIT_SIP_TRUNK_ID]="livekit-sip-trunk-id"
  [CARTESIA_VOICE_ID]="cartesia-voice-id"
)

echo "==> Step 1: Backing up server secrets locally to $BACKUP_DIR"
mkdir -p "$BACKUP_DIR"

scp -i "$SSH_KEY" "$REMOTE_HOST:$REMOTE_AGENT_DIR/.env" "$BACKUP_DIR/env" 2>/dev/null || echo "  (no .env found)"
scp -i "$SSH_KEY" "$REMOTE_HOST:$REMOTE_AGENT_DIR/gmail_app_password.json" "$BACKUP_DIR/" 2>/dev/null || echo "  (no gmail_app_password.json found)"
scp -i "$SSH_KEY" "$REMOTE_HOST:$REMOTE_CLAUDE_DIR/facebook-page-token.json" "$BACKUP_DIR/" 2>/dev/null || echo "  (no facebook-page-token.json found)"
scp -i "$SSH_KEY" "$REMOTE_HOST:$REMOTE_CLAUDE_DIR/google-service-account.json" "$BACKUP_DIR/" 2>/dev/null || echo "  (no google-service-account.json found)"
scp -i "$SSH_KEY" "$REMOTE_HOST:$REMOTE_CLAUDE_DIR/google-credentials.json" "$BACKUP_DIR/" 2>/dev/null || echo "  (no google-credentials.json found)"

chmod 600 "$BACKUP_DIR"/*
echo "  Backup saved to: $BACKUP_DIR"
echo "  To rollback, run: bash scripts/rollback-secrets.sh $BACKUP_DIR"

echo ""
echo "==> Step 2: Extracting secret env vars from server .env"
ENV_SECRETS=""
if [ -f "$BACKUP_DIR/env" ]; then
  for key in "${SECRET_KEYS[@]}"; do
    line=$(grep "^${key}=" "$BACKUP_DIR/env" 2>/dev/null || true)
    if [ -n "$line" ]; then
      ENV_SECRETS="${ENV_SECRETS}${line}\n"
      echo "  Found: $key"
    else
      echo "  Missing: $key (skipped)"
    fi
  done
fi
# Remove trailing \n
ENV_SECRETS=$(echo -e "$ENV_SECRETS" | sed '/^$/d')

echo ""
echo "==> Step 3: Authenticating with Bitwarden"
if ! bw login --check &>/dev/null; then
  echo "  Logging in..."
  export BW_SESSION=$(bw login --raw)
else
  echo "  Already logged in, unlocking..."
  export BW_SESSION=$(bw unlock --raw)
fi
bw sync

echo ""
echo "==> Step 4: Creating folder '$FOLDER_NAME'"
EXISTING_FOLDER=$(bw list folders --search "$FOLDER_NAME" | jq -r ".[] | select(.name==\"$FOLDER_NAME\") | .id" 2>/dev/null || true)
if [ -n "$EXISTING_FOLDER" ]; then
  FOLDER_ID="$EXISTING_FOLDER"
  echo "  Folder already exists (id: $FOLDER_ID)"
else
  FOLDER_ID=$(bw create folder "$(echo "{\"name\":\"$FOLDER_NAME\"}" | bw encode)" | jq -r '.id')
  echo "  Created folder (id: $FOLDER_ID)"
fi

echo ""
echo "==> Step 5: Creating Secure Notes"

create_note() {
  local item_name="$1"
  local notes_content="$2"

  # Check if item already exists
  EXISTING=$(bw list items --search "$item_name" --folderid "$FOLDER_ID" | jq -r ".[] | select(.name==\"$item_name\") | .id" 2>/dev/null || true)
  if [ -n "$EXISTING" ]; then
    echo "  SKIPPED: '$item_name' already exists (id: $EXISTING). Delete it first to re-create."
    return
  fi

  # Create secure note (type 2 = secure note)
  ITEM_JSON=$(jq -n \
    --arg name "$item_name" \
    --arg notes "$notes_content" \
    --arg folderId "$FOLDER_ID" \
    '{type: 2, secureNote: {type: 0}, name: $name, notes: $notes, folderId: $folderId}')

  RESULT=$(echo "$ITEM_JSON" | bw encode | bw create item)
  ITEM_ID=$(echo "$RESULT" | jq -r '.id')
  echo "  Created: '$item_name' (id: $ITEM_ID)"
}

# Individual env secret entries (one per key)
if [ -n "$ENV_SECRETS" ]; then
  while IFS='=' read -r key value; do
    [ -z "$key" ] && continue
    bw_name="${NAME_MAP[$key]:-}"
    if [ -z "$bw_name" ]; then
      echo "  WARN: No mapping for '$key', skipping"
      continue
    fi
    create_note "$bw_name" "$value"
  done <<< "$ENV_SECRETS"
else
  echo "  SKIPPED: env secrets (no secret env vars found)"
fi

# JSON credential files
for file_pair in \
  "gmail:$BACKUP_DIR/gmail_app_password.json" \
  "facebook:$BACKUP_DIR/facebook-page-token.json" \
  "google-service-account:$BACKUP_DIR/google-service-account.json" \
  "google-credentials:$BACKUP_DIR/google-credentials.json"; do

  name="${file_pair%%:*}"
  filepath="${file_pair#*:}"

  if [ -f "$filepath" ]; then
    content=$(cat "$filepath")
    create_note "$name" "$content"
  else
    echo "  SKIPPED: '$name' (file not found: $filepath)"
  fi
done

echo ""
echo "==> Step 6: Fixing server file permissions"
ssh -i "$SSH_KEY" "$REMOTE_HOST" "chmod 600 $REMOTE_CLAUDE_DIR/google-credentials.json $REMOTE_CLAUDE_DIR/google-service-account.json 2>/dev/null" || true
echo "  Set chmod 600 on google JSON files"

echo ""
echo "==> Step 7: Locking vault"
bw lock
echo "  Vault locked."

echo ""
echo "=== Migration complete ==="
echo "Backup: $BACKUP_DIR"
echo "Next: run 'bash scripts/sync-secrets.sh' to verify round-trip"
