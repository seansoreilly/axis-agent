#!/usr/bin/env bash
# Health check for claude-code-agent Lightsail instance.
# 1. Ensures local Tailscale is running
# 2. Checks Lightsail instance state via AWS CLI
# 3. Verifies SSH + service health; reboots if unresponsive
# 4. Verifies Tailscale connectivity to all nodes
# Designed to run from a local cron every 30 minutes.

set -euo pipefail

INSTANCE_NAME="claude-code-agent"
REGION="${AWS_DEFAULT_REGION:-ap-southeast-2}"
SSH_KEY="$HOME/.ssh/claude-code-agent-key.pem"
SSH_USER="ubuntu"
SSH_HOST="${DEPLOY_HOST_IP:?Set DEPLOY_HOST_IP env var}"
LOG_FILE="$HOME/.claude-agent/health-check.log"
SSH_TIMEOUT=10
ERRORS=0

log() {
  echo "$(date -Iseconds) $1" | tee -a "$LOG_FILE"
}

mkdir -p "$(dirname "$LOG_FILE")"

log "--- Health check started ---"

# =============================================================
# Step 1: Ensure local Tailscale is running
# =============================================================
if ! tailscale status &>/dev/null; then
  log "WARN: Local tailscaled not running. Starting..."
  if sudo -n systemctl start tailscaled 2>/dev/null; then
    sleep 3
    if tailscale status &>/dev/null; then
      log "OK: Local tailscaled started."
    else
      log "ERROR: tailscaled started but not responding."
      ERRORS=$((ERRORS + 1))
    fi
  else
    log "ERROR: Cannot start tailscaled (sudo requires password). Run: sudo systemctl start tailscaled"
    ERRORS=$((ERRORS + 1))
  fi
fi

# =============================================================
# Step 2: Check instance state via AWS CLI
# =============================================================
INSTANCE_STATE=$(aws lightsail get-instance-state \
  --instance-name "$INSTANCE_NAME" \
  --region "$REGION" \
  --query 'state.name' \
  --output text 2>/dev/null || echo "unknown")

if [ "$INSTANCE_STATE" != "running" ]; then
  log "WARN: Instance state is '$INSTANCE_STATE' — not running"

  if [ "$INSTANCE_STATE" = "stopped" ]; then
    log "ACTION: Starting stopped instance..."
    aws lightsail start-instance \
      --instance-name "$INSTANCE_NAME" \
      --region "$REGION"
    log "OK: Start command sent. Will verify on next cycle."
  else
    log "WARN: Unexpected state '$INSTANCE_STATE' — skipping action."
  fi
  exit 0
fi

# =============================================================
# Step 3: Instance reports running — verify SSH + service
# =============================================================
if ssh -i "$SSH_KEY" \
  -o ConnectTimeout="$SSH_TIMEOUT" \
  -o StrictHostKeyChecking=no \
  -o BatchMode=yes \
  "${SSH_USER}@${SSH_HOST}" \
  "true" 2>/dev/null; then

  SERVICE_STATUS=$(ssh -i "$SSH_KEY" \
    -o ConnectTimeout="$SSH_TIMEOUT" \
    -o BatchMode=yes \
    "${SSH_USER}@${SSH_HOST}" \
    "systemctl is-active claude-agent 2>/dev/null || echo 'inactive'" 2>/dev/null)

  if [ "$SERVICE_STATUS" = "active" ]; then
    log "OK: Instance running, SSH reachable, service active."
  else
    log "WARN: SSH OK but service is '$SERVICE_STATUS'. Restarting service..."
    ssh -i "$SSH_KEY" \
      -o ConnectTimeout="$SSH_TIMEOUT" \
      -o BatchMode=yes \
      "${SSH_USER}@${SSH_HOST}" \
      "sudo systemctl restart claude-agent" 2>/dev/null

    sleep 5

    SERVICE_STATUS=$(ssh -i "$SSH_KEY" \
      -o ConnectTimeout="$SSH_TIMEOUT" \
      -o BatchMode=yes \
      "${SSH_USER}@${SSH_HOST}" \
      "systemctl is-active claude-agent 2>/dev/null || echo 'inactive'" 2>/dev/null)

    if [ "$SERVICE_STATUS" = "active" ]; then
      log "OK: Service restarted successfully."
    else
      log "ERROR: Service restart failed (status: $SERVICE_STATUS). Rebooting instance..."
      aws lightsail reboot-instance \
        --instance-name "$INSTANCE_NAME" \
        --region "$REGION"
      log "ACTION: Reboot command sent."
      ERRORS=$((ERRORS + 1))
    fi
  fi
else
  log "ERROR: Instance reports 'running' but SSH unreachable. Rebooting..."
  aws lightsail reboot-instance \
    --instance-name "$INSTANCE_NAME" \
    --region "$REGION"
  log "ACTION: Reboot command sent. Will verify on next cycle."
  ERRORS=$((ERRORS + 1))
fi

# =============================================================
# Step 4: Verify Tailscale connectivity to all nodes
# =============================================================
if tailscale status &>/dev/null; then
  PEER_JSON=$(tailscale status --json 2>/dev/null || echo "{}")

  # Extract peer info using jq: name, online status, first IP
  PEER_INFO=$(echo "$PEER_JSON" | jq -r '
    .Peer // {} | to_entries[] |
    "\(.value.HostName // "unknown")\t\(.value.Online // false)\t\(.value.TailscaleIPs[0] // "")"
  ' 2>/dev/null || true)

  if [ -z "$PEER_INFO" ]; then
    log "WARN: No Tailscale peers found."
  else
    while IFS=$'\t' read -r name online ip; do
      if [ "$online" = "true" ]; then
        if tailscale ping --timeout=5s "$ip" &>/dev/null; then
          log "OK: Tailscale node '$name' ($ip) reachable."
        else
          log "WARN: Tailscale node '$name' ($ip) online but ping failed (possible DERP relay issue)."
          ERRORS=$((ERRORS + 1))
        fi
      else
        log "INFO: Tailscale node '$name' ($ip) offline."
      fi
    done <<< "$PEER_INFO"
  fi
else
  log "WARN: Tailscale not available — skipping peer checks."
fi

# =============================================================
# Summary
# =============================================================
if [ "$ERRORS" -eq 0 ]; then
  log "--- Health check completed: ALL OK ---"
  exit 0
else
  log "--- Health check completed: $ERRORS issue(s) found ---"
  exit 1
fi
