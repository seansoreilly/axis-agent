#!/usr/bin/env python3
"""Send an SMS via the Twilio REST API (AU1 region)."""

import argparse
import json
import os
import sys
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from urllib.error import HTTPError

# Import shared helpers from same package
os.chdir(os.path.dirname(os.path.abspath(__file__)))
from _common import load_credentials, get_api_base, make_auth_header, fail


def send_sms(to: str, body: str, from_number: str | None = None) -> dict:
    account_sid, auth_user, auth_secret, region, default_from = load_credentials()
    if not account_sid or not auth_user:
        fail("No Twilio credentials found. Set env vars or create credentials file.")

    sender = from_number or default_from
    if not sender:
        fail("No --from number and no default from_number in credentials.")

    base = get_api_base(account_sid, region)
    url = f"{base}/Messages.json"

    data = urlencode({"To": to, "From": sender, "Body": body}).encode()
    req = Request(url, data=data, method="POST")
    req.add_header("Authorization", make_auth_header(auth_user, auth_secret))

    try:
        with urlopen(req) as resp:
            result = json.loads(resp.read())
            return {
                "success": True,
                "sid": result.get("sid"),
                "to": result.get("to"),
                "from": result.get("from"),
                "status": result.get("status"),
            }
    except HTTPError as exc:
        error_body = exc.read().decode()
        try:
            detail = json.loads(error_body)
            fail(f"Twilio API error {detail.get('code')}: {detail.get('message')}")
        except json.JSONDecodeError:
            fail(f"HTTP {exc.code}: {error_body[:500]}")


def main():
    parser = argparse.ArgumentParser(description="Send SMS via Twilio")
    parser.add_argument("--to", required=True, help="Recipient E.164 phone number")
    parser.add_argument("--body", required=True, help="SMS message body (max 1600 chars)")
    parser.add_argument("--from", dest="from_number", help="Sender phone number (overrides default)")
    args = parser.parse_args()

    if len(args.body) > 1600:
        fail("Message body exceeds 1600 character limit.")

    result = send_sms(args.to, args.body, args.from_number)
    sys.stdout.write(json.dumps(result, indent=2) + "\n")


if __name__ == "__main__":
    main()
