---
name: Gmail Email Triage
description: Fetch, evaluate, archive, and unsubscribe from emails via IMAP (headless-compatible)
tags: [gmail, email, triage]
---

# Gmail Email Triage

Triage Gmail inbox using IMAP. Fetches recent emails, lets the agent evaluate importance, then archives or unsubscribes from unimportant ones. Supports incremental backlog processing via offset pagination and state tracking.

Credentials are loaded from `/home/ubuntu/agent/gmail_app_password.json`:
```json
{"email": "...", "app_password": "...", "imap_host": "imap.gmail.com", "imap_port": 993, "smtp_host": "smtp.gmail.com", "smtp_port": 465}
```

## Fetch emails

```bash
python3 /home/ubuntu/agent/.claude/skills/gmail/scripts/email_triage.py fetch --count 10 --offset 0
python3 /home/ubuntu/agent/.claude/skills/gmail/scripts/email_triage.py fetch --count 10 --offset 20 --headers-only
```

**Arguments:**
- `--count` (optional, default 5): Number of emails to fetch
- `--offset` (optional, default 0): Skip N most recent emails (for pagination through backlog)
- `--headers-only` (optional): Fetch headers only — skips body/snippet extraction for faster, cheaper backlog processing

**Output:** JSON object with:
- `emails`: Array of email objects (`message_id`, `uid`, `subject`, `from`, `date`, `labels`, `has_unsubscribe`, `unsubscribe_link`, and `snippet` if not headers-only)
- `total_inbox`: Total number of emails in INBOX
- `offset`: The offset used
- `count`: Number of emails returned
- `backlog_complete`: `true` when offset exceeds total (no more emails to process)

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

## State tracking (for incremental triage)

Track progress through the inbox backlog across runs.

```bash
python3 /home/ubuntu/agent/.claude/skills/gmail/scripts/email_triage.py state
python3 /home/ubuntu/agent/.claude/skills/gmail/scripts/email_triage.py advance --by 10
python3 /home/ubuntu/agent/.claude/skills/gmail/scripts/email_triage.py reset
```

**Commands:**
- `state` — Print current state (`offset`, `last_run`, `total_processed`)
- `advance --by N` — Increment offset by N after processing a batch
- `reset` — Reset offset to 0 (start over from newest)

**State file:** `/home/ubuntu/.claude-agent/email-triage-state.json`

## Triage workflow (incremental)

1. Run `state` to get the current offset
2. Run `fetch --count 10 --offset <offset> --headers-only` (use `--headers-only` for backlog, omit for recent emails)
3. If `backlog_complete` is true → report "backlog complete", run `reset`, switch to maintenance (offset 0, no headers-only)
4. Evaluate each email's importance based on subject, sender (and snippet if available)
5. For unimportant emails with unsubscribe links → run `unsubscribe`
6. For unimportant emails without unsubscribe → run `archive`
7. Run `advance --by <number_kept>` — advance by the number of emails you **kept** (not the batch size), because archived/unsubscribed emails leave the INBOX and shift positions down
8. Report progress: "Processed <count> emails at offset <offset> of ~<total_inbox> (kept <n>, archived <n>, unsubscribed <n>)"
