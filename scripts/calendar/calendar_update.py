#!/usr/bin/env python3
"""Update an existing Google Calendar event."""
import sys
import json
import argparse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import get_credentials, PACKAGES_PATH
if PACKAGES_PATH not in sys.path:
    sys.path.insert(0, PACKAGES_PATH)

from googleapiclient.discovery import build


def main():
    parser = argparse.ArgumentParser(description="Update a calendar event")
    parser.add_argument("--event-id", required=True, help="Event ID to update")
    parser.add_argument("--calendar", default="primary", help="Calendar ID (default: primary)")
    parser.add_argument("--summary", help="New event title")
    parser.add_argument("--start", help="New start datetime (ISO 8601) or date")
    parser.add_argument("--end", help="New end datetime (ISO 8601) or date")
    parser.add_argument("--description", help="New description")
    parser.add_argument("--location", help="New location")
    parser.add_argument("--timezone", default="Australia/Melbourne", help="Timezone")
    args = parser.parse_args()

    creds = get_credentials()
    service = build("calendar", "v3", credentials=creds)

    try:
        event = service.events().get(calendarId=args.calendar, eventId=args.event_id).execute()
    except Exception as e:
        print(json.dumps({"error": f"Could not fetch event: {e}"}))
        sys.exit(1)

    if args.summary:
        event["summary"] = args.summary
    if args.description is not None:
        event["description"] = args.description
    if args.location is not None:
        event["location"] = args.location
    if args.start:
        if "T" in args.start:
            event["start"] = {"dateTime": args.start, "timeZone": args.timezone}
        else:
            event["start"] = {"date": args.start}
    if args.end:
        if "T" in args.end:
            event["end"] = {"dateTime": args.end, "timeZone": args.timezone}
        else:
            event["end"] = {"date": args.end}

    try:
        updated = service.events().update(
            calendarId=args.calendar, eventId=args.event_id, body=event,
        ).execute()
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)

    print(json.dumps({
        "ok": True,
        "id": updated.get("id"),
        "summary": updated.get("summary"),
        "start": updated.get("start"),
        "end": updated.get("end"),
        "html_link": updated.get("htmlLink"),
    }, indent=2))


if __name__ == "__main__":
    main()
