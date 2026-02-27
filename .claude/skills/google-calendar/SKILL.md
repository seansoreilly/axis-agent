---
name: Google Calendar
description: Read, create, update, and delete Google Calendar events using service account authentication (headless-compatible)
tags: [google-calendar, calendar, google]
---

# Google Calendar

Manage Google Calendar events. Uses service account authentication (Google Calendar API v3) and iCal feeds, compatible with headless/systemd environments.

Timezone: Australia/Melbourne. The calendar must be shared with the Google service account. Service account credentials are at `/home/ubuntu/.claude-agent/google-service-account.json`.

## Read events (iCal — fastest)

Use this first when the user asks about their schedule/calendar/events.

```bash
python3 /home/ubuntu/agent/.claude/skills/google-calendar/scripts/ical_fetch.py --days 7
python3 /home/ubuntu/agent/.claude/skills/google-calendar/scripts/ical_fetch.py --days 30
```

Returns JSON with events: `summary`, `start`, `end`, `location`, `description`, `uid`.

## Google Calendar API (read/write)

### List events

```bash
python3 /home/ubuntu/agent/.claude/skills/google-calendar/scripts/calendar_list.py --days 7
python3 /home/ubuntu/agent/.claude/skills/google-calendar/scripts/calendar_list.py --days 14 --calendar primary
```

### Create event

```bash
python3 /home/ubuntu/agent/.claude/skills/google-calendar/scripts/calendar_create.py \
  --summary 'Meeting' \
  --start '2026-03-01T10:00:00+11:00' \
  --end '2026-03-01T11:00:00+11:00'
```

**Arguments:**
- `--summary` (required): Event title
- `--start` (required): Start datetime (ISO 8601, e.g. `2026-03-01T10:00:00+11:00`) or date (`2026-03-01`)
- `--end` (required): End datetime or date
- `--description`: Event description
- `--location`: Event location
- `--attendees`: Attendee email addresses (space-separated)
- `--calendar`: Calendar ID (default: `primary`)
- `--timezone`: Timezone (default: `Australia/Melbourne`)

### Update event

```bash
python3 /home/ubuntu/agent/.claude/skills/google-calendar/scripts/calendar_update.py \
  --event-id EVENT_ID --summary 'New title'
```

**Arguments:**
- `--event-id` (required): Event ID to update
- `--summary`, `--start`, `--end`, `--description`, `--location`: Fields to update (only specified fields change)
- `--calendar`: Calendar ID (default: `primary`)

### Delete event

```bash
python3 /home/ubuntu/agent/.claude/skills/google-calendar/scripts/calendar_delete.py --event-id EVENT_ID
```

### Search events

```bash
python3 /home/ubuntu/agent/.claude/skills/google-calendar/scripts/calendar_search.py --query 'meeting'
```

**Arguments:**
- `--query` (required): Text to search for
- `--days-back N`: Search N days back (default: 30)
- `--days-forward N`: Search N days forward (default: 90)
- `--calendar`: Calendar ID (default: `primary`)
- `--max N`: Max results (default: 20)

### List calendars

```bash
python3 /home/ubuntu/agent/.claude/skills/google-calendar/scripts/calendar_calendars.py
```

Returns all accessible calendars with `id`, `summary`, `description`, `primary`, `access_role`.
