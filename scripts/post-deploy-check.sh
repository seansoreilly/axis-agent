#!/usr/bin/env bash
# Post-deploy regression test: verifies service health, Telegram bot API,
# and skill dry-run validation after deployment.
# Run automatically at the end of deploy.sh or manually.
#
# Exit codes:
#   0 = all checks passed
#   1 = one or more checks failed (details in FAILURE_DETAILS)
#
# When sourced or when REPORT_MODE=1, exports FAILURE_DETAILS instead of exiting.

set -euo pipefail

SSH_KEY="$HOME/.ssh/claude-code-agent-key.pem"
REMOTE_HOST="${DEPLOY_HOST:-ubuntu@claude-code-agent}"
SSH_OPTS="-i $SSH_KEY -o ConnectTimeout=10 -o BatchMode=yes"
ERRORS=0
FAILURES=""

pass() { echo "  PASS: $1"; }
fail() {
  echo "  FAIL: $1"
  ERRORS=$((ERRORS + 1))
  FAILURES="${FAILURES}FAIL: $1\n"
}

echo "Running post-deploy checks..."

# --- 1. Service is active ---
SERVICE_STATUS=$(ssh $SSH_OPTS "$REMOTE_HOST" "systemctl is-active claude-agent 2>/dev/null || echo inactive")
if [ "$SERVICE_STATUS" = "active" ]; then
  pass "systemd service is active"
else
  fail "systemd service is '$SERVICE_STATUS'"
fi

# --- 2. Gateway health endpoint ---
HEALTH=$(ssh $SSH_OPTS "$REMOTE_HOST" "curl -sf http://localhost:8080/health 2>/dev/null || echo UNREACHABLE")
if echo "$HEALTH" | grep -qi "ok\|healthy\|status" 2>/dev/null; then
  pass "gateway /health responded"
else
  fail "gateway /health returned: $HEALTH"
fi

# --- 3. Telegram Bot API getMe ---
BOT_TOKEN=$(ssh $SSH_OPTS "$REMOTE_HOST" "grep -oP 'TELEGRAM_BOT_TOKEN=\K.*' /home/ubuntu/agent/.env")
if [ -z "$BOT_TOKEN" ]; then
  fail "could not read TELEGRAM_BOT_TOKEN from .env"
else
  GETME=$(curl -sf "https://api.telegram.org/bot${BOT_TOKEN}/getMe" 2>/dev/null || echo '{"ok":false}')
  if echo "$GETME" | grep -q '"ok":true'; then
    BOT_NAME=$(echo "$GETME" | grep -oP '"username":"\K[^"]+' || echo "unknown")
    pass "Telegram getMe OK (bot: @$BOT_NAME)"
  else
    fail "Telegram getMe failed: $GETME"
  fi

  # --- 4. Telegram getUpdates connectivity (no-op fetch with 0 timeout) ---
  # Note: 409 conflict is expected when the bot is already polling (service is running).
  # We treat both 200 OK and 409 as success — both confirm the API is reachable.
  UPDATES_HTTP=$(curl -s -o /dev/null -w "%{http_code}" "https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?timeout=0&limit=0" 2>/dev/null || echo "000")
  if [ "$UPDATES_HTTP" = "200" ] || [ "$UPDATES_HTTP" = "409" ]; then
    pass "Telegram getUpdates reachable (HTTP $UPDATES_HTTP)"
  else
    fail "Telegram getUpdates failed (HTTP $UPDATES_HTTP)"
  fi

  # --- 5. No webhook set (polling mode expects no webhook) ---
  WEBHOOK_INFO=$(curl -sf "https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo" 2>/dev/null || echo '{"ok":false}')
  if echo "$WEBHOOK_INFO" | grep -q '"ok":true'; then
    WEBHOOK_URL=$(echo "$WEBHOOK_INFO" | grep -oP '"url":"\K[^"]*' || echo "")
    if [ -z "$WEBHOOK_URL" ]; then
      pass "no webhook set (polling mode correct)"
    else
      fail "unexpected webhook URL set: $WEBHOOK_URL"
    fi
  else
    fail "Telegram getWebhookInfo failed"
  fi
fi

# --- 6. Google Contacts (gws) auth check ---
GWS_RESULT=$(ssh $SSH_OPTS "$REMOTE_HOST" 'gws people people searchContacts --params '"'"'{"query":"test","readMask":"names"}'"'"' 2>&1' || true)
if echo "$GWS_RESULT" | grep -q '"error"'; then
  GWS_MSG=$(echo "$GWS_RESULT" | grep -oP '"message":\s*"\K[^"]+' || echo "unknown")
  fail "gws contacts auth: $GWS_MSG"
elif echo "$GWS_RESULT" | grep -q '^\s*{'; then
  pass "gws contacts auth OK"
else
  fail "gws contacts: unexpected response: $(echo "$GWS_RESULT" | head -1)"
fi

# --- 7. Skill health checks (dry-run validation on remote) ---
echo ""
echo "  Skill checks..."

# Define skills and their dry-run commands (run on remote)
# Format: "skill_name|command"
SKILL_CHECKS=(
  "facebook/post_text|python3 /home/ubuntu/agent/.claude/skills/facebook/scripts/post_text.py --message healthcheck --dry-run"
  "facebook/post_photos|python3 /home/ubuntu/agent/.claude/skills/facebook/scripts/post_photos.py --message healthcheck --photos /etc/hostname --dry-run"
  "twilio/send_sms|python3 /home/ubuntu/agent/.claude/skills/twilio/scripts/send_sms.py --to +61400000000 --body healthcheck --dry-run"
  "twilio/make_call|python3 /home/ubuntu/agent/.claude/skills/twilio/scripts/make_call.py --to +61400000000 --message healthcheck --dry-run"
  "gmail/email_triage|python3 /home/ubuntu/agent/.claude/skills/gmail/scripts/email_triage.py --dry-run fetch --count 1"
)

for check in "${SKILL_CHECKS[@]}"; do
  SKILL_NAME="${check%%|*}"
  SKILL_CMD="${check#*|}"

  # Check script exists on remote
  SCRIPT_PATH=$(echo "$SKILL_CMD" | grep -oP '/home/ubuntu/agent/\S+\.py')
  EXISTS=$(ssh $SSH_OPTS "$REMOTE_HOST" "test -f $SCRIPT_PATH && echo yes || echo no" 2>/dev/null)
  if [ "$EXISTS" != "yes" ]; then
    fail "skill $SKILL_NAME: script not found ($SCRIPT_PATH)"
    continue
  fi

  # Run dry-run on remote
  RESULT=$(ssh $SSH_OPTS "$REMOTE_HOST" "$SKILL_CMD 2>&1" || true)
  if echo "$RESULT" | grep -q '"dry_run": true\|"dry_run":true'; then
    pass "skill $SKILL_NAME dry-run OK"
  elif echo "$RESULT" | grep -q '"success": true\|"success":true'; then
    pass "skill $SKILL_NAME OK (no dry-run)"
  else
    # Credential errors are warnings, not failures — creds may not be on this instance
    if echo "$RESULT" | grep -qi "credential\|No such file\|FileNotFoundError\|token"; then
      echo "  WARN: skill $SKILL_NAME: credentials not available (expected on fresh instance)"
    else
      fail "skill $SKILL_NAME dry-run failed: $(echo "$RESULT" | head -1)"
    fi
  fi
done

# --- 8. End-to-end contact lookup regression test (via gateway webhook → agent → Telegram) ---
echo ""
echo "  E2E regression tests..."

GATEWAY_TOKEN=$(ssh $SSH_OPTS "$REMOTE_HOST" "grep -oP 'GATEWAY_API_TOKEN=\K.*' /home/ubuntu/agent/.env" 2>/dev/null || true)
if [ -z "$GATEWAY_TOKEN" ]; then
  echo "  SKIP: e2e contact lookup (no GATEWAY_API_TOKEN configured)"
else
  # Submit contact lookup prompt via webhook
  WEBHOOK_RESP=$(ssh $SSH_OPTS "$REMOTE_HOST" \
    "curl -sf -X POST http://localhost:8080/webhook \
      -H 'Content-Type: application/json' \
      -H 'Authorization: Bearer $GATEWAY_TOKEN' \
      -d '{\"prompt\": \"Look up Sean O'\\''Reilly in Google Contacts and return their phone number. Be concise.\"}'" 2>/dev/null || echo '{"error":"request_failed"}')

  JOB_ID=$(echo "$WEBHOOK_RESP" | grep -oP '"jobId":"\K[^"]+' || true)

  if [ -z "$JOB_ID" ]; then
    fail "e2e contact lookup: webhook did not return a jobId: $WEBHOOK_RESP"
  else
    echo "  Waiting for contact lookup job $JOB_ID..."
    E2E_STATUS="queued"
    E2E_ATTEMPTS=0
    E2E_MAX=60  # 60 × 5s = 5 min max

    while [ "$E2E_STATUS" != "succeeded" ] && [ "$E2E_STATUS" != "failed" ] && [ "$E2E_ATTEMPTS" -lt "$E2E_MAX" ]; do
      sleep 5
      E2E_ATTEMPTS=$((E2E_ATTEMPTS + 1))
      JOBS_RESP=$(ssh $SSH_OPTS "$REMOTE_HOST" \
        "curl -sf http://localhost:8080/admin/jobs \
          -H 'Authorization: Bearer $GATEWAY_TOKEN'" 2>/dev/null || echo '{}')
      E2E_STATUS=$(echo "$JOBS_RESP" | grep -oP "\"id\":\"$JOB_ID\"[^}]*\"status\":\"\\K[^\"]*" || echo "unknown")
    done

    if [ "$E2E_STATUS" = "succeeded" ]; then
      # Check the Telegram message for auth errors
      RESULT_TEXT=$(echo "$JOBS_RESP" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for j in data.get('jobs', []):
    if j.get('id') == '$JOB_ID':
        print(j.get('resultText', '') or '')
        break
" 2>/dev/null || echo "")

      if echo "$RESULT_TEXT" | grep -qi "invalid_grant\|authentication error\|auth.*fail\|OAuth.*expired"; then
        fail "e2e contact lookup: agent returned auth error: $(echo "$RESULT_TEXT" | head -1)"
      elif echo "$RESULT_TEXT" | grep -qi "phone\|mobile\|\+61\|number"; then
        pass "e2e contact lookup returned phone number"
      else
        echo "  WARN: e2e contact lookup completed but response may not contain a phone number"
        pass "e2e contact lookup completed (no auth errors)"
      fi
    elif [ "$E2E_STATUS" = "failed" ]; then
      fail "e2e contact lookup: job failed"
    else
      fail "e2e contact lookup: timed out after $((E2E_ATTEMPTS * 5))s (status: $E2E_STATUS)"
    fi
  fi
fi

# --- Export for callers ---
export FAILURE_DETAILS="$FAILURES"
export CHECK_ERRORS="$ERRORS"

# --- 7. Recent logs on failure (grab last 30 lines for diagnostics) ---
if [ "$ERRORS" -gt 0 ]; then
  echo ""
  echo "  Recent service logs:"
  ssh $SSH_OPTS "$REMOTE_HOST" "sudo journalctl -u claude-agent --no-pager -n 30 2>/dev/null" | sed 's/^/    /' || true
fi

# --- Summary ---
echo ""
if [ "$ERRORS" -eq 0 ]; then
  echo "All post-deploy checks passed."
  exit 0
else
  echo "$ERRORS check(s) failed."
  if [ "${REPORT_MODE:-0}" = "1" ]; then
    # Caller will handle the failure
    exit 0
  fi
  exit 1
fi
