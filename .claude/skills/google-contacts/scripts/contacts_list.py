#!/usr/bin/env python3
"""List Google Contacts, optionally filtered by group."""
import sys
import json
import argparse
from pathlib import Path

PACKAGES_PATH = "/home/ubuntu/.claude-agent/python-packages/lib/python3.12/site-packages"
if PACKAGES_PATH not in sys.path:
    sys.path.insert(0, PACKAGES_PATH)

sys.path.insert(0, str(Path(__file__).parent))
from _common import build_people_service, fail, PERSON_FIELDS


def get_group_resource_name(service, group_name: str) -> str:
    """Find a contact group by name and return its resource name."""
    try:
        result = service.contactGroups().list().execute()
    except Exception as e:
        fail(f"contactGroups.list API error: {e}")

    for group in result.get("contactGroups", []):
        if group.get("name", "").lower() == group_name.lower():
            return group["resourceName"]
        if group.get("formattedName", "").lower() == group_name.lower():
            return group["resourceName"]

    fail(f"Contact group '{group_name}' not found")
    return ""  # unreachable


def list_group_members(service, group_resource: str, max_results: int) -> list[str]:
    """Get member resource names from a contact group."""
    try:
        result = service.contactGroups().get(
            resourceName=group_resource,
            maxMembers=max_results,
        ).execute()
    except Exception as e:
        fail(f"contactGroups.get API error: {e}")

    return result.get("memberResourceNames", [])


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="List Google Contacts")
    parser.add_argument("--max", type=int, default=50, help="Max results (default: 50)")
    parser.add_argument("--group", default="", help="Filter by contact group name")
    parser.add_argument("--sort", choices=["name", "recent"], default="name",
                        help="Sort order (default: name)")
    args = parser.parse_args()

    service = build_people_service()
    contacts = []

    if args.group:
        # Get group members, then fetch their details
        group_resource = get_group_resource_name(service, args.group)
        member_names = list_group_members(service, group_resource, args.max)

        if not member_names:
            print(json.dumps({"count": 0, "contacts": [], "group": args.group}, indent=2))
            sys.exit(0)

        # Batch get (max 200 per request)
        for i in range(0, len(member_names), 200):
            batch = member_names[i:i + 200]
            try:
                result = service.people().getBatchGet(
                    resourceNames=batch,
                    personFields=PERSON_FIELDS,
                ).execute()
            except Exception as e:
                fail(f"getBatchGet API error: {e}")

            for resp in result.get("responses", []):
                person = resp.get("person", {})
                names = person.get("names", [{}])
                name = names[0] if names else {}
                emails = [e["value"] for e in person.get("emailAddresses", [])]
                phones = [p["value"] for p in person.get("phoneNumbers", [])]
                orgs = person.get("organizations", [{}])
                org = orgs[0] if orgs else {}
                addrs = person.get("addresses", [{}])
                addr = addrs[0].get("formattedValue", "") if addrs else ""

                contacts.append({
                    "resource_name": person.get("resourceName", ""),
                    "display_name": name.get("displayName", ""),
                    "given_name": name.get("givenName", ""),
                    "family_name": name.get("familyName", ""),
                    "emails": emails,
                    "phones": phones,
                    "organization": org.get("name", ""),
                    "job_title": org.get("title", ""),
                    "address": addr,
                })
    else:
        # List all contacts with pagination
        page_token = None
        sort_order = "LAST_NAME_ASCENDING" if args.sort == "name" else "LAST_MODIFIED_DESCENDING"

        while len(contacts) < args.max:
            page_size = min(200, args.max - len(contacts))
            try:
                result = service.people().connections().list(
                    resourceName="people/me",
                    personFields=PERSON_FIELDS,
                    pageSize=page_size,
                    pageToken=page_token,
                    sortOrder=sort_order,
                ).execute()
            except Exception as e:
                fail(f"connections.list API error: {e}")

            for person in result.get("connections", []):
                names = person.get("names", [{}])
                name = names[0] if names else {}
                emails = [e["value"] for e in person.get("emailAddresses", [])]
                phones = [p["value"] for p in person.get("phoneNumbers", [])]
                orgs = person.get("organizations", [{}])
                org = orgs[0] if orgs else {}
                addrs = person.get("addresses", [{}])
                addr = addrs[0].get("formattedValue", "") if addrs else ""

                contacts.append({
                    "resource_name": person.get("resourceName", ""),
                    "display_name": name.get("displayName", ""),
                    "given_name": name.get("givenName", ""),
                    "family_name": name.get("familyName", ""),
                    "emails": emails,
                    "phones": phones,
                    "organization": org.get("name", ""),
                    "job_title": org.get("title", ""),
                    "address": addr,
                })

            page_token = result.get("nextPageToken")
            if not page_token:
                break

    # Sort if needed (group results aren't pre-sorted)
    if args.sort == "name":
        contacts.sort(key=lambda c: (c.get("given_name", "").lower(), c.get("family_name", "").lower()))

    output = {"count": len(contacts), "contacts": contacts}
    if args.group:
        output["group"] = args.group
    print(json.dumps(output, indent=2))
