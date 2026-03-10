#!/bin/bash
# Email triage job - runs incremental inbox cleanup

set -e

LOG_FILE="/home/ubuntu/agent/logs/email-triage.log"
mkdir -p "$(dirname "$LOG_FILE")"

echo "[$(date)] Starting email triage job..." >> "$LOG_FILE"

# Check state
STATE=$(python3 /home/ubuntu/agent/.claude/skills/gmail/scripts/email_triage.py state)
HIGH_UID=$(echo "$STATE" | python3 -c "import sys, json; d=json.load(sys.stdin); print(d.get('high_uid', ''))")
LOW_UID=$(echo "$STATE" | python3 -c "import sys, json; d=json.load(sys.stdin); print(d.get('low_uid', ''))")

# Pass 1: Check for new arrivals
if [ -n "$HIGH_UID" ]; then
    NEW_EMAILS=$(python3 /home/ubuntu/agent/.claude/skills/gmail/scripts/email_triage.py fetch --count 20 --above-uid "$HIGH_UID" 2>&1 || echo '{"emails":[]}')
    NEW_COUNT=$(echo "$NEW_EMAILS" | python3 -c "import sys, json; d=json.load(sys.stdin); print(len(d.get('emails', [])))")
    echo "[$(date)] New arrivals: $NEW_COUNT" >> "$LOG_FILE"
else
    echo "[$(date)] No watermark set, initializing..." >> "$LOG_FILE"
    NEW_EMAILS=$(python3 /home/ubuntu/agent/.claude/skills/gmail/scripts/email_triage.py fetch --count 10 2>&1 || echo '{"emails":[]}')
fi

# Pass 2: Work through backlog if any
if [ -n "$LOW_UID" ]; then
    BACKLOG=$(python3 /home/ubuntu/agent/.claude/skills/gmail/scripts/email_triage.py fetch --count 10 --below-uid "$LOW_UID" --headers-only 2>&1 || echo '{"emails":[],"backlog_complete":true}')
    BACKLOG_COUNT=$(echo "$BACKLOG" | python3 -c "import sys, json; d=json.load(sys.stdin); print(len(d.get('emails', [])))")
    BACKLOG_COMPLETE=$(echo "$BACKLOG" | python3 -c "import sys, json; d=json.load(sys.stdin); print(d.get('backlog_complete', False))")
    echo "[$(date)] Backlog processed: $BACKLOG_COUNT emails, complete: $BACKLOG_COMPLETE" >> "$LOG_FILE"
fi

echo "[$(date)] Email triage job completed successfully" >> "$LOG_FILE"
