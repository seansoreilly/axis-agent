"""Shared Google Contacts auth helper — OAuth2 with stored refresh token."""
import sys
import json
from pathlib import Path

# Add installed packages to path
PACKAGES_PATH = "/home/ubuntu/.claude-agent/python-packages/lib/python3.12/site-packages"
if PACKAGES_PATH not in sys.path:
    sys.path.insert(0, PACKAGES_PATH)

from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
from googleapiclient.discovery import build

TOKEN_PATH = Path("/home/ubuntu/.claude-agent/google-contacts-token.json")
CREDENTIALS_PATH = Path("/home/ubuntu/.claude-agent/google-credentials.json")
SCOPES = ["https://www.googleapis.com/auth/contacts"]

PERSON_FIELDS = "names,emailAddresses,phoneNumbers,organizations,addresses,biographies"


def fail(msg: str):
    """Print JSON error and exit."""
    print(json.dumps({"error": msg}))
    sys.exit(1)


def get_credentials() -> Credentials:
    """Load OAuth2 credentials, auto-refreshing if expired."""
    if not TOKEN_PATH.exists():
        fail(
            f"Token file not found: {TOKEN_PATH}. "
            "Run contacts_auth.py --get-url to set up authentication."
        )

    try:
        creds = Credentials.from_authorized_user_file(str(TOKEN_PATH), SCOPES)
    except Exception as e:
        fail(f"Failed to load token: {e}")

    if creds.expired and creds.refresh_token:
        try:
            creds.refresh(Request())
            TOKEN_PATH.write_text(creds.to_json())
        except Exception as e:
            fail(f"Failed to refresh token: {e}")

    if not creds.valid:
        fail("Token is invalid. Re-run contacts_auth.py to re-authenticate.")

    return creds


def build_people_service():
    """Build and return Google People API v1 service."""
    creds = get_credentials()
    return build("people", "v1", credentials=creds)
