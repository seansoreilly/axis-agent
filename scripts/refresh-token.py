"""Refresh Claude OAuth access token using the refresh token."""

import json
import sys
import time
import os
import urllib.request
import urllib.error

CREDS_FILE = os.path.expanduser("~/.claude/.credentials.json")
TOKEN_ENDPOINT = "https://platform.claude.com/v1/oauth/token"
CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
SCOPES = "user:profile user:inference user:sessions:claude_code user:mcp_servers"


def main() -> int:
    creds = json.load(open(CREDS_FILE))
    rt = creds["claudeAiOauth"]["refreshToken"]

    if not rt:
        print("FAIL: No refresh token available")
        return 1

    payload = json.dumps({
        "grant_type": "refresh_token",
        "refresh_token": rt,
        "client_id": CLIENT_ID,
        "scope": SCOPES,
    }).encode()

    req = urllib.request.Request(
        TOKEN_ENDPOINT,
        data=payload,
        headers={
            "Content-Type": "application/json",
            "User-Agent": "claude-code/1.0",
        },
    )

    try:
        resp = urllib.request.urlopen(req, timeout=15)
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        print(f"FAIL: HTTP {e.code} - {body}")
        return 1

    data = json.loads(resp.read())

    creds["claudeAiOauth"]["accessToken"] = data["access_token"]
    if "refresh_token" in data:
        creds["claudeAiOauth"]["refreshToken"] = data["refresh_token"]
    creds["claudeAiOauth"]["expiresAt"] = int(time.time() * 1000) + data["expires_in"] * 1000

    with open(CREDS_FILE, "w") as f:
        json.dump(creds, f, indent=2)

    hours = data["expires_in"] / 3600
    print(f"OK: refreshed, expires in {hours:.1f}h")
    return 0


if __name__ == "__main__":
    sys.exit(main())
