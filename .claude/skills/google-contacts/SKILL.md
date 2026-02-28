---
name: Google Contacts
description: Search, create, update, and list Google Contacts with fuzzy/partial name matching via OAuth2 (headless-compatible)
tags: [google-contacts, contacts, google]
---

# Google Contacts

Manage Google Contacts with fuzzy/partial matching. Uses OAuth2 authentication (Google People API v1), compatible with headless/systemd environments.

Token stored at `/home/ubuntu/.claude-agent/google-contacts-token.json`. Uses same OAuth client credentials as calendar (`google-credentials.json`).

## Search contacts (primary command)

Use this when the user asks to find/look up a contact by name, email, or phone.

```bash
python3 /home/ubuntu/agent/.claude/skills/google-contacts/scripts/contacts_search.py --query 'Christine'
python3 /home/ubuntu/agent/.claude/skills/google-contacts/scripts/contacts_search.py --query '0409244903' --method list
```

**Arguments:**
- `--query` (required): Name, email, phone, or partial string to search
- `--max N`: Max results (default: 10)
- `--method search|list`: `search` uses People API searchContacts (best for names), `list` fetches all and fuzzy-matches locally (best for phone/email lookup). Default: `search`
- `--threshold N`: Minimum fuzzy score 0-100 for list method (default: 40)

Returns JSON with `query`, `method`, `count`, `contacts[]`. Each contact has: `resource_name`, `display_name`, `given_name`, `family_name`, `emails`, `phones`, `organization`, `address`, `score`.

## Create contact

```bash
python3 /home/ubuntu/agent/.claude/skills/google-contacts/scripts/contacts_create.py \
  --given-name 'John' --family-name 'Smith' --email 'john@example.com' --phone '+61412345678'
```

**Arguments:**
- `--given-name` (required): First name
- `--family-name`: Last name
- `--email`: Email address
- `--phone`: Phone number
- `--organization`: Company name
- `--job-title`: Job title
- `--notes`: Notes/memo
- `--address`: Street address

## Update contact

```bash
python3 /home/ubuntu/agent/.claude/skills/google-contacts/scripts/contacts_update.py \
  --resource-name 'people/c123456' --phone '+61400000000'
```

**Arguments:**
- `--resource-name` (required): Contact resource name (e.g. `people/c123456`, from search results)
- `--given-name`, `--family-name`, `--email`, `--phone`, `--organization`, `--job-title`, `--notes`, `--address`: Fields to update (only specified fields change)

## List contacts

```bash
python3 /home/ubuntu/agent/.claude/skills/google-contacts/scripts/contacts_list.py --max 20
python3 /home/ubuntu/agent/.claude/skills/google-contacts/scripts/contacts_list.py --group 'Friends'
```

**Arguments:**
- `--max N`: Max results (default: 50)
- `--group "Group Name"`: Filter by contact group name
- `--sort name|recent`: Sort order (default: name — alphabetical by first name)

## Auth setup (one-time)

```bash
python3 /home/ubuntu/agent/.claude/skills/google-contacts/scripts/contacts_auth.py --get-url
python3 /home/ubuntu/agent/.claude/skills/google-contacts/scripts/contacts_auth.py --exchange-code YOUR_CODE
```
