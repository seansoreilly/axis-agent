#!/usr/bin/env python3
"""Fetch and parse an iCal feed, returning upcoming events as JSON."""
import os
import sys
import json
import argparse
import urllib.request
from datetime import datetime, date, timedelta
from zoneinfo import ZoneInfo

PACKAGES_PATH = "/home/ubuntu/.claude-agent/python-packages/lib/python3.12/site-packages"
if PACKAGES_PATH not in sys.path:
    sys.path.insert(0, PACKAGES_PATH)

import icalendar

ICAL_URL = os.environ.get("ICAL_URL", "")
TIMEZONE = "Australia/Melbourne"


def fetch_and_parse(url: str, days: int = 7, max_events: int = 50) -> dict:
    tz = ZoneInfo(TIMEZONE)
    now = datetime.now(tz=tz)
    cutoff = now + timedelta(days=days)

    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = resp.read()
    except Exception as e:
        return {"error": f"Failed to fetch iCal: {e}"}

    try:
        cal = icalendar.Calendar.from_ical(data)
    except Exception as e:
        return {"error": f"Failed to parse iCal: {e}"}

    events = []
    for component in cal.walk():
        if component.name != "VEVENT":
            continue
        start = component.get("DTSTART")
        end = component.get("DTEND")
        if not start:
            continue

        dt_start = start.dt
        if isinstance(dt_start, date) and not isinstance(dt_start, datetime):
            dt_start = datetime(dt_start.year, dt_start.month, dt_start.day, tzinfo=tz)
        if dt_start.tzinfo is None:
            dt_start = dt_start.replace(tzinfo=tz)
        dt_start = dt_start.astimezone(tz)

        if not (now <= dt_start <= cutoff):
            continue

        dt_end = None
        if end:
            dt_end = end.dt
            if isinstance(dt_end, date) and not isinstance(dt_end, datetime):
                dt_end = datetime(dt_end.year, dt_end.month, dt_end.day, tzinfo=tz)
            if dt_end.tzinfo is None:
                dt_end = dt_end.replace(tzinfo=tz)
            dt_end = dt_end.astimezone(tz).isoformat()

        events.append({
            "summary": str(component.get("SUMMARY", "(No title)")),
            "start": dt_start.isoformat(),
            "end": dt_end,
            "location": str(component.get("LOCATION", "")),
            "description": str(component.get("DESCRIPTION", "")),
            "uid": str(component.get("UID", "")),
        })

    events.sort(key=lambda e: e["start"])
    return {
        "events": events[:max_events],
        "count": len(events),
        "range_start": now.isoformat(),
        "range_end": cutoff.isoformat(),
    }


def main():
    parser = argparse.ArgumentParser(description="Fetch and parse iCal feed")
    parser.add_argument("--url", default=ICAL_URL, help="iCal URL to fetch")
    parser.add_argument("--days", type=int, default=7, help="Days ahead to fetch (default: 7)")
    parser.add_argument("--max", type=int, default=50, help="Max events (default: 50)")
    args = parser.parse_args()

    result = fetch_and_parse(args.url, args.days, args.max)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
