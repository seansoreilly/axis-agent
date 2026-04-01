import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { info, error as logError } from "./logger.js";
import { errorMessage } from "./utils.js";

const CREDENTIALS_PATH = join(homedir(), ".claude", ".credentials.json");
const TOKEN_ENDPOINT = "https://platform.claude.com/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const SCOPES = "user:profile user:inference user:sessions:claude_code user:mcp_servers";

/** Refresh the token this many ms before it actually expires. */
const REFRESH_BUFFER_MS = 10 * 60 * 1000; // 10 minutes

interface ClaudeOAuth {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
  subscriptionType?: string;
  rateLimitTier?: string;
}

interface CredentialsFile {
  claudeAiOauth: ClaudeOAuth;
  [key: string]: unknown;
}

function readCredentials(): CredentialsFile {
  const raw = readFileSync(CREDENTIALS_PATH, "utf-8");
  return JSON.parse(raw) as CredentialsFile;
}

function writeCredentials(creds: CredentialsFile): void {
  writeFileSync(CREDENTIALS_PATH, JSON.stringify(creds, null, 2), { encoding: "utf-8", mode: 0o600 });
}

/**
 * Returns true if the access token needs refreshing (expired or within buffer).
 */
export function tokenNeedsRefresh(): boolean {
  try {
    const creds = readCredentials();
    const expiresAt = creds.claudeAiOauth.expiresAt;
    return Date.now() >= expiresAt - REFRESH_BUFFER_MS;
  } catch {
    return true;
  }
}

/**
 * Refresh the OAuth access token using the refresh token.
 * Updates the credentials file in place.
 * Returns true on success, false on failure.
 */
export async function refreshAccessToken(): Promise<boolean> {
  try {
    const creds = readCredentials();
    const { refreshToken } = creds.claudeAiOauth;

    if (!refreshToken) {
      logError("auth", "No refresh token available — re-authentication required");
      return false;
    }

    info("auth", "Refreshing OAuth access token...");

    const response = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "claude-code/1.0",
      },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
        scope: SCOPES,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      logError("auth", `Token refresh failed (${response.status}): ${body}`);
      return false;
    }

    const data = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };

    creds.claudeAiOauth.accessToken = data.access_token;
    if (data.refresh_token) {
      creds.claudeAiOauth.refreshToken = data.refresh_token;
    }
    creds.claudeAiOauth.expiresAt = Date.now() + data.expires_in * 1000;

    writeCredentials(creds);

    const expiresInHrs = (data.expires_in / 3600).toFixed(1);
    info("auth", `Token refreshed successfully. Expires in ${expiresInHrs}h`);
    return true;
  } catch (err) {
    logError("auth", `Token refresh error: ${errorMessage(err)}`);
    return false;
  }
}

/**
 * Ensure the token is valid, refreshing if needed.
 * Returns true if the token is valid after the check.
 */
export async function ensureValidToken(): Promise<boolean> {
  if (!tokenNeedsRefresh()) {
    return true;
  }
  return refreshAccessToken();
}

/**
 * Start a periodic timer that checks and refreshes the token.
 * Returns the interval handle for cleanup.
 */
export function startTokenRefreshTimer(intervalMs = 30 * 60 * 1000): ReturnType<typeof setInterval> {
  info("auth", `Token refresh timer started (every ${intervalMs / 60000}min)`);
  return setInterval(async () => {
    if (tokenNeedsRefresh()) {
      const ok = await refreshAccessToken();
      if (!ok) {
        logError("auth", "Automatic token refresh failed — agent calls will fail until resolved");
      }
    }
  }, intervalMs);
}
