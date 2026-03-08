#!/usr/bin/env node

/**
 * Export all Google Contacts to a JSON backup file.
 *
 * Usage:
 *   node scripts/backup-google-contacts.js [output-path]
 *
 * Default output: ~/.claude-agent/google-contacts-backup-YYYY-MM-DD.json
 *
 * Credentials expected at:
 *   ~/.claude-agent/google-credentials.json  (OAuth client config)
 *   ~/.claude-agent/google-contacts-token.json  (refresh token)
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { google } from "googleapis";

const configDir = join(homedir(), ".claude-agent");

function resolvePath(filename) {
  const serverPath = join("/home/ubuntu/.claude-agent", filename);
  if (existsSync(serverPath)) return serverPath;
  const localPath = join(configDir, filename);
  if (existsSync(localPath)) return localPath;
  process.stderr.write(`Cannot find ${filename}\n`);
  process.exit(1);
}

const credPath = resolvePath("google-credentials.json");
const tokenPath = resolvePath("google-contacts-token.json");

const raw = JSON.parse(readFileSync(credPath, "utf-8"));
const creds = raw.installed || raw.web;
const tokens = JSON.parse(readFileSync(tokenPath, "utf-8"));

const oauth2 = new google.auth.OAuth2(creds.client_id, creds.client_secret);
oauth2.setCredentials(tokens);

const people = google.people({ version: "v1", auth: oauth2 });

const allContacts = [];
let nextPageToken = undefined;
let page = 0;

process.stderr.write("Fetching contacts...\n");

do {
  const res = await people.people.connections.list({
    resourceName: "people/me",
    pageSize: 1000,
    pageToken: nextPageToken,
    personFields: [
      "names",
      "emailAddresses",
      "phoneNumbers",
      "organizations",
      "addresses",
      "birthdays",
      "urls",
      "biographies",
      "memberships",
      "metadata",
    ].join(","),
  });

  const connections = res.data.connections || [];
  allContacts.push(...connections);
  nextPageToken = res.data.nextPageToken;
  page++;
  process.stderr.write(`  Page ${page}: ${connections.length} contacts (total: ${allContacts.length})\n`);
} while (nextPageToken);

process.stderr.write(`\nTotal contacts: ${allContacts.length}\n`);

// Build a clean summary for each contact
const summary = allContacts.map((c) => ({
  resourceName: c.resourceName,
  name: c.names?.[0]?.displayName || null,
  givenName: c.names?.[0]?.givenName || null,
  familyName: c.names?.[0]?.familyName || null,
  emails: (c.emailAddresses || []).map((e) => ({ value: e.value, type: e.type })),
  phones: (c.phoneNumbers || []).map((p) => ({ value: p.value, type: p.type })),
  organizations: (c.organizations || []).map((o) => ({ name: o.name, title: o.title })),
  addresses: (c.addresses || []).map((a) => ({ formatted: a.formattedValue, type: a.type })),
  birthday: c.birthdays?.[0]?.date || null,
  urls: (c.urls || []).map((u) => u.value),
  notes: c.biographies?.[0]?.value || null,
  groups: (c.memberships || [])
    .filter((m) => m.contactGroupMembership)
    .map((m) => m.contactGroupMembership.contactGroupResourceName),
  source: c.metadata?.sources?.[0]?.type || null,
  updatedTime: c.metadata?.sources?.[0]?.updateTime || null,
}));

const date = new Date().toISOString().slice(0, 10);
const outputPath = process.argv[2] || join(configDir, `google-contacts-backup-${date}.json`);

const output = {
  exportDate: new Date().toISOString(),
  totalContacts: summary.length,
  contacts: summary,
};

writeFileSync(outputPath, JSON.stringify(output, null, 2));
process.stderr.write(`Backup saved to: ${outputPath}\n`);

// Print quick stats
const withEmail = summary.filter((c) => c.emails.length > 0).length;
const withPhone = summary.filter((c) => c.phones.length > 0).length;
const withName = summary.filter((c) => c.name).length;
const noName = summary.filter((c) => !c.name).length;
const withOrg = summary.filter((c) => c.organizations.length > 0).length;

process.stderr.write(`\nStats:\n`);
process.stderr.write(`  With name: ${withName}\n`);
process.stderr.write(`  Without name: ${noName}\n`);
process.stderr.write(`  With email: ${withEmail}\n`);
process.stderr.write(`  With phone: ${withPhone}\n`);
process.stderr.write(`  With organization: ${withOrg}\n`);
