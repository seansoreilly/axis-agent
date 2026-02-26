#!/usr/bin/env node
/**
 * CLI helper for the agent to read/write persistent memory facts.
 * Usage:
 *   remember.js set <key> <value>   — store a fact
 *   remember.js delete <key>        — remove a fact
 *   remember.js list                — list all facts
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const MEMORY_DIR = process.env.MEMORY_DIR || "/home/ubuntu/.claude-agent/memory";
const STORE_PATH = join(MEMORY_DIR, "store.json");

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
    const key = sanitizeKey(args[0] || "");
    const value = args.slice(1).join(" ");
    if (!key || !value) {
      console.error("Usage: remember.js set <key> <value>");
      process.exit(1);
    }
    const data = load();
    data.facts[key] = value;
    save(data);
    console.log(`Remembered: ${key} = ${value}`);
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
      entries.forEach(([k, v]) => console.log(`${k}: ${v}`));
    }
    break;
  }
  default:
    console.error("Usage: remember.js <set|delete|list> [args...]");
    process.exit(1);
}
