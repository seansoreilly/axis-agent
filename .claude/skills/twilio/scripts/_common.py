"""Shared Twilio helpers -- credentials loading and client creation."""

import base64
import json
import os
import sys
from pathlib import Path

CREDS_FILE = Path("/home/ubuntu/.claude-agent/twilio-credentials.json")


def load_credentials():
    """Load Twilio credentials from env vars (priority) or JSON file.

    Returns (account_sid, auth_user, auth_secret, region, default_from_number).
    auth_user/auth_secret are API Key SID/Secret if available, else account_sid/auth_token.
    AU1 region requires API Key auth.
    """
    account_sid = os.environ.get("TWILIO_ACCOUNT_SID")
    auth_token = os.environ.get("TWILIO_AUTH_TOKEN")
    api_key_sid = os.environ.get("TWILIO_API_KEY_SID")
    api_key_secret = os.environ.get("TWILIO_API_KEY_SECRET")
    from_number = os.environ.get("TWILIO_FROM_NUMBER")
    region = os.environ.get("TWILIO_REGION", "au1")

    if account_sid and (api_key_sid or auth_token):
        auth_user = api_key_sid or account_sid
        auth_secret = api_key_secret or auth_token
        return account_sid, auth_user, auth_secret, region, from_number

    try:
        with open(CREDS_FILE) as f:
            data = json.load(f)
        account_sid = data.get("account_sid")
        auth_token = data.get("auth_token")
        api_key_sid = data.get("api_key_sid")
        api_key_secret = data.get("api_key_secret")
        region = data.get("region", "au1")
        from_number = from_number or data.get("from_number")
        if account_sid and (api_key_sid or auth_token):
            auth_user = api_key_sid or account_sid
            auth_secret = api_key_secret or auth_token
            return account_sid, auth_user, auth_secret, region, from_number
    except FileNotFoundError:
        pass
    except (json.JSONDecodeError, OSError) as exc:
        sys.stderr.write(f"Warning: could not read {CREDS_FILE}: {exc}\n")

    return None, None, None, None, None


def get_api_base(account_sid, region="au1"):
    """Return the Twilio API base URL for the given region."""
    if region and region != "us1":
        return f"https://api.{region}.twilio.com/2010-04-01/Accounts/{account_sid}"
    return f"https://api.twilio.com/2010-04-01/Accounts/{account_sid}"


def make_auth_header(auth_user, auth_secret):
    """Build HTTP Basic auth header value (API Key SID + Secret, or Account SID + Token)."""
    encoded = base64.b64encode(f"{auth_user}:{auth_secret}".encode()).decode()
    return f"Basic {encoded}"


def fail(msg):
    """Print JSON error and exit."""
    print(json.dumps({"error": msg}))
    sys.exit(1)
