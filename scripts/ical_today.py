#!/usr/bin/env python3
"""Fetch and parse iCal feed, returning today's events in Melbourne timezone."""

import os
import sys
import re
import urllib.request
from datetime import datetime, date, timezone, timedelta

ICAL_URL = os.environ.get("ICAL_URL", "")
MELBOURNE_OFFSET = timedelta(hours=11)  # AEDT (UTC+11); adjust to +10 for AEST if needed
MELBOURNE_TZ = timezone(MELBOURNE_OFFSET)


def fetch_ical(url):
    with urllib.request.urlopen(url, timeout=15) as resp:
        return resp.read().decode("utf-8", errors="replace")


def unfold(text):
    """Unfold iCal line continuations."""
    return re.sub(r'\r?\n[ \t]', '', text)


def parse_dt(dtstr):
    """Parse DTSTART/DTEND values to a timezone-aware datetime in Melbourne time."""
    dtstr = dtstr.strip()
    if dtstr.endswith('Z'):
        dt = datetime.strptime(dtstr, "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
        return dt.astimezone(MELBOURNE_TZ)
    elif 'T' in dtstr:
        dt = datetime.strptime(dtstr, "%Y%m%dT%H%M%S")
        return dt.replace(tzinfo=MELBOURNE_TZ)
    else:
        # All-day event
        d = datetime.strptime(dtstr, "%Y%m%d").date()
        return d


def get_field(block, field):
    """Extract first matching field value from event block."""
    match = re.search(rf'^{field}[^:]*:(.*)', block, re.MULTILINE)
    return match.group(1).strip() if match else ''


def events_today(ical_text, target_date=None):
    if target_date is None:
        target_date = datetime.now(MELBOURNE_TZ).date()

    ical_text = unfold(ical_text)
    results = []

    for block in ical_text.split('BEGIN:VEVENT')[1:]:
        end = block.find('END:VEVENT')
        block = block[:end]

        summary = get_field(block, 'SUMMARY')
        dtstart_raw = get_field(block, 'DTSTART')
        location = get_field(block, 'LOCATION').replace('\\,', ',').replace('\\n', ', ')

        if not dtstart_raw or not summary:
            continue

        try:
            dt = parse_dt(dtstart_raw)
        except Exception:
            continue

        if isinstance(dt, date) and not isinstance(dt, datetime):
            event_date = dt
            time_str = "All day"
        else:
            event_date = dt.date()
            time_str = dt.strftime("%-I:%M %p")

        if event_date == target_date:
            results.append((dt if isinstance(dt, datetime) else datetime.combine(dt, datetime.min.time()), time_str, summary, location))

    results.sort(key=lambda x: x[0])
    return results


if __name__ == "__main__":
    # Allow passing a date as argument: YYYY-MM-DD
    if len(sys.argv) > 1:
        target = datetime.strptime(sys.argv[1], "%Y-%m-%d").date()
    else:
        target = None

    if not ICAL_URL:
        print("Error: ICAL_URL environment variable is not set.", file=sys.stderr)
        sys.exit(1)
    ical = fetch_ical(ICAL_URL)
    events = events_today(ical, target)

    if not events:
        print("No events scheduled for today.")
    else:
        for _, time_str, summary, location in events:
            loc = f" — {location}" if location else ""
            print(f"{time_str}: {summary}{loc}")
