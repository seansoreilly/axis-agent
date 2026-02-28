#!/usr/bin/env python3
"""One-time Google Contacts OAuth setup (headless OOB flow)."""
import sys
import json
import argparse
from pathlib import Path

PACKAGES_PATH = "/home/ubuntu/.claude-agent/python-packages/lib/python3.12/site-packages"
if PACKAGES_PATH not in sys.path:
    sys.path.insert(0, PACKAGES_PATH)

from google_auth_oauthlib.flow import InstalledAppFlow

CREDENTIALS_PATH = Path("/home/ubuntu/.claude-agent/google-credentials.json")
TOKEN_PATH = Path("/home/ubuntu/.claude-agent/google-contacts-token.json")
SCOPES = ["https://www.googleapis.com/auth/contacts"]


def cmd_get_url():
    """Print the authorization URL for the user to open."""
    if not CREDENTIALS_PATH.exists():
        print(json.dumps({"error": f"Credentials file not found: {CREDENTIALS_PATH}"}))
        sys.exit(1)

    flow = InstalledAppFlow.from_client_secrets_file(str(CREDENTIALS_PATH), SCOPES)
    flow.redirect_uri = "urn:ietf:wg:oauth:2.0:oob"
    auth_url, _ = flow.authorization_url(
        access_type="offline",
        prompt="consent",
    )
    print(json.dumps({
        "ok": True,
        "auth_url": auth_url,
        "instruction": (
            "1. Open the URL above in your browser\n"
            "2. Sign in and authorize access\n"
            "3. Copy the authorization code shown\n"
            "4. Run: python3 /home/ubuntu/agent/.claude/skills/google-contacts/scripts/contacts_auth.py --exchange-code YOUR_CODE"
        )
    }, indent=2))


def cmd_exchange_code(code: str):
    """Exchange authorization code for tokens and save."""
    if not CREDENTIALS_PATH.exists():
        print(json.dumps({"error": f"Credentials file not found: {CREDENTIALS_PATH}"}))
        sys.exit(1)

    flow = InstalledAppFlow.from_client_secrets_file(str(CREDENTIALS_PATH), SCOPES)
    flow.redirect_uri = "urn:ietf:wg:oauth:2.0:oob"
    try:
        flow.fetch_token(code=code.strip())
    except Exception as e:
        print(json.dumps({"error": f"Failed to exchange code: {e}"}))
        sys.exit(1)

    TOKEN_PATH.write_text(flow.credentials.to_json())
    print(json.dumps({
        "ok": True,
        "message": "Authenticated successfully. Token saved.",
        "token_path": str(TOKEN_PATH)
    }, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Google Contacts OAuth setup")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--get-url", action="store_true", help="Get authorization URL")
    group.add_argument("--exchange-code", metavar="CODE", help="Exchange auth code for token")
    args = parser.parse_args()

    if args.get_url:
        cmd_get_url()
    elif args.exchange_code:
        cmd_exchange_code(args.exchange_code)
