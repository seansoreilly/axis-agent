#!/bin/bash
# Email triage automation script
# Runs the Gmail triage task

python3 /home/ubuntu/agent/.claude/skills/gmail/scripts/email_triage.py fetch --count 15 --above-uid $(python3 /home/ubuntu/agent/.claude/skills/gmail/scripts/email_triage.py state | grep -o '"high_uid": [0-9]*' | grep -o '[0-9]*') 2>&1 | tee -a /var/log/email_triage.log

echo "Email triage completed at $(date)" >> /var/log/email_triage.log
