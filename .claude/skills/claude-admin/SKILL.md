---
name: Claude Code Admin
description: Manage Anthropic organization via Admin API (headless-compatible)
tags: [anthropic, admin, api-keys, organization]
---

# Claude Code Admin

Manage the Anthropic organization (Melbourne Computing) via the Admin API. List users, manage API keys, view org info, and check usage.

Credentials: Admin API key stored in Bitwarden vault item `claude-code-admin-key` (folder: `claude-agent-lightsail`). Pass via `--api-key` argument or `ANTHROPIC_ADMIN_KEY` env var.

## Get Organization Info

```bash
python3 .claude/skills/claude-admin/scripts/admin_api.py --api-key '$KEY' org-info
```

**Output:** JSON with `id`, `name`, `type`

## List Users

```bash
python3 .claude/skills/claude-admin/scripts/admin_api.py --api-key '$KEY' list-users
```

**Output:** JSON array of users with `id`, `email`, `name`, `role`, `added_at`

## List API Keys

```bash
python3 .claude/skills/claude-admin/scripts/admin_api.py --api-key '$KEY' list-keys [--status active|inactive]
```

**Arguments:**
- `--status` (optional, default: `active`): Filter by key status

**Output:** JSON array of API keys with `id`, `name`, `status`, `partial_key_hint`, `workspace_id`, `created_at`

## Update API Key

```bash
python3 .claude/skills/claude-admin/scripts/admin_api.py --api-key '$KEY' update-key --key-id 'apikey_xxx' [--name 'New Name'] [--status active|inactive]
```

**Arguments:**
- `--key-id` (required): API key ID
- `--name` (optional): New display name
- `--status` (optional): Set to `active` or `inactive`

## List Workspaces

```bash
python3 .claude/skills/claude-admin/scripts/admin_api.py --api-key '$KEY' list-workspaces
```

**Output:** JSON array of workspaces with `id`, `name`, `created_at`

## Invite User

```bash
python3 .claude/skills/claude-admin/scripts/admin_api.py --api-key '$KEY' invite --email 'user@example.com' --role developer
```

**Arguments:**
- `--email` (required): Email to invite
- `--role` (required): One of `user`, `claude_code_user`, `developer`, `billing`, `admin`

## Available Roles

| Role | Permissions |
|------|-------------|
| `user` | Workbench only |
| `claude_code_user` | Workbench + Claude Code |
| `developer` | Workbench + manage API keys |
| `billing` | Workbench + manage billing |
| `admin` | Full access |

## Notes

- Admin API keys start with `sk-ant-admin...` — they cannot be used as regular API keys for inference
- New API keys can only be created via the Console UI, not the API
- Admin users cannot be removed via the API
- Organization invites expire after 21 days
- The Admin API does NOT expose subscription billing (Claude Pro/Max/Team plans) — only API usage billing
