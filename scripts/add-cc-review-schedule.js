#!/usr/bin/env node

import { SqliteStore } from "../dist/persistence.js";

const persistDir = "/home/ubuntu/.claude-agent/memory";
const store = new SqliteStore(persistDir);

const task = {
  id: "cc-feature-audit-daily",
  name: "Claude Code CLI Feature Audit",
  schedule: "0 2 * * *", // Daily at 2 AM Melbourne time
  prompt: `Perform a full Claude Code CLI feature audit following the /review-cc-updates skill instructions in .claude/skills/review-cc-updates/SKILL.md. Audit ALL current CLI features against the agent's usage. Adopt improvements, test, commit, and deploy autonomously. Send a summary of what changed (or "no changes needed") as the response.`,
  enabled: true,
};

try {
  store.upsertTask(task);
  console.log(`Task added: ${task.id} (${task.schedule})`);
} catch (error) {
  console.error("Failed to add task:", error.message);
  process.exit(1);
}
