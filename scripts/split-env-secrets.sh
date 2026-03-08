#!/usr/bin/env bash
# One-time migration: splits the monolithic `env-secrets` Bitwarden entry
# into individual secure notes (one per secret key).
#
# Prerequisites:
#   - `bw` CLI installed and logged in
#   - Existing `env-secrets` entry in the `claude-agent-lightsail` folder
#
# Usage: bash scripts/split-env-secrets.sh
#   Or: BW_SESSION=... bash scripts/split-env-secrets.sh  (skip interactive unlock)
set -euo pipefail

FOLDER_NAME="claude-agent-lightsail"

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

# Authenticate / unlock Bitwarden
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
echo "Using folder: $FOLDER_NAME (id: $FOLDER_ID)"

# Find and read the existing env-secrets entry
echo ""
echo "==> Reading existing env-secrets entry..."
ENV_SECRETS_CONTENT=$(bw list items --search "env-secrets" --folderid "$FOLDER_ID" \
  | jq -r '.[] | select(.name=="env-secrets") | .notes')

if [ -z "$ENV_SECRETS_CONTENT" ] || [ "$ENV_SECRETS_CONTENT" = "null" ]; then
  echo "ERROR: Could not find 'env-secrets' entry in folder '$FOLDER_NAME'." >&2
  exit 1
fi

echo "  Found env-secrets. Parsing key=value pairs..."

# Parse each KEY=VALUE line and create individual entries
echo ""
echo "==> Creating individual secure notes..."
CREATED=0
SKIPPED=0

while IFS='=' read -r key value; do
  # Skip empty lines and comments
  [ -z "$key" ] && continue
  [[ "$key" =~ ^# ]] && continue

  # Look up the Bitwarden item name
  bw_name="${NAME_MAP[$key]:-}"
  if [ -z "$bw_name" ]; then
    echo "  WARN: No mapping for '$key', skipping"
    continue
  fi

  # Check if item already exists
  EXISTING=$(bw list items --search "$bw_name" --folderid "$FOLDER_ID" \
    | jq -r ".[] | select(.name==\"$bw_name\") | .id" 2>/dev/null || true)
  if [ -n "$EXISTING" ]; then
    echo "  SKIPPED: '$bw_name' already exists (id: $EXISTING)"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  # Create secure note with just the raw value
  ITEM_JSON=$(jq -n \
    --arg name "$bw_name" \
    --arg notes "$value" \
    --arg folderId "$FOLDER_ID" \
    '{type: 2, secureNote: {type: 0}, name: $name, notes: $notes, folderId: $folderId}')

  RESULT=$(echo "$ITEM_JSON" | bw encode | bw create item)
  ITEM_ID=$(echo "$RESULT" | jq -r '.id')
  echo "  Created: '$bw_name' (id: $ITEM_ID)"
  CREATED=$((CREATED + 1))
done <<< "$ENV_SECRETS_CONTENT"

echo ""
echo "==> Done. Created: $CREATED, Skipped: $SKIPPED"
echo ""
echo "Next steps:"
echo "  1. Verify entries: bw list items --folderid $FOLDER_ID | jq '.[].name'"
echo "  2. Test sync: bash scripts/sync-secrets.sh"
echo "  3. Once verified, optionally delete the old 'env-secrets' entry"

bw lock
echo "Vault locked."
