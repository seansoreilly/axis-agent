#!/usr/bin/env python3
"""Delete a Google Calendar event."""
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
    parser = argparse.ArgumentParser(description="Delete a calendar event")
    parser.add_argument("--event-id", required=True, help="Event ID to delete")
    parser.add_argument("--calendar", default="primary", help="Calendar ID (default: primary)")
    args = parser.parse_args()

    creds = get_credentials()
    service = build("calendar", "v3", credentials=creds)

    try:
        service.events().delete(calendarId=args.calendar, eventId=args.event_id).execute()
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)

    print(json.dumps({"ok": True, "deleted_event_id": args.event_id}))


if __name__ == "__main__":
    main()
