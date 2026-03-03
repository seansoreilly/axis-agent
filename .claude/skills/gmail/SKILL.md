---
name: Gmail Email Triage
description: Fetch, evaluate, archive, and unsubscribe from emails via IMAP (headless-compatible)
tags: [gmail, email, triage]
---

# Gmail Email Triage

Triage Gmail inbox using IMAP. Fetches emails, lets the agent evaluate importance, then archives or unsubscribes from unimportant ones. Uses UID-based watermark for stable progress tracking that's immune to inbox churn (new arrivals, manual moves, filter actions).

Credentials are loaded from `/home/ubuntu/agent/gmail_app_password.json`:
```json
{"email": "...", "app_password": "...", "imap_host": "imap.gmail.com", "imap_port": 993, "smtp_host": "smtp.gmail.com", "smtp_port": 465}
```

## Fetch emails

```bash
# Newest 10 (no cursor, for ad-hoc use)
python3 /home/ubuntu/agent/.claude/skills/gmail/scripts/email_triage.py fetch --count 10

# Backlog: 10 emails with UIDs below the watermark (older, unprocessed)
python3 /home/ubuntu/agent/.claude/skills/gmail/scripts/email_triage.py fetch --count 10 --below-uid 45000 --headers-only

# New arrivals: emails with UIDs above the watermark (arrived since last run)
python3 /home/ubuntu/agent/.claude/skills/gmail/scripts/email_triage.py fetch --count 10 --above-uid 45000
```

**Arguments:**
- `--count` (optional, default 10): Number of emails to fetch
- `--below-uid` (optional): Fetch emails with UID below this value — for working through backlog (oldest-first within batch)
- `--above-uid` (optional): Fetch emails with UID above this value — for catching new arrivals
- `--headers-only` (optional): Fetch headers only — skips body/snippet for faster, cheaper backlog processing

**Output:** JSON object with:
- `emails`: Array of email objects (`message_id`, `uid`, `subject`, `from`, `date`, `labels`, `has_unsubscribe`, `unsubscribe_link`, and `snippet` if not headers-only)
- `total_inbox`: Total number of emails currently in INBOX
- `matched`: Number of emails matching the UID criteria
- `count`: Number of emails returned in this batch
- `remaining`: Emails matching criteria not yet fetched
- `mode`: `"backlog"`, `"new"`, or `"latest"`
- `backlog_complete`: `true` when no more emails below the watermark

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

## State tracking (UID watermark)

Track progress through the inbox using stable IMAP UIDs. UIDs are immutable — they don't shift when emails are added, removed, or moved.

```bash
python3 /home/ubuntu/agent/.claude/skills/gmail/scripts/email_triage.py state
python3 /home/ubuntu/agent/.claude/skills/gmail/scripts/email_triage.py watermark --set 45000
python3 /home/ubuntu/agent/.claude/skills/gmail/scripts/email_triage.py reset
```

**Commands:**
- `state` — Print current state (`watermark_uid`, `last_run`, `total_processed`)
- `watermark --set <uid>` — Set the UID watermark (the boundary between processed and unprocessed)
- `reset` — Clear the watermark (re-initializes on next run)

**State file:** `/home/ubuntu/.claude-agent/email-triage-state.json`

## Triage workflow (incremental)

Each run does TWO passes:

### Pass 1: New arrivals (above watermark)
1. Run `state` to get `watermark_uid`
2. If watermark is null (first run): run `fetch --count 10` to get the newest emails. Set watermark to the **lowest UID** in the batch. Process and done.
3. Run `fetch --count 10 --above-uid <watermark_uid>` to catch new emails
4. If emails returned: evaluate, archive/unsubscribe as needed, then set watermark to the **highest UID** in the batch
5. If no emails: no new mail since last run, skip to pass 2

### Pass 2: Backlog (below watermark)
6. Run `fetch --count 10 --below-uid <watermark_uid> --headers-only`
7. If `backlog_complete` is true → report "backlog complete", done
8. Evaluate each email based on subject and sender
9. Archive/unsubscribe as needed
10. Set watermark to the **lowest UID** in the batch (moves watermark down through backlog)
11. Report progress: "Processed <count> backlog emails, <remaining> remaining"

### Why this works
- **New emails** get UIDs above the watermark → always caught in pass 1
- **Manual moves/archives** just remove UIDs from INBOX → no position shift, no skipping
- **The watermark only moves**: up (to cover new arrivals) or down (to work through backlog)
