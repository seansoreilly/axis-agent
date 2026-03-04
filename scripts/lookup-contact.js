#!/usr/bin/env node

/**
 * Look up a Google Contact by name.
 *
 * Usage:
 *   node scripts/lookup-contact.js "Sean O'Reilly"
 *
 * Outputs JSON: {"name":"...","phones":["..."],"emails":["..."]}
 * Exit code 0 on match, 1 on no match or error.
 *
 * Credentials expected at:
 *   /home/ubuntu/.claude-agent/google-credentials.json  (OAuth client config)
 *   /home/ubuntu/.claude-agent/google-contacts-token.json  (refresh token)
 *
 * For local dev, falls back to ~/.claude-agent/ paths.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { google } from "googleapis";

const name = process.argv[2];
if (!name) {
  process.stderr.write("Usage: node scripts/lookup-contact.js <name>\n");
  process.exit(1);
}

// Resolve credential paths — server first, then local fallback
function resolvePath(filename) {
  const serverPath = join("/home/ubuntu/.claude-agent", filename);
  if (existsSync(serverPath)) return serverPath;

  const homedir = process.env.HOME || process.env.USERPROFILE;
  const localPath = join(homedir, ".claude-agent", filename);
  if (existsSync(localPath)) return localPath;

  process.stderr.write(`Cannot find ${filename}\n`);
  process.exit(1);
}

const credPath = resolvePath("google-credentials.json");
const tokenPath = resolvePath("google-contacts-token.json");

const raw = JSON.parse(readFileSync(credPath, "utf-8"));
const creds = raw.installed || raw.web;
const tokens = JSON.parse(readFileSync(tokenPath, "utf-8"));

const oauth2 = new google.auth.OAuth2(
  creds.client_id,
  creds.client_secret
);
oauth2.setCredentials(tokens);

const people = google.people({ version: "v1", auth: oauth2 });

try {
  const res = await people.people.searchContacts({
    query: name,
    readMask: "names,phoneNumbers,emailAddresses",
    pageSize: 5,
  });

  const results = res.data.results || [];
  if (results.length === 0) {
    process.stdout.write(JSON.stringify({ error: "no_match", query: name }) + "\n");
    process.exit(1);
  }

  // Return all matches
  const contacts = results.map((r) => {
    const person = r.person || {};
    const displayName =
      person.names?.[0]?.displayName || "Unknown";
    const phones = (person.phoneNumbers || []).map((p) => p.value);
    const emails = (person.emailAddresses || []).map((e) => e.value);
    return { name: displayName, phones, emails };
  });

  // Single match — flat output for easy parsing
  if (contacts.length === 1) {
    process.stdout.write(JSON.stringify(contacts[0]) + "\n");
  } else {
    process.stdout.write(JSON.stringify(contacts) + "\n");
  }
} catch (err) {
  process.stderr.write(`Lookup failed: ${err.message}\n`);
  process.exit(1);
}
