#!/usr/bin/env python3
"""Create a new Google Contact."""
import sys
import json
import argparse
from pathlib import Path

PACKAGES_PATH = "/home/ubuntu/.claude-agent/python-packages/lib/python3.12/site-packages"
if PACKAGES_PATH not in sys.path:
    sys.path.insert(0, PACKAGES_PATH)

sys.path.insert(0, str(Path(__file__).parent))
from _common import build_people_service, fail, PERSON_FIELDS


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Create a Google Contact")
    parser.add_argument("--given-name", required=True, help="First name")
    parser.add_argument("--family-name", default="", help="Last name")
    parser.add_argument("--email", default="", help="Email address")
    parser.add_argument("--phone", default="", help="Phone number")
    parser.add_argument("--organization", default="", help="Company name")
    parser.add_argument("--job-title", default="", help="Job title")
    parser.add_argument("--notes", default="", help="Notes/memo")
    parser.add_argument("--address", default="", help="Street address")
    args = parser.parse_args()

    body: dict = {
        "names": [{"givenName": args.given_name, "familyName": args.family_name}],
    }
    if args.email:
        body["emailAddresses"] = [{"value": args.email}]
    if args.phone:
        body["phoneNumbers"] = [{"value": args.phone}]
    if args.organization or args.job_title:
        body["organizations"] = [{"name": args.organization, "title": args.job_title}]
    if args.notes:
        body["biographies"] = [{"value": args.notes}]
    if args.address:
        body["addresses"] = [{"formattedValue": args.address}]

    service = build_people_service()
    try:
        result = service.people().createContact(
            body=body,
            personFields=PERSON_FIELDS,
        ).execute()
    except Exception as e:
        fail(f"createContact API error: {e}")

    names = result.get("names", [{}])
    name = names[0] if names else {}
    print(json.dumps({
        "ok": True,
        "resource_name": result.get("resourceName", ""),
        "display_name": name.get("displayName", ""),
        "message": f"Contact '{name.get('displayName', '')}' created.",
    }, indent=2))
