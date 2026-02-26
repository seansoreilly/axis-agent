#!/usr/bin/env python3
"""List Google Calendar events."""
import sys
import json
import argparse
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import get_credentials, PACKAGES_PATH
if PACKAGES_PATH not in sys.path:
    sys.path.insert(0, PACKAGES_PATH)

from googleapiclient.discovery import build

TIMEZONE = "Australia/Melbourne"
DEFAULT_CALENDAR = "primary"
DEFAULT_DAYS = 7
DEFAULT_MAX = 20


def format_event(event: dict, calendar_id: str) -> dict:
    start = event.get("start", {})
    end = event.get("end", {})
    attendees = [a.get("email", "") for a in event.get("attendees", [])]
    return {
        "id": event.get("id", ""),
        "summary": event.get("summary", "(No title)"),
        "start": start.get("dateTime", start.get("date", "")),
        "end": end.get("dateTime", end.get("date", "")),
        "location": event.get("location", ""),
        "description": event.get("description", ""),
        "attendees": attendees,
        "calendar_id": calendar_id,
        "html_link": event.get("htmlLink", ""),
    }


def main():
    parser = argparse.ArgumentParser(description="List calendar events")
    parser.add_argument("--days", type=int, default=DEFAULT_DAYS,
                        help="Look ahead N days (default: 7)")
    parser.add_argument("--minutes", type=int, default=None,
                        help="Look ahead N minutes (overrides --days)")
    parser.add_argument("--calendar", default=DEFAULT_CALENDAR,
                        help="Calendar ID (default: primary)")
    parser.add_argument("--max", type=int, default=DEFAULT_MAX,
                        help="Max events to return (default: 20)")
    args = parser.parse_args()

    tz = ZoneInfo(TIMEZONE)
    now = datetime.now(tz=tz)

    if args.minutes is not None:
        time_max = now + timedelta(minutes=args.minutes)
    else:
        time_max = now + timedelta(days=args.days)

    creds = get_credentials()
    service = build("calendar", "v3", credentials=creds)

    try:
        result = service.events().list(
            calendarId=args.calendar,
            timeMin=now.isoformat(),
            timeMax=time_max.isoformat(),
            maxResults=args.max,
            singleEvents=True,
            orderBy="startTime",
        ).execute()
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)

    events = [format_event(e, args.calendar) for e in result.get("items", [])]

    print(json.dumps({
        "events": events,
        "count": len(events),
        "range_start": now.isoformat(),
        "range_end": time_max.isoformat(),
        "calendar_id": args.calendar,
    }, indent=2))


if __name__ == "__main__":
    main()
