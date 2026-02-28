#!/usr/bin/env python3
"""Update an existing Google Contact."""
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
    parser = argparse.ArgumentParser(description="Update a Google Contact")
    parser.add_argument("--resource-name", required=True, help="Contact resource name (e.g. people/c123456)")
    parser.add_argument("--given-name", help="First name")
    parser.add_argument("--family-name", help="Last name")
    parser.add_argument("--email", help="Email address")
    parser.add_argument("--phone", help="Phone number")
    parser.add_argument("--organization", help="Company name")
    parser.add_argument("--job-title", help="Job title")
    parser.add_argument("--notes", help="Notes/memo")
    parser.add_argument("--address", help="Street address")
    args = parser.parse_args()

    service = build_people_service()

    # Fetch current contact for etag
    try:
        current = service.people().get(
            resourceName=args.resource_name,
            personFields=PERSON_FIELDS,
        ).execute()
    except Exception as e:
        fail(f"Failed to fetch contact: {e}")

    etag = current.get("etag", "")
    update_fields = []

    # Build update body — only modify specified fields
    body: dict = {"etag": etag}

    if args.given_name is not None or args.family_name is not None:
        existing_name = current.get("names", [{}])[0] if current.get("names") else {}
        body["names"] = [{
            "givenName": args.given_name if args.given_name is not None else existing_name.get("givenName", ""),
            "familyName": args.family_name if args.family_name is not None else existing_name.get("familyName", ""),
        }]
        update_fields.append("names")

    if args.email is not None:
        body["emailAddresses"] = [{"value": args.email}]
        update_fields.append("emailAddresses")

    if args.phone is not None:
        body["phoneNumbers"] = [{"value": args.phone}]
        update_fields.append("phoneNumbers")

    if args.organization is not None or args.job_title is not None:
        existing_org = current.get("organizations", [{}])[0] if current.get("organizations") else {}
        body["organizations"] = [{
            "name": args.organization if args.organization is not None else existing_org.get("name", ""),
            "title": args.job_title if args.job_title is not None else existing_org.get("title", ""),
        }]
        update_fields.append("organizations")

    if args.notes is not None:
        body["biographies"] = [{"value": args.notes}]
        update_fields.append("biographies")

    if args.address is not None:
        body["addresses"] = [{"formattedValue": args.address}]
        update_fields.append("addresses")

    if not update_fields:
        fail("No fields specified to update. Use --given-name, --email, --phone, etc.")

    try:
        result = service.people().updateContact(
            resourceName=args.resource_name,
            body=body,
            updatePersonFields=",".join(update_fields),
            personFields=PERSON_FIELDS,
        ).execute()
    except Exception as e:
        fail(f"updateContact API error: {e}")

    names = result.get("names", [{}])
    name = names[0] if names else {}
    print(json.dumps({
        "ok": True,
        "resource_name": result.get("resourceName", ""),
        "display_name": name.get("displayName", ""),
        "message": f"Contact '{name.get('displayName', '')}' updated. Fields: {', '.join(update_fields)}",
    }, indent=2))
