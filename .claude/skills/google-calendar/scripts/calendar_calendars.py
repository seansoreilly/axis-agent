#!/usr/bin/env python3
"""List all accessible Google Calendars."""
import sys
import json
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import get_credentials, PACKAGES_PATH
if PACKAGES_PATH not in sys.path:
    sys.path.insert(0, PACKAGES_PATH)

from googleapiclient.discovery import build


def main():
    creds = get_credentials()
    service = build("calendar", "v3", credentials=creds)

    try:
        result = service.calendarList().list().execute()
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)

    calendars = [
        {
            "id": c.get("id"),
            "summary": c.get("summary"),
            "description": c.get("description", ""),
            "primary": c.get("primary", False),
            "access_role": c.get("accessRole"),
        }
        for c in result.get("items", [])
    ]

    print(json.dumps({"calendars": calendars, "count": len(calendars)}, indent=2))


if __name__ == "__main__":
    main()
