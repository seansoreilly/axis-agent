#!/usr/bin/env node

/**
 * One-time OAuth2 flow for Google Contacts (People API).
 * Run locally — opens a browser for consent, saves refresh token.
 *
 * Usage:
 *   node scripts/google-contacts-auth.js [path-to-credentials.json]
 *
 * Default credentials path: ~/.claude-agent/google-credentials.json
 * Saves token to: ~/.claude-agent/google-contacts-token.json
 */

import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { google } from "googleapis";
import { homedir } from "node:os";

const configDir = homedir() + "/.claude-agent";
const credPath = process.argv[2] || configDir + "/google-credentials.json";
const tokenPath = configDir + "/google-contacts-token.json";

const SCOPES = ["https://www.googleapis.com/auth/contacts.readonly"];
const REDIRECT_PORT = 3847;
const REDIRECT_URI = "http://localhost:" + REDIRECT_PORT + "/callback";

const raw = JSON.parse(readFileSync(credPath, "utf-8"));
const creds = raw.installed || raw.web;
if (!creds) {
  process.stderr.write("Invalid credentials file\n");
  process.exit(1);
}

const oauth2 = new google.auth.OAuth2(
  creds.client_id,
  creds.client_secret,
  REDIRECT_URI
);

const authUrl = oauth2.generateAuthUrl({
  access_type: "offline",
  prompt: "consent",
  scope: SCOPES,
});

process.stdout.write("\nOpen this URL in your browser:\n\n");
process.stdout.write(authUrl + "\n");
process.stdout.write("\nWaiting for OAuth callback...\n\n");

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost:" + REDIRECT_PORT);
  if (url.pathname !== "/callback") {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const code = url.searchParams.get("code");
  if (!code) {
    res.writeHead(400);
    res.end("Missing code parameter");
    return;
  }

  try {
    const { tokens } = await oauth2.getToken(code);
    writeFileSync(tokenPath, JSON.stringify(tokens, null, 2));
    process.stdout.write("Token saved to " + tokenPath + "\n");
    process.stdout.write(
      "\nNext steps:\n" +
        "1. Add to Bitwarden vault (google-contacts-token item)\n" +
        "2. Run: bash scripts/sync-secrets.sh\n\n"
    );
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<h1>Success!</h1><p>You can close this tab.</p>");
  } catch (err) {
    process.stderr.write("Token exchange failed: " + err.message + "\n");
    res.writeHead(500);
    res.end("Token exchange failed");
  } finally {
    server.close();
  }
});

server.listen(REDIRECT_PORT);
