---
name: Gmail Email Triage
description: Fetch, evaluate, archive, and unsubscribe from emails via IMAP (headless-compatible)
tags: [gmail, email, triage]
---

# Gmail Email Triage

Triage Gmail inbox using IMAP. Fetches recent emails, lets the agent evaluate importance, then archives or unsubscribes from unimportant ones.

Credentials are loaded from `/home/ubuntu/agent/gmail_app_password.json`:
```json
{"email": "...", "app_password": "...", "imap_host": "imap.gmail.com", "imap_port": 993, "smtp_host": "smtp.gmail.com", "smtp_port": 465}
```

## Fetch recent emails

```bash
python3 /home/ubuntu/agent/.claude/skills/gmail/scripts/email_triage.py fetch --count 5
```

**Arguments:**
- `--count` (optional, default 5): Number of most recent INBOX emails to fetch

**Output:** JSON array with objects containing: `message_id`, `subject`, `from`, `date`, `snippet`, `labels`, `has_unsubscribe`, `unsubscribe_link`

## Archive an email

```bash
python3 /home/ubuntu/agent/.claude/skills/gmail/scripts/email_triage.py archive --message-id "<msg-id>" --label "Auto-Archive"
```

**Arguments:**
- `--message-id` (required): The message ID from the fetch output
- `--label` (optional, default "Auto-Archive"): Gmail label to apply before archiving

**What it does:** Creates the label if it doesn't exist, applies it to the message, then removes it from INBOX (Gmail archive).

**Output:** JSON with `success`, `message_id`, `label`

## Unsubscribe from an email

```bash
python3 /home/ubuntu/agent/.claude/skills/gmail/scripts/email_triage.py unsubscribe --message-id "<msg-id>" --label "Auto-Unsubscribe"
```

**Arguments:**
- `--message-id` (required): The message ID from the fetch output
- `--label` (optional, default "Auto-Unsubscribe"): Gmail label to apply

**What it does:** Follows the List-Unsubscribe header (GET for https: links, sends email for mailto: links), applies the label, then archives the message.

**Output:** JSON with `success`, `message_id`, `label`, `unsubscribe_method` ("https", "mailto", or "none")

## Triage workflow

1. Run `fetch --count 5` (or more)
2. Evaluate each email's importance based on subject, sender, and snippet
3. For unimportant emails with unsubscribe links → run `unsubscribe`
4. For unimportant emails without unsubscribe → run `archive`
5. Report a summary to the user: what was kept, archived, and unsubscribed
