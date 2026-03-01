#!/bin/bash
# Daily SDK update check — runs via cron
cd /home/ubuntu/agent

BEFORE=$(node -e "console.log(require('@anthropic-ai/claude-agent-sdk/package.json').version)" 2>/dev/null)
npm update @anthropic-ai/claude-agent-sdk --save 2>/dev/null
AFTER=$(node -e "console.log(require('@anthropic-ai/claude-agent-sdk/package.json').version)" 2>/dev/null)

if [ "$BEFORE" != "$AFTER" ]; then
  echo "$(date): SDK updated $BEFORE -> $AFTER, restarting service"
  sudo systemctl restart claude-agent
else
  echo "$(date): SDK already at $AFTER, no update needed"
fi
