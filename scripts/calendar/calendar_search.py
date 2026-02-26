#!/usr/bin/env python3
"""Search Google Calendar events by text query."""
import sys
import json
import argparse
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import get_credentials, PACKAGES_PATH
if PACKAGES_PATH not in sys.path:
    sys.path.insert(0, PACKAGES_PATH)

from googleapiclient.discovery import build

TIMEZONE = "Australia/Melbourne"


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
    parser = argparse.ArgumentParser(description="Search calendar events")
    parser.add_argument("--query", required=True, help="Text to search for")
    parser.add_argument("--days-back", type=int, default=30, help="Search N days back (default: 30)")
    parser.add_argument("--days-forward", type=int, default=90, help="Search N days forward (default: 90)")
    parser.add_argument("--calendar", default="primary", help="Calendar ID (default: primary)")
    parser.add_argument("--max", type=int, default=20, help="Max results (default: 20)")
    args = parser.parse_args()

    tz = ZoneInfo(TIMEZONE)
    now = datetime.now(tz=tz)
    time_min = now - timedelta(days=args.days_back)
    time_max = now + timedelta(days=args.days_forward)

    creds = get_credentials()
    service = build("calendar", "v3", credentials=creds)

    try:
        result = service.events().list(
            calendarId=args.calendar,
            q=args.query,
            timeMin=time_min.isoformat(),
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
        "query": args.query,
        "events": events,
        "count": len(events),
        "calendar_id": args.calendar,
    }, indent=2))


if __name__ == "__main__":
    main()
