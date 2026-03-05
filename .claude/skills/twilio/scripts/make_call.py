#!/usr/bin/env python3
"""Make a voice call with text-to-speech via the Twilio REST API (AU1 region)."""

import argparse
import json
import os
import sys
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from xml.etree.ElementTree import Element, tostring

# Import shared helpers from same package
os.chdir(os.path.dirname(os.path.abspath(__file__)))
from _common import load_credentials, get_api_base, make_auth_header, fail

DEFAULT_VOICE = "Polly.Nicole"


def make_twiml(message: str, voice: str) -> str:
    """Generate TwiML XML for a text-to-speech call."""
    response = Element("Response")
    say = Element("Say", attrib={"voice": voice})
    say.text = message
    response.append(say)
    return '<?xml version="1.0" encoding="UTF-8"?>' + tostring(response, encoding="unicode")


def make_call(to: str, message: str, from_number: str | None = None, voice: str = DEFAULT_VOICE) -> dict:
    account_sid, auth_user, auth_secret, region, default_from = load_credentials()
    if not account_sid or not auth_user:
        fail("No Twilio credentials found. Set env vars or create credentials file.")

    caller = from_number or default_from
    if not caller:
        fail("No --from number and no default from_number in credentials.")

    twiml = make_twiml(message, voice)
    base = get_api_base(account_sid, region)
    url = f"{base}/Calls.json"

    data = urlencode({
        "To": to,
        "From": caller,
        "Twiml": twiml,
    }).encode()

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
    parser = argparse.ArgumentParser(description="Make a voice call via Twilio with text-to-speech")
    parser.add_argument("--to", required=True, help="Recipient E.164 phone number")
    parser.add_argument("--message", required=True, help="Text-to-speech message to read when answered")
    parser.add_argument("--from", dest="from_number", help="Caller ID number (overrides default)")
    parser.add_argument("--voice", default=DEFAULT_VOICE, help=f"TTS voice (default: {DEFAULT_VOICE})")
    args = parser.parse_args()

    result = make_call(args.to, args.message, args.from_number, args.voice)
    sys.stdout.write(json.dumps(result, indent=2) + "\n")


if __name__ == "__main__":
    main()
