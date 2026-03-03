---
name: Gmail Email Triage
description: Fetch, evaluate, archive, and unsubscribe from emails via IMAP (headless-compatible)
tags: [gmail, email, triage]
---

# Gmail Email Triage

Triage Gmail inbox using IMAP. Fetches emails, lets the agent evaluate importance, then archives or unsubscribes from unimportant ones. Uses dual UID watermarks for stable progress tracking that's immune to inbox churn (new arrivals, manual moves, filter actions).

Credentials are loaded from `/home/ubuntu/agent/gmail_app_password.json`:
```json
{"email": "...", "app_password": "...", "imap_host": "imap.gmail.com", "imap_port": 993, "smtp_host": "smtp.gmail.com", "smtp_port": 465}
```

## Fetch emails

```bash
# Newest 10 (no cursor, for ad-hoc use)
python3 /home/ubuntu/agent/.claude/skills/gmail/scripts/email_triage.py fetch --count 10

# Backlog: 10 emails with UIDs below low_uid (older, unprocessed)
python3 /home/ubuntu/agent/.claude/skills/gmail/scripts/email_triage.py fetch --count 10 --below-uid 45000 --headers-only

# New arrivals: emails with UIDs above high_uid (arrived since last run)
python3 /home/ubuntu/agent/.claude/skills/gmail/scripts/email_triage.py fetch --count 10 --above-uid 47000
```

**Arguments:**
- `--count` (optional, default 10): Number of emails to fetch
- `--below-uid` (optional): Fetch emails with UID below this value — for working through backlog
- `--above-uid` (optional): Fetch emails with UID above this value — for catching new arrivals
- `--headers-only` (optional): Fetch headers only — skips body/snippet for faster, cheaper backlog processing

**Output:** JSON object with:
- `emails`: Array of email objects (`message_id`, `uid`, `subject`, `from`, `date`, `labels`, `has_unsubscribe`, `unsubscribe_link`, and `snippet` if not headers-only)
- `total_inbox`: Total number of emails currently in INBOX
- `matched`: Number of emails matching the UID criteria
- `count`: Number of emails returned in this batch
- `remaining`: Emails matching criteria not yet fetched
- `mode`: `"backlog"`, `"new"`, or `"latest"`
- `backlog_complete`: `true` when no more emails below the low watermark

## Archive an email

```bash
python3 /home/ubuntu/agent/.claude/skills/gmail/scripts/email_triage.py archive --message-id "<msg-id>" --label "Auto-Archive"
```

**Arguments:**
- `--message-id` (required): The message ID from the fetch output
- `--label` (optional, default "Auto-Archive"): Gmail label to apply before archiving

**Output:** JSON with `success`, `message_id`, `label`

## Unsubscribe from an email

```bash
python3 /home/ubuntu/agent/.claude/skills/gmail/scripts/email_triage.py unsubscribe --message-id "<msg-id>" --label "Auto-Unsubscribe"
```

**Arguments:**
- `--message-id` (required): The message ID from the fetch output
- `--label` (optional, default "Auto-Unsubscribe"): Gmail label to apply

**Output:** JSON with `success`, `message_id`, `label`, `unsubscribe_method` ("https", "mailto", or "none")

## State tracking (dual UID watermarks)

Two watermarks define a processed range `[low_uid, high_uid]`:
- **high_uid**: highest UID processed — new arrivals are above this
- **low_uid**: lowest UID processed — backlog is below this
- Everything between them has already been evaluated

UIDs are immutable IMAP identifiers — they don't shift when emails are added, removed, or moved.

```bash
python3 /home/ubuntu/agent/.claude/skills/gmail/scripts/email_triage.py state
python3 /home/ubuntu/agent/.claude/skills/gmail/scripts/email_triage.py watermark --high 47641 --low 45000
python3 /home/ubuntu/agent/.claude/skills/gmail/scripts/email_triage.py reset
```

**Commands:**
- `state` — Print current state (`high_uid`, `low_uid`, `last_run`, `total_processed`)
- `watermark --high <uid>` — Update high_uid (after processing new arrivals)
- `watermark --low <uid>` — Update low_uid (after processing a backlog batch)
- `watermark --high <uid> --low <uid>` — Update both at once
- `reset` — Clear both watermarks (re-initializes on next run)

**State file:** `/home/ubuntu/.claude-agent/email-triage-state.json`

## Triage workflow (incremental)

Each run does TWO passes:

### Pass 1: New arrivals (above high_uid)
1. Run `state` to get `high_uid` and `low_uid`
2. If both are null (first run): run `fetch --count 10`, set `high_uid` to **highest UID** and `low_uid` to **lowest UID** in the batch. Process and done.
3. Run `fetch --count 10 --above-uid <high_uid>` to catch new emails
4. If emails returned: evaluate, archive/unsubscribe as needed, then `watermark --high <highest_uid_in_batch>`
5. If no emails: no new mail since last run, skip to pass 2

### Pass 2: Backlog (below low_uid)
6. Run `fetch --count 10 --below-uid <low_uid> --headers-only`
7. If `backlog_complete` is true → report "backlog complete", done
8. Evaluate each email based on subject and sender
9. Archive/unsubscribe as needed
10. `watermark --low <lowest_uid_in_batch>` (moves low_uid down through backlog)
11. Report progress: "Processed <count> backlog emails, <remaining> remaining"

### Why dual watermarks work
```
[oldest UID] ... [backlog] ... [low_uid] ... [processed] ... [high_uid] ... [new arrivals] ... [newest UID]
```
- **New emails** get UIDs above high_uid → always caught in pass 1
- **Manual moves/archives** just remove UIDs → no position shift, no skipping
- **high_uid only moves up**, low_uid only moves down → the processed range only grows
- A single watermark fails because pass 1 and pass 2 fight over the same value
