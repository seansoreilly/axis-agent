"""Shared Google Calendar auth helper — service account."""
import sys
import json
from pathlib import Path

# Add installed packages to path
PACKAGES_PATH = "/home/ubuntu/.claude-agent/python-packages/lib/python3.12/site-packages"
if PACKAGES_PATH not in sys.path:
    sys.path.insert(0, PACKAGES_PATH)

from google.oauth2 import service_account

SERVICE_ACCOUNT_PATH = Path("/home/ubuntu/.claude-agent/google-service-account.json")
SCOPES = ["https://www.googleapis.com/auth/calendar"]


def get_credentials():
    """Load service account credentials."""
    if not SERVICE_ACCOUNT_PATH.exists():
        print(json.dumps({"error": f"Service account file not found: {SERVICE_ACCOUNT_PATH}"}))
        sys.exit(1)

    try:
        creds = service_account.Credentials.from_service_account_file(
            str(SERVICE_ACCOUNT_PATH), scopes=SCOPES
        )
        return creds
    except Exception as e:
        print(json.dumps({"error": f"Failed to load service account: {e}"}))
        sys.exit(1)
