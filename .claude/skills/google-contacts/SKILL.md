---
name: Google Contacts
description: Backup, analyze, and clean up Google Contacts via People API (headless-compatible)
tags: [google, contacts, cleanup, backup, people-api]
---

# Google Contacts

**For contact lookups (name → phone/email), use `gws` CLI — NOT this skill's scripts:**
```bash
gws people people searchContacts --params '{"query": "<name>", "readMask": "names,emailAddresses,phoneNumbers"}'
```

This skill is for **bulk operations only** (backup, cleanup, merge). The scripts below use separate OAuth credentials that require manual refresh.

## Credentials (bulk scripts only)

- OAuth client config: `~/.claude-agent/google-credentials.json`
- Refresh token: `~/.claude-agent/google-contacts-token.json`
- Auth scope: `contacts.readonly` (default), upgrade to `contacts` for write operations
- Auth flow: `node scripts/google-contacts-auth.js` (opens browser for consent)

**To upgrade scope for write operations:**
1. Edit `scripts/google-contacts-auth.js` — change scope to `https://www.googleapis.com/auth/contacts`
2. Run the auth script, complete browser consent
3. Revert scope back to readonly when done

## Scripts (bulk operations)

All scripts require `googleapis` npm package (install temporarily: `npm install googleapis`, remove after: `npm uninstall googleapis`).

### Backup

```bash
node .claude/skills/google-contacts/scripts/backup.js [output-path]
```

Exports all contacts to JSON. Default output: `~/.claude-agent/google-contacts-backup-YYYY-MM-DD.json`

Fields exported: name, emails, phones, organizations, addresses, birthdays, URLs, notes, group memberships, metadata (source, updateTime).

### Analyze

```bash
node .claude/skills/google-contacts/scripts/analyze.js <backup-file>
```

Analyzes a backup file and reports:
- Empty contacts (no data at all)
- Nameless email-only duplicates of named contacts
- Nameless phone-only duplicates of named contacts
- Exact duplicate pairs (same name + same phone/email)
- Nameless contacts with org names (rename candidates)
- Duplicate name groups (manual review needed)
- Overall stats

### Clean (requires `contacts` scope)

```bash
node .claude/skills/google-contacts/scripts/clean.js <backup-file> [--dry-run]
```

Automated cleanup phases:
1. Delete truly empty contacts
2. Delete nameless contacts whose email duplicates a named contact
3. Delete nameless contacts whose phone duplicates a named contact

Always run with `--dry-run` first.

### Merge Duplicates (requires `contacts` scope)

```bash
node .claude/skills/google-contacts/scripts/merge-dupes.js <backup-file> [--dry-run]
```

Deletes exact-duplicate contacts (same name + identical phone or email set). Keeps the entry with the most data. Also consolidates multiple "Sean O'Reilly" entries (deletes empty ones).

### Rename from Org (requires `contacts` scope)

```bash
node .claude/skills/google-contacts/scripts/rename-from-org.js <backup-file> [--dry-run]
```

Renames nameless contacts that have an organization name — sets display name to org name. Fetches live etag before each update. Rate-limited to ~2 req/sec.

## Learnings

### API Constraints
- **Etag required for updates**: Must fetch live contact to get current etag before `updateContact`. Using stale etags from backup will fail.
- **Sequential mutations**: Don't parallelize write requests for the same user — causes latency and failures.
- **Batch limits**: `batchDeleteContacts` max 500 per request, `batchUpdateContacts` max 200.
- **Rate limiting**: ~2 requests/sec for sustained operations. Add 200ms sleep between individual calls, 2s pause every 10 operations.
- **Already-deleted contacts**: `Requested entity was not found` errors are expected when operating on contacts deleted in earlier phases. Safe to ignore.

### Data Patterns (Sean's account, March 2026)
- ~3,057 total contacts
- ~30% nameless (auto-collected by Gmail or saved from call history)
- ~722 email-only nameless contacts in "Other Contacts" (not myContacts group)
- ~205 nameless contacts had org names that could be used as display names
- Most contacts (88%) updated in 2025 — staleness not a major issue
- All contacts sourced as `CONTACT` type (no PROFILE/DIRECTORY)

### Cleanup Workflow
1. **Always backup first** — full export via People API
2. **Automated safe deletes** — empties, exact dupes, nameless dupes of named contacts
3. **Automated renames** — nameless contacts with org names
4. **Manual review** — duplicate name groups (different people with same first name), email-only contacts in "Other Contacts"
5. **Google Merge & Fix** at contacts.google.com handles fuzzy duplicates well
6. **iPhone sync** — Google Contacts sync via CardDAV every 15-30 min. Force by toggling Contacts off/on in Settings → Accounts → Google.

### Scope Management
- Keep default scope as `contacts.readonly` for safety
- Only upgrade to `contacts` (read/write) when running cleanup scripts
- Revert immediately after — the agent's day-to-day lookup only needs readonly
- Token with write scope works for read operations too, but principle of least privilege applies
