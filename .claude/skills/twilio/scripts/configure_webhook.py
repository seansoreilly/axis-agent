#!/usr/bin/env python3
"""Configure Twilio incoming SMS webhook for your phone number."""

import argparse
import json
import os
import sys
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from urllib.error import HTTPError

os.chdir(os.path.dirname(os.path.abspath(__file__)))
from _common import load_credentials, get_api_base, make_auth_header, fail


def configure_webhook(webhook_url: str, phone_number: str | None = None) -> dict:
    """Configure Twilio webhook for inbound SMS.

    Args:
        webhook_url: Full URL where Twilio should POST inbound SMS (e.g., https://example.com/twilio/inbound-sms)
        phone_number: Optional specific phone number to configure (if not set, updates default from_number)

    Returns:
        Configuration result dict
    """
    account_sid, auth_user, auth_secret, region, default_from = load_credentials()
    if not account_sid or not auth_user:
        fail("No Twilio credentials found. Set env vars or create credentials file.")

    number_to_configure = phone_number or default_from
    if not number_to_configure:
        fail("No phone number specified and no default from_number in credentials.")

    # Get incoming phone number SID by fetching the number's details
    # First, list incoming phone numbers to find the SID
    base = get_api_base(account_sid, region)
    list_url = f"{base}/IncomingPhoneNumbers.json?PhoneNumber={urlencode({'': number_to_configure}).lstrip('=')}"

    req = Request(list_url, method="GET")
    req.add_header("Authorization", make_auth_header(auth_user, auth_secret))

    try:
        with urlopen(req) as resp:
            phone_list = json.loads(resp.read())
            if not phone_list.get("incoming_phone_numbers"):
                fail(f"Phone number {number_to_configure} not found in your Twilio account")

            phone_sid = phone_list["incoming_phone_numbers"][0]["sid"]
    except HTTPError as exc:
        error_body = exc.read().decode()
        try:
            detail = json.loads(error_body)
            fail(f"Failed to find phone number: {detail.get('message')}")
        except json.JSONDecodeError:
            fail(f"HTTP {exc.code}: {error_body[:500]}")

    # Now update the phone number with the webhook URL
    update_url = f"{base}/IncomingPhoneNumbers/{phone_sid}.json"

    data = urlencode({
        "SmsUrl": webhook_url,
        "SmsMethod": "POST",
    }).encode()

    req = Request(update_url, data=data, method="POST")
    req.add_header("Authorization", make_auth_header(auth_user, auth_secret))

    try:
        with urlopen(req) as resp:
            result = json.loads(resp.read())
            return {
                "success": True,
                "phone_number": result.get("phone_number"),
                "sms_url": result.get("sms_url"),
                "sms_method": result.get("sms_method"),
                "sid": result.get("sid"),
            }
    except HTTPError as exc:
        error_body = exc.read().decode()
        try:
            detail = json.loads(error_body)
            fail(f"Twilio API error {detail.get('code')}: {detail.get('message')}")
        except json.JSONDecodeError:
            fail(f"HTTP {exc.code}: {error_body[:500]}")


def main():
    parser = argparse.ArgumentParser(
        description="Configure Twilio incoming SMS webhook for your phone number"
    )
    parser.add_argument(
        "--webhook-url",
        required=True,
        help="Full URL where Twilio will POST inbound SMS (e.g., https://example.com/twilio/inbound-sms)",
    )
    parser.add_argument(
        "--phone-number",
        help="Specific phone number to configure (uses default if not specified)",
    )
    args = parser.parse_args()

    result = configure_webhook(args.webhook_url, args.phone_number)
    sys.stdout.write(json.dumps(result, indent=2) + "\n")


if __name__ == "__main__":
    main()
