import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { info, error as logError } from "./logger.js";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

const GWS_OAUTH = {
  get clientId(): string { return requiredEnv("GWS_OAUTH_CLIENT_ID"); },
  get clientSecret(): string { return requiredEnv("GWS_OAUTH_CLIENT_SECRET"); },
  tokenEndpoint: "https://oauth2.googleapis.com/token",
  scopes: [
    "https://www.googleapis.com/auth/contacts.readonly",
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/calendar",
  ],
  redirectUri: "http://localhost",
} as const;

const CREDENTIALS_PATH = `${homedir()}/.config/gws/credentials.json`;

export interface GwsTokenStatus {
  valid: boolean;
  error?: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  error?: string;
  error_description?: string;
}

/** Build the Google OAuth consent URL for re-authentication. */
export function buildConsentUrl(): string {
  const params = new URLSearchParams({
    client_id: GWS_OAUTH.clientId,
    redirect_uri: GWS_OAUTH.redirectUri,
    response_type: "code",
    scope: GWS_OAUTH.scopes.join(" "),
    access_type: "offline",
    prompt: "consent",
  });
  return `https://accounts.google.com/o/oauth2/auth?${params.toString()}`;
}

/** Exchange an authorization code for OAuth tokens. */
export async function exchangeCodeForTokens(code: string): Promise<{ refreshToken: string; accessToken: string }> {
  const response = await fetch(GWS_OAUTH.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: GWS_OAUTH.clientId,
      client_secret: GWS_OAUTH.clientSecret,
      redirect_uri: GWS_OAUTH.redirectUri,
      grant_type: "authorization_code",
    }),
  });

  const data = (await response.json()) as TokenResponse;

  if (data.error) {
    throw new Error(`Token exchange failed: ${data.error_description ?? data.error}`);
  }

  if (!data.refresh_token) {
    throw new Error("No refresh_token in response — ensure prompt=consent was used");
  }

  return { refreshToken: data.refresh_token, accessToken: data.access_token };
}

/** Write gws credentials file in the format expected by the gws CLI. */
export function writeGwsCredentials(refreshToken: string): void {
  const dir = dirname(CREDENTIALS_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const credentials = {
    type: "authorized_user",
    client_id: GWS_OAUTH.clientId,
    client_secret: GWS_OAUTH.clientSecret,
    refresh_token: refreshToken,
  };

  writeFileSync(CREDENTIALS_PATH, JSON.stringify(credentials, null, 2));
  info("gws-auth", "Credentials written to " + CREDENTIALS_PATH);
}

/** Test the gws token by making a lightweight Gmail API call. */
export async function testGwsToken(): Promise<GwsTokenStatus> {
  try {
    // First, get an access token using the refresh token
    const { readFileSync } = await import("node:fs");
    if (!existsSync(CREDENTIALS_PATH)) {
      return { valid: false, error: "Credentials file not found" };
    }

    const creds = JSON.parse(readFileSync(CREDENTIALS_PATH, "utf-8")) as {
      refresh_token?: string;
      client_id?: string;
      client_secret?: string;
    };

    if (!creds.refresh_token) {
      return { valid: false, error: "No refresh_token in credentials" };
    }

    const tokenResponse = await fetch(GWS_OAUTH.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: creds.client_id ?? GWS_OAUTH.clientId,
        client_secret: creds.client_secret ?? GWS_OAUTH.clientSecret,
        refresh_token: creds.refresh_token,
        grant_type: "refresh_token",
      }),
    });

    const tokenData = (await tokenResponse.json()) as TokenResponse;
    if (tokenData.error) {
      return { valid: false, error: `${tokenData.error}: ${tokenData.error_description ?? "unknown"}` };
    }

    // Verify the access token works with a lightweight API call
    const profileResponse = await fetch(
      "https://gmail.googleapis.com/gmail/v1/users/me/profile",
      { headers: { Authorization: `Bearer ${tokenData.access_token}` } }
    );

    if (!profileResponse.ok) {
      const body = await profileResponse.text();
      return { valid: false, error: `Gmail API returned ${profileResponse.status}: ${body}` };
    }

    return { valid: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError("gws-auth", `Token test failed: ${message}`);
    return { valid: false, error: message };
  }
}
