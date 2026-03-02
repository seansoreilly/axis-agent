#!/usr/bin/env python3
"""
Fetch and parse ICS calendar data with correct timezone handling.
Converts all UTC times (Z suffix) properly to local AEDT time.

Usage:
  python3 ical_fetch.py [--days N] [--date YYYY-MM-DD]
"""

import sys
import re
import json
import argparse
import urllib.request
from datetime import datetime, timezone, timedelta, date
from zoneinfo import ZoneInfo

# --- Config ---
CALENDAR_URL = "https://www.calendar-aggregator.online/api/calendar/seansoreilly"
LOCAL_TZ = ZoneInfo("Australia/Melbourne")

# Windows timezone ID → IANA mapping (add more as needed)
WINDOWS_TZ_MAP = {
    "AUS Eastern Standard Time":   "Australia/Sydney",
    "E. Australia Standard Time":  "Australia/Brisbane",
    "Tasmania Standard Time":      "Australia/Hobart",
    "SA Pacific Standard Time":    "America/Bogota",
    "Arabian Standard Time":       "Asia/Dubai",
    "UTC":                         "UTC",
    "GMT Standard Time":           "Europe/London",
    "Pacific Standard Time":       "America/Los_Angeles",
    "Eastern Standard Time":       "America/New_York",
    "Central Standard Time":       "America/Chicago",
}


def resolve_tzid(tzid: str) -> ZoneInfo:
    """Resolve a TZID string to a ZoneInfo object."""
    if not tzid:
        return LOCAL_TZ
    # Try direct IANA lookup first
    try:
        return ZoneInfo(tzid)
    except Exception:
        pass
    # Try Windows map
    mapped = WINDOWS_TZ_MAP.get(tzid)
    if mapped:
        try:
            return ZoneInfo(mapped)
        except Exception:
            pass
    # Fallback
    return LOCAL_TZ


def parse_dt(raw: str, tzid: str | None) -> datetime | None:
    """
    Parse an ICS datetime string into a timezone-aware datetime in LOCAL_TZ.

    Handles:
      - 20260303T150000Z   → UTC, convert to LOCAL_TZ
      - 20260303T150000    → use tzid (or LOCAL_TZ if absent)
      - 20260303           → all-day date (returns None)
    """
    raw = raw.strip()
    is_utc = raw.endswith("Z")
    dt_str = raw.rstrip("Z")

    if len(dt_str) == 8:
        # DATE only — skip
        return None

    try:
        dt = datetime.strptime(dt_str, "%Y%m%dT%H%M%S")
    except ValueError:
        return None

    if is_utc:
        dt = dt.replace(tzinfo=timezone.utc)
    else:
        tz = resolve_tzid(tzid)
        dt = dt.replace(tzinfo=tz)

    return dt.astimezone(LOCAL_TZ)


def fetch_ics(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": "CalendarFetcher/1.0"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        return resp.read().decode("utf-8", errors="replace")


def parse_events(ics_text: str) -> list[dict]:
    """Parse VEVENT blocks from ICS text into a list of event dicts."""
    events = []
    blocks = re.findall(r"BEGIN:VEVENT(.*?)END:VEVENT", ics_text, re.DOTALL)

    for block in blocks:
        def field(name):
            # Handle folded lines (lines starting with space/tab are continuations)
            pattern = rf"^{name}[;:][^\r\n]*(?:\r?\n[ \t][^\r\n]*)*"
            m = re.search(pattern, block, re.MULTILINE)
            if not m:
                return None
            # Unfold: remove line breaks followed by whitespace
            val = re.sub(r"\r?\n[ \t]", "", m.group(0))
            # Strip the property name prefix
            val = re.sub(rf"^{name}[^:]*:", "", val)
            return val.strip()

        summary = field("SUMMARY")
        if not summary:
            continue

        # Parse DTSTART
        dtstart_raw_m = re.search(
            r"^DTSTART(?:;TZID=([^;:\r\n]+))?(?:;[^:]+)?:([\dTZ]+)",
            block, re.MULTILINE
        )
        dtend_raw_m = re.search(
            r"^DTEND(?:;TZID=([^;:\r\n]+))?(?:;[^:]+)?:([\dTZ]+)",
            block, re.MULTILINE
        )

        if not dtstart_raw_m:
            continue

        tzid = dtstart_raw_m.group(1)
        start_dt = parse_dt(dtstart_raw_m.group(2), tzid)
        end_dt = parse_dt(dtend_raw_m.group(2), dtend_raw_m.group(1) if dtend_raw_m else tzid) if dtend_raw_m else None

        if start_dt is None:
            continue

        location = field("LOCATION") or ""
        # Unescape ICS backslash sequences
        location = location.replace("\\,", ",").replace("\\n", "\n").replace("\\;", ";")
        summary = summary.replace("\\,", ",").replace("\\n", " ").replace("\\;", ";")

        events.append({
            "summary": summary,
            "start": start_dt.isoformat(),
            "end": end_dt.isoformat() if end_dt else None,
            "location": location,
        })

    return events


def filter_by_date(events: list[dict], target_date: date) -> list[dict]:
    result = []
    for e in events:
        try:
            dt = datetime.fromisoformat(e["start"])
            if dt.date() == target_date:
                result.append(e)
        except Exception:
            pass
    return sorted(result, key=lambda x: x["start"])


def main():
    parser = argparse.ArgumentParser(description="Fetch and parse ICS calendar")
    parser.add_argument("--days", type=int, default=1, help="Number of days from today")
    parser.add_argument("--date", type=str, help="Specific date (YYYY-MM-DD)")
    args = parser.parse_args()

    if args.date:
        target = date.fromisoformat(args.date)
    else:
        today = datetime.now(tz=LOCAL_TZ).date()
        target = today

    try:
        ics_text = fetch_ics(CALENDAR_URL)
        all_events = parse_events(ics_text)
        day_events = filter_by_date(all_events, target)

        print(json.dumps({
            "date": target.isoformat(),
            "events": day_events,
            "total_parsed": len(all_events),
        }, indent=2))
    except Exception as e:
        print(json.dumps({"error": str(e), "events": []}))
        sys.exit(1)


if __name__ == "__main__":
    main()
