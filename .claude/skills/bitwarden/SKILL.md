---
name: bitwarden
description: Add, update, or rotate secrets in Bitwarden vault and sync to server
user_invocable: true
tags: [secrets, bitwarden, security]
---

# /bitwarden — Manage Secrets in Bitwarden Vault

When the user invokes `/bitwarden`, help them add, update, or rotate secrets stored in the Bitwarden vault.

## Prerequisites

- Bitwarden CLI (`bw`) must be installed locally: `npm install -g @bitwarden/cli`
- User must have access to the `claude-agent-lightsail` vault folder
- Master password is entered interactively — never store or log it

## Unlocking the Vault

The `BW_SESSION` token must be exported for all subsequent `bw` commands. Always unlock in a way that captures the session:

```bash
# Check current status first
bw status | jq -r '.status'  # "locked", "unlocked", or "unauthenticated"

# If locked (most common):
export BW_SESSION=$(bw unlock --raw)

# If unauthenticated (first time / logged out):
export BW_SESSION=$(bw login --raw)

# Verify it worked:
bw status | jq -r '.status'  # should be "unlocked"
```

**Critical:** Every `bw` command in a new shell/subshell needs `BW_SESSION` set. If you run `bw unlock --raw` without exporting, the session token is lost. When chaining commands, always use `--session "$BW_SESSION"` or export it first.

**Common mistake:** Running `bw unlock --raw` in a subshell (e.g. inside `$(...)` without export) means the parent shell doesn't have the session. Always `export`.

## Searching the Vault

```bash
# Search by name (partial match)
bw list items --search "gemini"

# Search within a specific folder
FOLDER_ID=$(bw list folders | jq -r '.[] | select(.name=="claude-agent-lightsail") | .id')
bw list items --folderid "$FOLDER_ID"

# Get a specific item's notes (where secret content lives)
bw get notes "$ITEM_ID"

# List all items in the vault folder with their IDs
bw list items --folderid "$FOLDER_ID" | jq '.[] | {id, name}'
```

## Vault Structure

All secrets are in the `claude-agent-lightsail` Bitwarden folder. Each item is a Secure Note with content in the Notes field.

| Item Name | Format | Server Destination |
|---|---|---|
| `env-secrets` | `KEY=value` pairs (one per line) | `/home/ubuntu/agent/.env` (merged) |
| `gmail` | JSON | `/home/ubuntu/agent/gmail_app_password.json` |
| `facebook` | JSON | `/home/ubuntu/.claude-agent/facebook-page-token.json` |
| `google-service-account` | JSON | `/home/ubuntu/.claude-agent/google-service-account.json` |
| `google-credentials` | JSON | `/home/ubuntu/.claude-agent/google-credentials.json` |
| `google-contacts-token` | JSON | `/home/ubuntu/.claude-agent/google-contacts-token.json` |

Item IDs are stored as env vars (`BW_ENV_SECRETS_ID`, `BW_GMAIL_ID`, `BW_FACEBOOK_ID`, `BW_GOOGLE_SA_ID`, `BW_GOOGLE_CREDS_ID`, `BW_GOOGLE_CONTACTS_TOKEN_ID`) — see `scripts/sync-secrets.sh`.

## Adding/Updating an env-secrets Key

To add or update a key in the `env-secrets` item (e.g. `ZAPIER_API_KEY`):

```bash
# 1. Unlock vault
export BW_SESSION=$(bw unlock --raw)

# 2. Get current content
CURRENT=$(bw get notes "$BW_ENV_SECRETS_ID")

# 3. Check if key already exists
echo "$CURRENT" | grep "^KEY_NAME="

# 4a. If key exists, replace it:
UPDATED=$(echo "$CURRENT" | sed "s|^KEY_NAME=.*|KEY_NAME=new_value|")

# 4b. If key is new, append it:
UPDATED=$(printf '%s\nKEY_NAME=new_value' "$CURRENT")

# 5. Update the vault item
bw get item "$BW_ENV_SECRETS_ID" \
  | jq --arg notes "$UPDATED" '.notes = $notes' \
  | bw encode \
  | bw edit item "$BW_ENV_SECRETS_ID"

# 6. Lock vault
bw lock
```

## Syncing to Server

After updating Bitwarden, sync secrets to the server:

```bash
bash scripts/sync-secrets.sh
```

Or as part of a deploy:

```bash
./deploy.sh --sync-secrets
```

The sync script merges `env-secrets` into the server's `.env` (replacing existing keys, appending new ones) and SCPs JSON credential files directly.

## Adding a New JSON Credential

To add a new credential file (not env var):

1. Create a new Secure Note in the `claude-agent-lightsail` folder in Bitwarden
2. Paste the JSON content into the Notes field
3. Copy the item ID from the Bitwarden URL or `bw list items --folderid <folder_id>`
4. Add a `push_secret` line to `scripts/sync-secrets.sh` with the item ID and destination path
5. Update `CLAUDE.md` secret management table

## Security Rules

- **Never** log, echo, or commit secret values
- **Never** store the master password in a file or env var (interactive entry only)
- **Always** lock the vault after operations (`bw lock`)
- **Always** use `chmod 600` on credential files on the server
- The `bw` CLI runs **locally only** — the master password never touches the server
