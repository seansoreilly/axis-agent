#!/usr/bin/env bash
# Post-deploy regression test: verifies the Telegram bot API is responsive
# and the gateway health endpoint is reachable after deployment.
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

# --- Export for callers ---
export FAILURE_DETAILS="$FAILURES"
export CHECK_ERRORS="$ERRORS"

# --- 6. Recent logs on failure (grab last 30 lines for diagnostics) ---
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
