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

## Vault Structure

All secrets are in the `claude-agent-lightsail` Bitwarden folder. Each item is a Secure Note with content in the Notes field.

**Env var secrets** — each stored as an individual secure note (raw value only, no `KEY=`):

| Item Name | Env Var |
|---|---|
| `telegram-bot-token` | `TELEGRAM_BOT_TOKEN` |
| `telegram-allowed-users` | `TELEGRAM_ALLOWED_USERS` |
| `gh-token` | `GH_TOKEN` |
| `ical-url` | `ICAL_URL` |
| `google-maps-api-key` | `GOOGLE_MAPS_API_KEY` |
| `facebook-app-id` | `FACEBOOK_APP_ID` |
| `facebook-app-secret` | `FACEBOOK_APP_SECRET` |
| `facebook-page-id` | `FACEBOOK_PAGE_ID` |
| `facebook-page-token-env` | `FACEBOOK_PAGE_TOKEN` |
| `composio-api-key` | `COMPOSIO_API_KEY` |
| `trello-api-key` | `TRELLO_API_KEY` |
| `trello-api-token` | `TRELLO_API_TOKEN` |
| `owntracks-token` | `OWNTRACKS_TOKEN` |
| `gateway-api-token` | `GATEWAY_API_TOKEN` |
| `retell-api-key` | `RETELL_API_KEY` |
| `retell-agent-id` | `RETELL_AGENT_ID` |
| `retell-phone-number` | `RETELL_PHONE_NUMBER` |

**JSON credential files** — fetched by item ID:

| Item Name | Server Destination |
|---|---|
| `gmail` | `/home/ubuntu/agent/gmail_app_password.json` |
| `facebook` | `/home/ubuntu/.claude-agent/facebook-page-token.json` |
| `google-service-account` | `/home/ubuntu/.claude-agent/google-service-account.json` |
| `google-credentials` | `/home/ubuntu/.claude-agent/google-credentials.json` |
| `claude-code-admin-key` | Not synced (local use only via `/claude-admin` skill) |

JSON credential file IDs are stored as env vars (`BW_GMAIL_ID`, etc.) — see `scripts/sync-secrets.sh`.

## Adding/Updating an Env Secret

Each env secret is its own Bitwarden entry. To update one (e.g. `composio-api-key`):

```bash
# 1. Unlock vault
export BW_SESSION=$(bw unlock --raw)

# 2. Find the item
ITEM=$(bw list items --search "composio-api-key" --folderid "<folder-id>" | jq '.[0]')
ITEM_ID=$(echo "$ITEM" | jq -r '.id')

# 3. Update the value
echo "$ITEM" | jq --arg notes "new_api_key_value" '.notes = $notes' \
  | bw encode \
  | bw edit item "$ITEM_ID"

# 4. Lock vault
bw lock
```

To add a new env secret:

```bash
# Create a new secure note in the folder
ITEM_JSON=$(jq -n \
  --arg name "new-secret-name" \
  --arg notes "secret_value" \
  --arg folderId "<folder-id>" \
  '{type: 2, secureNote: {type: 0}, name: $name, notes: $notes, folderId: $folderId}')
echo "$ITEM_JSON" | bw encode | bw create item
```

Then add the mapping to `SECRET_MAP` in `scripts/sync-secrets.sh`.

## Syncing to Server

After updating Bitwarden, sync secrets to the server:

```bash
bash scripts/sync-secrets.sh
```

Or as part of a deploy:

```bash
./deploy.sh --sync-secrets
```

The sync script fetches all items in the folder, builds `KEY=VALUE` lines from individual entries, and merges them into the server's `.env`. JSON credential files are SCPed directly by item ID.

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
