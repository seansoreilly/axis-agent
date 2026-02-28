---
name: Gmail
description: Send and read emails via Gmail using app password authentication (headless-compatible)
tags: [gmail, email, google]
---

# Gmail

Send and read emails via Gmail. Uses app password authentication (SMTP/IMAP), compatible with headless/systemd environments.

Credentials are stored in `/home/ubuntu/agent/gmail_app_password.json` (not committed to repo — instance-only).

## Send email

```bash
python3 /home/ubuntu/agent/.claude/skills/gmail/scripts/send.py --to recipient@example.com --subject 'Subject' --body 'Body'
python3 /home/ubuntu/agent/.claude/skills/gmail/scripts/send.py --to a@b.com --subject 'Hi' --body '<b>Hello</b>' --html
```

**Arguments:**
- `--to` (required): Recipient email address
- `--subject` (required): Email subject
- `--body` (required): Email body text
- `--html`: Send body as HTML instead of plain text

## Read emails

```bash
python3 /home/ubuntu/agent/.claude/skills/gmail/scripts/read.py --count 10         # Last 10 emails
python3 /home/ubuntu/agent/.claude/skills/gmail/scripts/read.py --count 5 --unread  # Unread only
python3 /home/ubuntu/agent/.claude/skills/gmail/scripts/read.py --search 'FROM boss@work.com'
```

**Arguments:**
- `--count N`: Number of emails to fetch (default: 10)
- `--unread`: Only fetch unread emails
- `--folder FOLDER`: Mailbox folder (default: INBOX)
- `--search QUERY`: IMAP search string (e.g. `"FROM boss@work.com"`)

**Output:** JSON array with fields: `id`, `from`, `to`, `subject`, `date`, `body` (truncated to 500 chars)

## Triage emails

Classify inbox emails with Claude Haiku (~$0.001/email), auto-archive unimportant ones, and attempt to unsubscribe from mailing lists.

```bash
python3 /home/ubuntu/agent/.claude/skills/gmail/scripts/triage.py --count 20              # Triage 20 emails
python3 /home/ubuntu/agent/.claude/skills/gmail/scripts/triage.py --count 10 --unread     # Unread only
python3 /home/ubuntu/agent/.claude/skills/gmail/scripts/triage.py --dry-run --count 5     # Classify only
python3 /home/ubuntu/agent/.claude/skills/gmail/scripts/triage.py --no-unsubscribe        # Archive but skip unsubscribe
```

**Arguments:**
- `--count N`: Number of emails to triage (default: 20)
- `--unread`: Only triage unread emails
- `--dry-run`: Classify emails but don't archive or unsubscribe
- `--no-unsubscribe`: Archive unimportant emails but skip unsubscribe attempts

**Behavior:**
1. Fetches emails from INBOX via IMAP (using UIDs for stability)
2. Classifies each email as important/unimportant using Claude Haiku
3. Copies unimportant emails to `Auto-Archived` label, removes from inbox
4. Attempts HTTP unsubscribe via `List-Unsubscribe` header (RFC 8058 one-click preferred, GET fallback, skips mailto-only)

**Output:** JSON with `summary` (counts, cost, tokens), `important` list, `unimportant` list, and `unsubscribe_results`
