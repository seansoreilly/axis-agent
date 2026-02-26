#!/usr/bin/env bash
# Self-deploy: rebuild and restart the agent service on the local server.
# Intended to be run BY the agent itself via Bash tool.
set -euo pipefail

AGENT_DIR="/home/ubuntu/agent"
cd "$AGENT_DIR"

# Fix ownership if dist/ was previously built as root
if [ -d "$AGENT_DIR/dist" ]; then
  sudo chown -R ubuntu:ubuntu "$AGENT_DIR/dist"
fi

echo "==> Installing all dependencies (including dev for build)..."
npm install 2>&1

echo "==> Building TypeScript..."
./node_modules/.bin/tsc 2>&1

echo "==> Pruning dev dependencies..."
npm prune --omit=dev 2>&1

echo "==> Installing systemd service..."
sudo cp "$AGENT_DIR/systemd/claude-agent.service" /etc/systemd/system/
sudo systemctl daemon-reload

echo "==> Restarting service..."
sudo systemctl restart claude-agent

# Give it a moment to start
sleep 3

echo "==> Checking service status..."
sudo systemctl status claude-agent --no-pager 2>&1 || true

echo "==> Deploy complete."
