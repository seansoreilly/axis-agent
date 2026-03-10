#!/usr/bin/env node

import { SqliteStore } from "../dist/persistence.js";

const persistDir = "/home/ubuntu/.claude-agent/memory";
const store = new SqliteStore(persistDir);

try {
  const removed = store.deleteTask("email-triage");
  if (removed) {
    console.log("✅ Daily email triage task removed");
    console.log("   Removed: email-triage (7 AM daily)");
    console.log("   Keeping: email-triage-hourly (8 AM–10 PM hourly)");
  } else {
    console.log("❌ Task not found");
  }
} catch (error) {
  console.error("❌ Failed to remove task:", error.message);
  process.exit(1);
}
