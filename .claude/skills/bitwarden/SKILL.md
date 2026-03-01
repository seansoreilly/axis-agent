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

| Item ID | Item Name | Format | Server Destination |
|---|---|---|---|
| `f8630333-d0ef-4ac5-87f3-b3ff002f9c78` | `env-secrets` | `KEY=value` pairs (one per line) | `/home/ubuntu/agent/.env` (merged) |
| `01df4168-e6e8-4859-ac06-b3ff002fa4cf` | `gmail` | JSON | `/home/ubuntu/agent/gmail_app_password.json` |
| `c7f8b911-64fe-4303-897d-b3ff002fad11` | `facebook` | JSON | `/home/ubuntu/.claude-agent/facebook-page-token.json` |
| `b93df202-8224-4347-b1a2-b3ff002fb546` | `google-service-account` | JSON | `/home/ubuntu/.claude-agent/google-service-account.json` |
| `03419c60-6360-4cfd-94de-b3ff002fbd25` | `google-credentials` | JSON | `/home/ubuntu/.claude-agent/google-credentials.json` |

## Adding/Updating an env-secrets Key

To add or update a key in the `env-secrets` item (e.g. `ZAPIER_API_KEY`):

```bash
# 1. Unlock vault
export BW_SESSION=$(bw unlock --raw)

# 2. Get current content
CURRENT=$(bw get notes "f8630333-d0ef-4ac5-87f3-b3ff002f9c78")

# 3. Check if key already exists
echo "$CURRENT" | grep "^KEY_NAME="

# 4a. If key exists, replace it:
UPDATED=$(echo "$CURRENT" | sed "s|^KEY_NAME=.*|KEY_NAME=new_value|")

# 4b. If key is new, append it:
UPDATED=$(printf '%s\nKEY_NAME=new_value' "$CURRENT")

# 5. Update the vault item
bw get item "f8630333-d0ef-4ac5-87f3-b3ff002f9c78" \
  | jq --arg notes "$UPDATED" '.notes = $notes' \
  | bw encode \
  | bw edit item "f8630333-d0ef-4ac5-87f3-b3ff002f9c78"

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
