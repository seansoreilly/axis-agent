---
name: Google Workspace CLI (gws)
description: Unified CLI for all Google Workspace APIs — contacts, calendar, gmail, drive, sheets, docs, and more
tags: [google, contacts, calendar, gmail, drive, sheets, gws]
---

# Google Workspace CLI (`gws`)

The primary tool for ALL Google service operations. Installed globally. Always use `gws` — do NOT use googleapis, google-contacts scripts, or Composio for Google operations.

**Auth:** OAuth credentials at `~/.config/gws/credentials.json` (auto-refreshes). Do NOT set `GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE`.

**Important:** Always append `2>/dev/null` to gws commands — it emits harmless token cache warnings on stderr that are not errors. The JSON on stdout is always valid.

## Usage

```bash
gws <service> <resource> <method> [--params '{"key":"value"}'] [--json '{"body":"..."}'] 2>/dev/null
```

## Contact Lookup

```bash
# Search contacts by name
gws people people searchContacts --params '{"query": "<name>", "readMask": "names,emailAddresses,phoneNumbers"}' 2>/dev/null

# List all contacts (paginated)
gws people people connections list --params '{"resourceName": "people/me", "personFields": "names,emailAddresses,phoneNumbers", "pageSize": 50}' 2>/dev/null
```

## Calendar

```bash
# Today's agenda (helper command)
gws calendar +agenda 2>/dev/null

# Create an event (helper command)
gws calendar +insert --params '{"calendarId": "primary"}' --json '{"summary": "Meeting", "start": {"dateTime": "2026-03-18T10:00:00+11:00"}, "end": {"dateTime": "2026-03-18T11:00:00+11:00"}}' 2>/dev/null

# List events
gws calendar events list --params '{"calendarId": "primary", "timeMin": "2026-03-17T00:00:00Z", "maxResults": 10, "singleEvents": true, "orderBy": "startTime"}' 2>/dev/null
```

## Gmail

```bash
# Inbox triage (helper command)
gws gmail +triage 2>/dev/null

# Send email (helper command)
gws gmail +send --params '{"userId": "me"}' --json '{"to": "user@example.com", "subject": "Hello", "body": "Message body"}' 2>/dev/null

# List messages
gws gmail users messages list --params '{"userId": "me", "maxResults": 10, "q": "is:unread"}' 2>/dev/null

# Read a message
gws gmail users messages get --params '{"userId": "me", "id": "<messageId>", "format": "full"}' 2>/dev/null
```

## Drive

```bash
# List files
gws drive files list --params '{"pageSize": 10}' 2>/dev/null

# Search files
gws drive files list --params '{"q": "name contains \"report\"", "pageSize": 10}' 2>/dev/null

# Upload a file (helper command)
gws drive +upload --upload /path/to/file.pdf 2>/dev/null
```

## Sheets

```bash
# Read values
gws sheets +read --params '{"spreadsheetId": "<ID>", "range": "Sheet1!A1:C10"}' 2>/dev/null

# Append a row (helper command)
gws sheets +append --params '{"spreadsheetId": "<ID>", "range": "Sheet1"}' --json '{"values": [["value1", "value2"]]}' 2>/dev/null

# Create a spreadsheet
gws sheets spreadsheets create --json '{"properties": {"title": "New Sheet"}}' 2>/dev/null
```

## Flags Reference

| Flag | Description |
|---|---|
| `--params '<JSON>'` | URL/query parameters |
| `--json '<JSON>'` | Request body (POST/PATCH/PUT) |
| `--upload <PATH>` | Upload a local file |
| `--output <PATH>` | Save binary response to file |
| `--format <FMT>` | Output format: json (default), table, yaml, csv |
| `--page-all` | Auto-paginate (NDJSON output) |
| `--page-limit <N>` | Max pages with --page-all (default: 10) |
| `--dry-run` | Preview request without sending |

## Schema Discovery

Inspect any method's request/response schema:

```bash
gws schema drive.files.list
gws schema people.people.searchContacts
gws schema calendar.events.insert --resolve-refs
```

## Available Services

contacts (people), calendar, gmail, drive, sheets, docs, slides, tasks, chat, classroom, forms, keep, meet, admin-reports

## Scopes

Current OAuth scopes: `contacts.readonly`, `gmail.modify`, `calendar`. To use services beyond these (drive, sheets, docs), the OAuth token needs additional scopes — re-authenticate via the OAuth flow.
