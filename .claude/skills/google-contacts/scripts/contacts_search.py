#!/usr/bin/env python3
"""Search Google Contacts with fuzzy/partial matching."""
import sys
import json
import argparse
import re
from difflib import SequenceMatcher
from pathlib import Path

# Bootstrap before local imports
PACKAGES_PATH = "/home/ubuntu/.claude-agent/python-packages/lib/python3.12/site-packages"
if PACKAGES_PATH not in sys.path:
    sys.path.insert(0, PACKAGES_PATH)

sys.path.insert(0, str(Path(__file__).parent))
from _common import build_people_service, fail, PERSON_FIELDS


def extract_contact(person: dict, score: int = 0) -> dict:
    """Extract a flat contact dict from a People API person resource."""
    names = person.get("names", [{}])
    name = names[0] if names else {}
    emails = [e["value"] for e in person.get("emailAddresses", [])]
    phones = [p["value"] for p in person.get("phoneNumbers", [])]
    orgs = person.get("organizations", [{}])
    org = orgs[0] if orgs else {}
    addrs = person.get("addresses", [{}])
    addr = addrs[0].get("formattedValue", "") if addrs else ""
    bios = person.get("biographies", [{}])
    notes = bios[0].get("value", "") if bios else ""

    return {
        "resource_name": person.get("resourceName", ""),
        "display_name": name.get("displayName", ""),
        "given_name": name.get("givenName", ""),
        "family_name": name.get("familyName", ""),
        "emails": emails,
        "phones": phones,
        "organization": org.get("name", ""),
        "job_title": org.get("title", ""),
        "address": addr,
        "notes": notes,
        "score": score,
    }


def digits_only(s: str) -> str:
    """Strip non-digit characters."""
    return re.sub(r"\D", "", s)


def fuzzy_score(query: str, contact: dict) -> int:
    """Score a contact against a query string (0-100)."""
    query_lower = query.lower().strip()
    best = 0

    # Check against name parts
    for field in [contact["display_name"], contact["given_name"], contact["family_name"]]:
        val = field.lower()
        if not val:
            continue
        # Exact substring match
        if query_lower in val or val in query_lower:
            best = max(best, 90)
        else:
            ratio = SequenceMatcher(None, query_lower, val).ratio()
            best = max(best, int(ratio * 100))

    # Check emails
    for email in contact["emails"]:
        email_lower = email.lower()
        if query_lower in email_lower:
            best = max(best, 90)
        else:
            # Match against local part
            local = email_lower.split("@")[0]
            ratio = SequenceMatcher(None, query_lower, local).ratio()
            best = max(best, int(ratio * 100))

    # Check phone numbers (digit matching)
    query_digits = digits_only(query_lower)
    if len(query_digits) >= 4:
        for phone in contact["phones"]:
            phone_digits = digits_only(phone)
            if query_digits in phone_digits or phone_digits in query_digits:
                best = max(best, 92)
            elif len(phone_digits) >= 4:
                # Compare last N digits
                min_len = min(len(query_digits), len(phone_digits))
                if query_digits[-min_len:] == phone_digits[-min_len:]:
                    best = max(best, 88)

    # Check organization
    if contact["organization"]:
        org_lower = contact["organization"].lower()
        if query_lower in org_lower:
            best = max(best, 85)
        else:
            ratio = SequenceMatcher(None, query_lower, org_lower).ratio()
            best = max(best, int(ratio * 100))

    return best


def search_api(service, query: str, max_results: int) -> list[dict]:
    """Use People API searchContacts for server-side partial matching."""
    try:
        result = service.people().searchContacts(
            query=query,
            readMask=PERSON_FIELDS,
            pageSize=min(max_results, 30),
        ).execute()
    except Exception as e:
        fail(f"searchContacts API error: {e}")

    contacts = []
    for item in result.get("results", []):
        person = item.get("person", {})
        contact = extract_contact(person)
        contact["score"] = fuzzy_score(query, contact)
        contacts.append(contact)

    # Re-rank by fuzzy score
    contacts.sort(key=lambda c: c["score"], reverse=True)
    return contacts[:max_results]


def search_list(service, query: str, max_results: int, threshold: int) -> list[dict]:
    """Fetch all contacts and fuzzy-match locally (for phone/email lookup)."""
    contacts = []
    page_token = None

    while True:
        try:
            result = service.people().connections().list(
                resourceName="people/me",
                personFields=PERSON_FIELDS,
                pageSize=200,
                pageToken=page_token,
            ).execute()
        except Exception as e:
            fail(f"connections.list API error: {e}")

        for person in result.get("connections", []):
            contact = extract_contact(person)
            score = fuzzy_score(query, contact)
            if score >= threshold:
                contact["score"] = score
                contacts.append(contact)

        page_token = result.get("nextPageToken")
        if not page_token:
            break

    contacts.sort(key=lambda c: c["score"], reverse=True)
    return contacts[:max_results]


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Search Google Contacts")
    parser.add_argument("--query", required=True, help="Name, email, phone, or partial to search")
    parser.add_argument("--max", type=int, default=10, help="Max results (default: 10)")
    parser.add_argument("--method", choices=["search", "list"], default="search",
                        help="search = API searchContacts (best for names), list = fetch all + fuzzy (best for phone/email)")
    parser.add_argument("--threshold", type=int, default=40,
                        help="Min fuzzy score 0-100 for list method (default: 40)")
    args = parser.parse_args()

    service = build_people_service()

    if args.method == "search":
        results = search_api(service, args.query, args.max)
    else:
        results = search_list(service, args.query, args.max, args.threshold)

    print(json.dumps({
        "query": args.query,
        "method": args.method,
        "count": len(results),
        "contacts": results,
    }, indent=2))
