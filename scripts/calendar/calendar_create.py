#!/usr/bin/env python3
"""Create a Google Calendar event."""
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
    parser = argparse.ArgumentParser(description="Create a calendar event")
    parser.add_argument("--summary", required=True, help="Event title")
    parser.add_argument("--start", required=True, help="Start datetime (ISO 8601, e.g. 2025-03-01T10:00:00+11:00) or date (2025-03-01)")
    parser.add_argument("--end", required=True, help="End datetime (ISO 8601) or date")
    parser.add_argument("--description", default="", help="Event description")
    parser.add_argument("--location", default="", help="Event location")
    parser.add_argument("--attendees", nargs="*", default=[], help="Attendee emails")
    parser.add_argument("--calendar", default="primary", help="Calendar ID (default: primary)")
    parser.add_argument("--timezone", default="Australia/Melbourne", help="Timezone for the event")
    args = parser.parse_args()

    if "T" in args.start:
        start = {"dateTime": args.start, "timeZone": args.timezone}
        end = {"dateTime": args.end, "timeZone": args.timezone}
    else:
        start = {"date": args.start}
        end = {"date": args.end}

    event = {
        "summary": args.summary,
        "description": args.description,
        "location": args.location,
        "start": start,
        "end": end,
    }
    if args.attendees:
        event["attendees"] = [{"email": e} for e in args.attendees]

    creds = get_credentials()
    service = build("calendar", "v3", credentials=creds)

    try:
        created = service.events().insert(
            calendarId=args.calendar,
            body=event,
            sendUpdates="all" if args.attendees else "none",
        ).execute()
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)

    print(json.dumps({
        "ok": True,
        "id": created.get("id"),
        "summary": created.get("summary"),
        "start": created.get("start"),
        "end": created.get("end"),
        "html_link": created.get("htmlLink"),
    }, indent=2))


if __name__ == "__main__":
    main()
