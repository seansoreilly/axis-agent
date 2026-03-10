#!/usr/bin/env node

import { SqliteStore } from "../dist/persistence.js";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const persistDir = "/home/ubuntu/.claude-agent/memory";

// Create or open the SQLite store
const store = new SqliteStore(persistDir);

// Create the scheduled task
const task = {
  id: "email-triage-hourly",
  name: "Email Triage Hourly",
  schedule: "0 8-22 * * *", // Every hour from 8 am to 10 pm
  prompt: "Run email triage: check for new arrivals and process backlog emails. Archive or unsubscribe from unwanted newsletters.",
  enabled: true,
};

try {
  store.upsertTask(task);
  console.log(`✅ Scheduled task added successfully:`);
  console.log(`   ID: ${task.id}`);
  console.log(`   Name: ${task.name}`);
  console.log(`   Schedule: ${task.schedule} (hourly from 8 am to 10 pm)`);
  console.log(`   Status: Enabled`);
} catch (error) {
  console.error("❌ Failed to add task:", error.message);
  process.exit(1);
}
