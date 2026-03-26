#!/usr/bin/env node

import { SqliteStore } from "../dist/persistence.js";

const persistDir = "/home/ubuntu/.claude-agent/memory";
const store = new SqliteStore(persistDir);

const task = {
  id: "gws-token-health",
  name: "gws Token Health Check",
  schedule: "0 7 * * *", // Daily at 7 AM Melbourne time (before email triage at 8 AM)
  prompt: "The gws OAuth token has expired or been revoked. Send me a Telegram message explaining the issue and include the re-auth URL: http://100.99.15.13:8080/admin/gws-auth (requires gateway bearer token auth). Do NOT attempt to fix it yourself — I need to re-authenticate via browser.",
  enabled: true,
  checkCommand: "bash scripts/check-gws-token.sh",
};

try {
  store.upsertTask(task);
  console.log(`Task added: ${task.id} (${task.schedule})`);
} catch (error) {
  console.error("Failed to add task:", error.message);
  process.exit(1);
}
