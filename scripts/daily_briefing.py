#!/usr/bin/env python3
"""Generate a daily calendar briefing."""
import sys
import json
import subprocess
from datetime import datetime
from zoneinfo import ZoneInfo

tz = ZoneInfo("Australia/Melbourne")
now = datetime.now(tz=tz)

result = subprocess.run(
    ["python3", "/home/ubuntu/agent/scripts/calendar/ical_fetch.py", "--days", "1"],
    capture_output=True, text=True
)

data = json.loads(result.stdout)
events = data.get("events", [])

today_str = now.strftime("%A, %d %B %Y")
lines = [f"📅 *Good morning! Here's your day — {today_str}*\n"]

if not events:
    lines.append("No events today. Enjoy the free day! 🎉")
else:
    lines.append(f"You have *{len(events)} event{'s' if len(events) != 1 else ''}* today:\n")
    for e in events:
        start = datetime.fromisoformat(e["start"])
        time_str = start.strftime("%H:%M")
        summary = e["summary"]
        location = f" 📍 {e['location']}" if e.get("location") else ""
        lines.append(f"• *{time_str}* — {summary}{location}")

print("\n".join(lines))
