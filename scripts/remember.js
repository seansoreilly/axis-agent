#!/usr/bin/env node
/**
 * CLI helper for the agent to read/write persistent memory facts.
 * Usage:
 *   remember.js set <key> <value>            — store a fact (auto-categorized)
 *   remember.js set <key> <value> --cat <c>  — store with explicit category
 *   remember.js delete <key>                 — remove a fact
 *   remember.js list                         — list all facts
 *
 * Categories: personal, work, preference, system, general
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const MEMORY_DIR = process.env.MEMORY_DIR || "/home/ubuntu/.claude-agent/memory";
const STORE_PATH = join(MEMORY_DIR, "store.json");

const VALID_CATEGORIES = ["personal", "work", "preference", "system", "general"];

function inferCategory(key) {
  const k = key.toLowerCase();
  if (/name|birthday|location|timezone|email|phone|address/.test(k)) return "personal";
  if (/project|employer|role|repo|stack|work|client/.test(k)) return "work";
  if (/prefer|style|favorite|language|tool/.test(k)) return "preference";
  if (/deploy|server|service|config|infra/.test(k)) return "system";
  return "general";
}

function load() {
  if (existsSync(STORE_PATH)) {
    return JSON.parse(readFileSync(STORE_PATH, "utf-8"));
  }
  return { facts: {}, sessions: [] };
}

function save(data) {
  if (!existsSync(MEMORY_DIR)) mkdirSync(MEMORY_DIR, { recursive: true });
  writeFileSync(STORE_PATH, JSON.stringify(data, null, 2));
}

function sanitizeKey(raw) {
  return raw.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/^_+|_+$/g, "");
}

const [, , cmd, ...args] = process.argv;

switch (cmd) {
  case "set": {
    // Parse --cat flag if present
    const catIdx = args.indexOf("--cat");
    let category = null;
    let valueArgs = args;
    if (catIdx >= 0 && args[catIdx + 1]) {
      category = args[catIdx + 1];
      valueArgs = [...args.slice(0, catIdx), ...args.slice(catIdx + 2)];
    }

    const key = sanitizeKey(valueArgs[0] || "");
    const value = valueArgs.slice(1).join(" ");
    if (!key || !value) {
      console.error("Usage: remember.js set <key> <value> [--cat <category>]");
      process.exit(1);
    }

    if (category && !VALID_CATEGORIES.includes(category)) {
      console.error(`Invalid category: ${category}. Valid: ${VALID_CATEGORIES.join(", ")}`);
      process.exit(1);
    }

    const data = load();
    const now = new Date().toISOString();
    const existing = data.facts[key];

    // Support both legacy string format and new structured format
    const isStructured = existing && typeof existing === "object" && "value" in existing;

    data.facts[key] = {
      value,
      category: category || (isStructured ? existing.category : inferCategory(key)),
      createdAt: isStructured ? existing.createdAt : now,
      updatedAt: now,
      lastAccessedAt: now,
    };
    save(data);
    console.log(`Remembered: ${key} = ${value} [${data.facts[key].category}]`);
    break;
  }
  case "delete": {
    const key = sanitizeKey(args[0] || "");
    if (!key) {
      console.error("Usage: remember.js delete <key>");
      process.exit(1);
    }
    const data = load();
    if (key in data.facts) {
      delete data.facts[key];
      save(data);
      console.log(`Forgot: ${key}`);
    } else {
      console.log(`No memory found for: ${key}`);
    }
    break;
  }
  case "list": {
    const data = load();
    const entries = Object.entries(data.facts);
    if (entries.length === 0) {
      console.log("No memories stored.");
    } else {
      entries.forEach(([k, v]) => {
        if (typeof v === "object" && v !== null && "value" in v) {
          console.log(`${k}: ${v.value} [${v.category}]`);
        } else {
          console.log(`${k}: ${v}`);
        }
      });
    }
    break;
  }
  default:
    console.error("Usage: remember.js <set|delete|list> [args...]");
    process.exit(1);
}
