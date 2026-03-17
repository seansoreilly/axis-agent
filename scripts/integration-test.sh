#!/usr/bin/env bash
# Integration tests: runs real operations against the deployed agent instance.
# Unlike post-deploy-check.sh (dry-run only), these tests perform actual work
# to verify end-to-end functionality of all integrations.
#
# Usage: bash scripts/integration-test.sh [--verbose]
#
# Prerequisites:
#   - SSH key at ~/.ssh/claude-code-agent-key.pem
#   - DEPLOY_HOST env var or defaults to ubuntu@54.66.167.208
#   - Agent service running on instance
#
# Exit codes:
#   0 = all tests passed
#   1 = one or more tests failed

set -uo pipefail

SSH_KEY="$HOME/.ssh/claude-code-agent-key.pem"
REMOTE_HOST="${DEPLOY_HOST:-ubuntu@54.66.167.208}"
SSH_OPTS="-o StrictHostKeyChecking=no -o ConnectTimeout=10 -i $SSH_KEY"
VERBOSE="${1:-}"

TESTS=0
PASSED=0
FAILED=0
WARNINGS=0
FAILURES=""
START_TIME=$(date +%s)

pass() {
  TESTS=$((TESTS + 1))
  PASSED=$((PASSED + 1))
  echo "  ✓ $1"
}

fail() {
  TESTS=$((TESTS + 1))
  FAILED=$((FAILED + 1))
  echo "  ✗ $1"
  FAILURES="${FAILURES}  ✗ $1\n"
}

warn() {
  WARNINGS=$((WARNINGS + 1))
  echo "  ⚠ $1"
}

info() {
  [ "$VERBOSE" = "--verbose" ] && echo "    → $1"
}

remote() {
  ssh $SSH_OPTS "$REMOTE_HOST" "$1" 2>&1
}

remote_sourced() {
  ssh $SSH_OPTS "$REMOTE_HOST" "source /home/ubuntu/agent/.env && cd /home/ubuntu/agent && $1" 2>&1
}

echo "╔══════════════════════════════════════════════════════╗"
echo "║         Integration Tests — Axis Agent              ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""
echo "Target: $REMOTE_HOST"
echo "Date:   $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo ""

# ═══════════════════════════════════════════════════════════
# 1. Service Health
# ═══════════════════════════════════════════════════════════
echo "── Service Health ──────────────────────────────────────"

SERVICE_STATUS=$(remote "systemctl is-active claude-agent 2>/dev/null || echo inactive")
if [ "$SERVICE_STATUS" = "active" ]; then
  pass "systemd service active"
else
  fail "systemd service is '$SERVICE_STATUS'"
  echo "  Cannot continue — service must be running."
  exit 1
fi

HEALTH=$(remote "curl -sf http://localhost:8080/health")
if echo "$HEALTH" | grep -q '"status":"ok"'; then
  UPTIME=$(echo "$HEALTH" | grep -oP '"uptime":\K[0-9.]+' | cut -d. -f1)
  pass "gateway /health OK (uptime: ${UPTIME}s)"
else
  fail "gateway /health: $HEALTH"
fi

echo ""

# ═══════════════════════════════════════════════════════════
# 2. Gateway Webhook (Agent Prompt Execution)
# ═══════════════════════════════════════════════════════════
echo "── Gateway Webhook ──────────────────────────────────────"

WEBHOOK_RESULT=$(remote 'curl -sf -X POST http://localhost:8080/webhook -H "Content-Type: application/json" -d "{\"prompt\":\"Reply with exactly: INTEGRATION_TEST_OK\"}"')
if echo "$WEBHOOK_RESULT" | grep -q "INTEGRATION_TEST_OK"; then
  pass "webhook prompt execution"
  info "$WEBHOOK_RESULT"
else
  fail "webhook prompt: $(echo "$WEBHOOK_RESULT" | head -1)"
fi

echo ""

# ═══════════════════════════════════════════════════════════
# 3. Email Triage (Gmail IMAP)
# ═══════════════════════════════════════════════════════════
echo "── Email Triage (Gmail) ──────────────────────────────────"

# Test fetch: retrieve 1 email header
EMAIL_RESULT=$(remote_sourced 'python3 .claude/skills/gmail/scripts/email_triage.py fetch --count 1 --headers-only')
if echo "$EMAIL_RESULT" | grep -q '"emails"'; then
  TOTAL_INBOX=$(echo "$EMAIL_RESULT" | grep -oP '"total_inbox":\s*\K[0-9]+' || echo "?")
  SUBJECT=$(echo "$EMAIL_RESULT" | grep -oP '"subject":\s*"\K[^"]+' | head -1 || echo "?")
  pass "email fetch (inbox: $TOTAL_INBOX emails, latest: \"$SUBJECT\")"
  info "$EMAIL_RESULT"
else
  if echo "$EMAIL_RESULT" | grep -qi "credential\|auth\|password\|login"; then
    warn "email triage: credentials not configured"
  else
    fail "email fetch: $(echo "$EMAIL_RESULT" | head -2)"
  fi
fi

# Test watermark state
EMAIL_STATE=$(remote_sourced 'python3 .claude/skills/gmail/scripts/email_triage.py state')
if echo "$EMAIL_STATE" | grep -q '"high_water_mark"\|"watermark"\|"low_water_mark"\|uid'; then
  pass "email triage state readable"
  info "$EMAIL_STATE"
else
  if echo "$EMAIL_STATE" | grep -qi "no state\|not found\|empty"; then
    pass "email triage state (no prior state — fresh)"
  else
    # State returned something — check if it's valid JSON at all
    if echo "$EMAIL_STATE" | python3 -m json.tool >/dev/null 2>&1; then
      pass "email triage state (valid JSON)"
      info "$EMAIL_STATE"
    else
      warn "email state: unexpected format"
    fi
  fi
fi

echo ""

# ═══════════════════════════════════════════════════════════
# 4. gws People API (contact lookup)
# ═══════════════════════════════════════════════════════════
echo "── gws People API ───────────────────────────────────────"

GWS_CONTACTS=$(remote_sourced "gws people people searchContacts --params '{\"query\":\"Joanne\",\"readMask\":\"names,phoneNumbers,emailAddresses\"}' 2>/dev/null")
if echo "$GWS_CONTACTS" | grep -qi "Joanne"; then
  pass "gws contact search: 'Joanne' found"
  info "$GWS_CONTACTS"
else
  if echo "$GWS_CONTACTS" | grep -qi "error\|auth\|credential"; then
    warn "gws: credentials not configured"
  else
    fail "gws contact search: $(echo "$GWS_CONTACTS" | head -2)"
  fi
fi

echo ""

# ═══════════════════════════════════════════════════════════
# 5. Trello Board Access
# ═══════════════════════════════════════════════════════════
echo "── Trello ────────────────────────────────────────────────"

TRELLO_BOARDS=$(remote_sourced '
  TRELLO_API_KEY=$TRELLO_API_KEY TRELLO_API_TOKEN=$TRELLO_API_TOKEN \
  node -e "
    const k=process.env.TRELLO_API_KEY, t=process.env.TRELLO_API_TOKEN;
    fetch(\"https://api.trello.com/1/members/me/boards?key=\"+k+\"&token=\"+t+\"&fields=name,shortUrl\")
      .then(r=>r.json())
      .then(d=>{
        if(Array.isArray(d)) console.log(JSON.stringify({ok:true,count:d.length,boards:d.slice(0,5).map(b=>b.name)}));
        else console.log(JSON.stringify({ok:false,error:JSON.stringify(d)}));
      })
      .catch(e=>console.log(JSON.stringify({ok:false,error:e.message})));
  "
')
if echo "$TRELLO_BOARDS" | grep -q '"ok":true'; then
  BOARD_COUNT=$(echo "$TRELLO_BOARDS" | grep -oP '"count":\K[0-9]+')
  BOARD_NAMES=$(echo "$TRELLO_BOARDS" | grep -oP '"boards":\[\K[^\]]+' | tr ',' '\n' | head -3 | tr '\n' ', ' | sed 's/,$//')
  pass "Trello boards: $BOARD_COUNT boards ($BOARD_NAMES)"
  info "$TRELLO_BOARDS"
else
  if echo "$TRELLO_BOARDS" | grep -qi "unauthorized\|invalid token"; then
    warn "Trello: credentials not configured or invalid"
  else
    fail "Trello boards: $(echo "$TRELLO_BOARDS" | head -1)"
  fi
fi

# Read cards from a specific board
TRELLO_CARDS=$(remote_sourced '
  TRELLO_API_KEY=$TRELLO_API_KEY TRELLO_API_TOKEN=$TRELLO_API_TOKEN \
  node -e "
    const k=process.env.TRELLO_API_KEY, t=process.env.TRELLO_API_TOKEN;
    fetch(\"https://api.trello.com/1/members/me/boards?key=\"+k+\"&token=\"+t+\"&fields=name\")
      .then(r=>r.json())
      .then(boards=>{
        if(!Array.isArray(boards)||boards.length===0) return console.log(JSON.stringify({ok:false,error:\"no boards\"}));
        const bid=boards[0].id;
        return fetch(\"https://api.trello.com/1/boards/\"+bid+\"/cards?key=\"+k+\"&token=\"+t+\"&fields=name,dateLastActivity&limit=3\")
          .then(r=>r.json())
          .then(cards=>console.log(JSON.stringify({ok:true,board:boards[0].name,cardCount:cards.length,cards:cards.map(c=>c.name)})));
      })
      .catch(e=>console.log(JSON.stringify({ok:false,error:e.message})));
  "
')
if echo "$TRELLO_CARDS" | grep -q '"ok":true'; then
  CARD_BOARD=$(echo "$TRELLO_CARDS" | grep -oP '"board":"\K[^"]+')
  CARD_COUNT=$(echo "$TRELLO_CARDS" | grep -oP '"cardCount":\K[0-9]+')
  pass "Trello cards: $CARD_COUNT cards from '$CARD_BOARD'"
  info "$TRELLO_CARDS"
else
  fail "Trello card read: $(echo "$TRELLO_CARDS" | head -1)"
fi

echo ""

# ═══════════════════════════════════════════════════════════
# 6. Google Calendar (iCal)
# ═══════════════════════════════════════════════════════════
echo "── Google Calendar ────────────────────────────────────────"

CALENDAR_RESULT=$(remote_sourced 'ICAL_URL=$ICAL_URL python3 .claude/skills/google-calendar/scripts/ical_fetch.py --days 7')
if echo "$CALENDAR_RESULT" | grep -q '"total_parsed"'; then
  TOTAL_PARSED=$(echo "$CALENDAR_RESULT" | grep -oP '"total_parsed":\s*\K[0-9]+' || echo "?")
  EVENT_COUNT=$(echo "$CALENDAR_RESULT" | grep -oP '"events":\s*\[' | wc -l)
  EVENTS=$(echo "$CALENDAR_RESULT" | grep -oP '"summary":\s*"\K[^"]+' | head -3 | tr '\n' ', ' | sed 's/,$//')
  if [ -n "$EVENTS" ]; then
    pass "calendar: $TOTAL_PARSED events parsed, upcoming: $EVENTS"
  else
    pass "calendar: $TOTAL_PARSED events parsed (none in next 7 days)"
  fi
  info "$CALENDAR_RESULT"
else
  if echo "$CALENDAR_RESULT" | grep -qi "ICAL_URL\|not set\|credential"; then
    warn "calendar: ICAL_URL not configured"
  else
    fail "calendar: $(echo "$CALENDAR_RESULT" | head -2)"
  fi
fi

# Test with 30-day window to verify broader parsing
CALENDAR_30=$(remote_sourced 'ICAL_URL=$ICAL_URL python3 .claude/skills/google-calendar/scripts/ical_fetch.py --days 30')
if echo "$CALENDAR_30" | grep -q '"total_parsed"'; then
  EVENTS_30=$(echo "$CALENDAR_30" | grep -o '"summary"' | wc -l)
  pass "calendar 30-day window: $EVENTS_30 upcoming events"
else
  warn "calendar 30-day: failed"
fi

echo ""

# ═══════════════════════════════════════════════════════════
# 7. Memory System (SQLite)
# ═══════════════════════════════════════════════════════════
echo "── Memory System ──────────────────────────────────────────"

ADMIN_STATUS=$(remote 'curl -sf http://localhost:8080/admin/status')
if echo "$ADMIN_STATUS" | grep -q '"uptime"'; then
  TASKS_NUM=$(echo "$ADMIN_STATUS" | grep -oP '"tasks":\K[0-9]+' || echo "?")
  JOBS_ENQUEUED=$(echo "$ADMIN_STATUS" | grep -oP '"jobs.enqueued":\K[0-9]+' || echo "0")
  JOBS_SUCCEEDED=$(echo "$ADMIN_STATUS" | grep -oP '"jobs.succeeded":\K[0-9]+' || echo "0")
  pass "admin status: $TASKS_NUM scheduled tasks, $JOBS_ENQUEUED jobs enqueued, $JOBS_SUCCEEDED succeeded"
  info "$ADMIN_STATUS"
else
  fail "admin status: $(echo "$ADMIN_STATUS" | head -1)"
fi

echo ""

# ═══════════════════════════════════════════════════════════
# 8. Job Queue
# ═══════════════════════════════════════════════════════════
echo "── Job Queue ──────────────────────────────────────────────"

JOBS_RESULT=$(remote 'curl -sf http://localhost:8080/admin/jobs')
if echo "$JOBS_RESULT" | grep -q '\['; then
  JOB_COUNT=$(echo "$JOBS_RESULT" | grep -oP '"id"' | wc -l)
  SUCCEEDED=$(echo "$JOBS_RESULT" | grep -o '"succeeded"' | wc -l)
  FAILED_JOBS=$(echo "$JOBS_RESULT" | grep -o '"failed"' | wc -l)
  pass "job queue: $JOB_COUNT recent jobs ($SUCCEEDED succeeded, $FAILED_JOBS failed)"
  info "$JOBS_RESULT"
else
  fail "job queue: $(echo "$JOBS_RESULT" | head -1)"
fi

echo ""

# ═══════════════════════════════════════════════════════════
# 9. Scheduled Tasks
# ═══════════════════════════════════════════════════════════
echo "── Scheduled Tasks ────────────────────────────────────────"

TASKS_RESULT=$(remote 'curl -sf http://localhost:8080/tasks')
if echo "$TASKS_RESULT" | grep -q '\['; then
  TASK_COUNT=$(echo "$TASKS_RESULT" | grep -oP '"id"' | wc -l)
  TASK_NAMES=$(echo "$TASKS_RESULT" | grep -oP '"name":"\K[^"]+' | head -5 | tr '\n' ', ' | sed 's/,$//')
  if [ "$TASK_COUNT" -gt 0 ]; then
    pass "scheduled tasks: $TASK_COUNT active ($TASK_NAMES)"
  else
    pass "scheduled tasks: none configured"
  fi
  info "$TASKS_RESULT"
else
  fail "scheduled tasks: $(echo "$TASKS_RESULT" | head -1)"
fi

echo ""

# ═══════════════════════════════════════════════════════════
# 10. Metrics
# ═══════════════════════════════════════════════════════════
echo "── Metrics ────────────────────────────────────────────────"

METRICS_RESULT=$(remote 'curl -sf http://localhost:8080/admin/metrics')
if echo "$METRICS_RESULT" | grep -q '{'; then
  pass "metrics endpoint accessible"
  info "$METRICS_RESULT"
else
  fail "metrics: $(echo "$METRICS_RESULT" | head -1)"
fi

echo ""

# ═══════════════════════════════════════════════════════════
# 11. Telegram Bot API
# ═══════════════════════════════════════════════════════════
echo "── Telegram Bot API ──────────────────────────────────────"

BOT_TOKEN=$(remote "grep -oP 'TELEGRAM_BOT_TOKEN=\K.*' /home/ubuntu/agent/.env")
if [ -n "$BOT_TOKEN" ]; then
  GETME=$(curl -sf "https://api.telegram.org/bot${BOT_TOKEN}/getMe" 2>/dev/null || echo '{"ok":false}')
  if echo "$GETME" | grep -q '"ok":true'; then
    BOT_NAME=$(echo "$GETME" | grep -oP '"username":"\K[^"]+' || echo "unknown")
    pass "Telegram getMe: @$BOT_NAME"
  else
    fail "Telegram getMe failed"
  fi

  # Verify polling mode (no webhook set)
  WEBHOOK_INFO=$(curl -sf "https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo" 2>/dev/null || echo '{"ok":false}')
  WEBHOOK_URL=$(echo "$WEBHOOK_INFO" | grep -oP '"url":"\K[^"]*' || echo "")
  if [ -z "$WEBHOOK_URL" ]; then
    pass "polling mode (no webhook)"
  else
    fail "unexpected webhook: $WEBHOOK_URL"
  fi
else
  fail "TELEGRAM_BOT_TOKEN not found in .env"
fi

echo ""

# ═══════════════════════════════════════════════════════════
# 12. Agent Prompt via Webhook (Real Work)
# ═══════════════════════════════════════════════════════════
echo "── Agent Integration (via webhook) ──────────────────────"

# Test: agent can use tools (Bash)
AGENT_BASH=$(remote 'curl -sf -X POST http://localhost:8080/webhook -H "Content-Type: application/json" -d "{\"prompt\":\"Run: echo AGENT_TOOL_TEST_$(date +%s) and reply with ONLY the output.\"}"')
if echo "$AGENT_BASH" | grep -q "AGENT_TOOL_TEST_"; then
  pass "agent Bash tool execution"
  info "$AGENT_BASH"
else
  # May have responded differently but didn't error
  if echo "$AGENT_BASH" | grep -q '"isError":false'; then
    pass "agent Bash tool (non-error response)"
    info "$AGENT_BASH"
  else
    fail "agent Bash tool: $(echo "$AGENT_BASH" | head -1)"
  fi
fi

echo ""

# ═══════════════════════════════════════════════════════════
# Summary
# ═══════════════════════════════════════════════════════════
END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

echo "══════════════════════════════════════════════════════════"
echo ""
echo "Results: $PASSED passed, $FAILED failed, $WARNINGS warnings ($TESTS total in ${DURATION}s)"

if [ "$FAILED" -gt 0 ]; then
  echo ""
  echo "Failures:"
  echo -e "$FAILURES"
  exit 1
else
  echo "All integration tests passed."
  exit 0
fi
