#!/usr/bin/env bash
# Self-healing script for claude-agent service.
# Runs on the Lightsail instance via systemd timer.
# Restarts the service if it's not active.

set -euo pipefail

SERVICE="claude-agent"
LOG_TAG="self-heal"

if systemctl is-active --quiet "$SERVICE"; then
  exit 0
fi

logger -t "$LOG_TAG" "Service $SERVICE is not active. Restarting..."
systemctl restart "$SERVICE"
sleep 5

if systemctl is-active --quiet "$SERVICE"; then
  logger -t "$LOG_TAG" "Service $SERVICE restarted successfully."
else
  logger -t "$LOG_TAG" "Service $SERVICE failed to restart. Status: $(systemctl is-active $SERVICE 2>/dev/null || echo unknown)"
fi
