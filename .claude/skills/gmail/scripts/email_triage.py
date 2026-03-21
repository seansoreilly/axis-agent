#!/usr/bin/env python3
"""
Email triage script using IMAP.
Manages email watermark, fetches new emails, and provides unsubscribe/archive functions.
Includes auto-archiving of emails about past events (>1 week old).
"""

import imaplib
import json
import argparse
import os
import sys
import re
from email import message_from_bytes
from email.header import decode_header
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Optional, List, Dict, Any
from datetime import datetime, timedelta

# Configuration
GMAIL_APP_PASSWORD = "gocmekyp jldycdba"  # From gmail_app_password.json
GMAIL_EMAIL = "seansoreilly@gmail.com"
IMAP_HOST = "imap.gmail.com"
IMAP_PORT = 993

# Watermark state file
STATE_FILE = Path.home() / ".claude-agent" / "email_triage_state.json"
STATE_FILE.parent.mkdir(parents=True, exist_ok=True)


def load_state() -> Dict[str, Any]:
    """Load triage state from file."""
    if STATE_FILE.exists():
        with open(STATE_FILE) as f:
            return json.load(f)
    return {"high_uid": "1"}


def save_state(state: Dict[str, Any]) -> None:
    """Save triage state to file."""
    with open(STATE_FILE, "w") as f:
        json.dump(state, f)


def connect_imap() -> imaplib.IMAP4_SSL:
    """Connect to Gmail via IMAP."""
    conn = imaplib.IMAP4_SSL(IMAP_HOST, IMAP_PORT)
    conn.login(GMAIL_EMAIL, GMAIL_APP_PASSWORD)
    return conn


def decode_subject(subject_input) -> str:
    """Decode email subject."""
    if isinstance(subject_input, str):
        return subject_input
    if not isinstance(subject_input, bytes):
        return str(subject_input)

    decoded_parts = decode_header(subject_input)
    result = ""
    for part, encoding in decoded_parts:
        if isinstance(part, bytes):
            result += part.decode(encoding or "utf-8", errors="replace")
        else:
            result += part if part else ""
    return result


def get_email_headers(conn: imaplib.IMAP4_SSL, uid: str) -> Dict[str, str]:
    """Get headers for a specific email."""
    status, msg_data = conn.uid("fetch", uid, "(RFC822.HEADER)")
    if status != "OK":
        return {}

    msg = message_from_bytes(msg_data[0][1])
    return {
        "from": msg.get("From", ""),
        "subject": decode_subject(msg.get("Subject", "")),
        "to": msg.get("To", ""),
        "list_unsubscribe": msg.get("List-Unsubscribe", ""),
        "date": msg.get("Date", ""),
    }


def get_email_full(conn: imaplib.IMAP4_SSL, uid: str) -> Optional[Dict[str, Any]]:
    """Get full email (headers + body) for event date extraction."""
    try:
        status, msg_data = conn.uid("fetch", uid, "(RFC822)")
        if status != "OK":
            return None

        msg = message_from_bytes(msg_data[0][1])

        # Extract email date
        email_date = None
        try:
            if msg.get("Date"):
                email_date = parsedate_to_datetime(msg.get("Date"))
        except (TypeError, ValueError):
            pass

        # Extract body
        body = ""
        if msg.is_multipart():
            for part in msg.walk():
                if part.get_content_type() == "text/plain":
                    payload = part.get_payload(decode=True)
                    if payload:
                        body += payload.decode(errors="replace")
        else:
            payload = msg.get_payload(decode=True)
            if payload:
                body = payload.decode(errors="replace")

        return {
            "uid": uid,
            "from": msg.get("From", ""),
            "subject": decode_subject(msg.get("Subject", "")),
            "email_date": email_date,
            "body": body,
        }
    except Exception as e:
        return None


def is_event_email(email_data: Dict[str, Any]) -> bool:
    """Check if email is about an event (invitation, reminder, etc)."""
    subject = email_data.get("subject", "").lower()
    from_addr = email_data.get("from", "").lower()
    body = email_data.get("body", "").lower()

    # Common event email indicators
    event_keywords = [
        "event", "meeting", "conference", "invitation", "invite",
        "reminder", "alarm", "scheduled", "happening", "coming up",
        "calendar", "appointment", "reservation", "booking",
        "easter egg hunt", "bbq", "party", "gathering"
    ]

    for keyword in event_keywords:
        if keyword in subject or keyword in from_addr:
            return True

    # Check for date patterns in subject (e.g., "March 28" or "28/3")
    date_pattern = r'(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|january|february|march|april|may|june|july|august|september|october|november|december|\d{1,2}/\d{1,2})'
    if re.search(date_pattern, subject):
        return True

    return False


def extract_event_date(email_data: Dict[str, Any]) -> Optional[datetime]:
    """Try to extract event date from email subject/body."""
    subject = email_data.get("subject", "")
    body = email_data.get("body", "")
    text = f"{subject} {body}"

    # Look for common date patterns
    # Pattern: "March 28" or "28 March" or "28/3" or "3/28"
    date_patterns = [
        (r'(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})', '%B %d'),
        (r'(\d{1,2})\s+(january|february|march|april|may|june|july|august|september|october|november|december)', '%d %B'),
        (r'(\d{1,2})[/-](\d{1,2})', '%d/%m'),
    ]

    for pattern, fmt in date_patterns:
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            try:
                date_str = match.group(0)
                parsed = datetime.strptime(date_str, fmt)
                # Assume current or next year
                now = datetime.now()
                if parsed.month < now.month or (parsed.month == now.month and parsed.day < now.day):
                    parsed = parsed.replace(year=now.year + 1)
                else:
                    parsed = parsed.replace(year=now.year)
                return parsed
            except (ValueError, AttributeError):
                pass

    return None


def should_archive_event_email(email_data: Dict[str, Any]) -> bool:
    """Determine if an event email should be archived (event is >1 week old)."""
    if not is_event_email(email_data):
        return False

    # Try to extract event date
    event_date = extract_event_date(email_data)
    if not event_date:
        return False

    # Check if event is more than 1 week in the past
    now = datetime.now()
    one_week_ago = now - timedelta(days=7)

    return event_date < one_week_ago


def command_state() -> None:
    """Print current state."""
    state = load_state()
    print(json.dumps(state, indent=2))


def command_fetch(count: int, headers_only: bool = True) -> None:
    """Fetch new emails above watermark."""
    state = load_state()
    high_uid = state.get("high_uid", "1")

    conn = connect_imap()
    conn.select("INBOX")

    # Fetch emails above the watermark
    status, msg_ids = conn.uid("search", None, f"UID {high_uid}:*")

    if status != "OK":
        print("Error fetching emails")
        conn.close()
        return

    uids = msg_ids[0].split()
    if not uids:
        print(json.dumps({"total": 0, "emails": []}))
        conn.close()
        return

    # Limit to count parameter
    uids = uids[-count:] if len(uids) > count else uids

    emails = []
    for uid in uids:
        uid_str = uid.decode() if isinstance(uid, bytes) else uid
        if headers_only:
            headers = get_email_headers(conn, uid_str)
            emails.append({
                "uid": uid_str,
                "from": headers.get("from", ""),
                "subject": headers.get("subject", ""),
                "has_unsubscribe": bool(headers.get("list_unsubscribe", "")),
            })
        else:
            status, msg_data = conn.uid("fetch", uid_str, "(RFC822)")
            if status == "OK":
                emails.append({
                    "uid": uid_str,
                    "raw": msg_data[0][1].decode(errors="replace"),
                })

    print(json.dumps({
        "total": len(uids),
        "emails": emails,
        "highest_uid": uids[-1].decode() if isinstance(uids[-1], bytes) else uids[-1],
    }, indent=2))

    conn.close()


def command_unsubscribe(uid: str) -> None:
    """Unsubscribe from email (mark as deleted)."""
    try:
        conn = connect_imap()
        conn.select("INBOX")

        # Mark as deleted
        status, _ = conn.uid("store", uid, "+FLAGS", "\\Deleted")
        if status == "OK":
            conn.expunge()
            print(json.dumps({"success": True, "uid": uid, "action": "deleted"}))
        else:
            print(json.dumps({"success": False, "uid": uid, "error": "Failed to delete email"}))
        conn.close()
    except Exception as e:
        print(json.dumps({"success": False, "uid": uid, "error": str(e)}))


def command_archive(uids: List[str]) -> None:
    """Archive emails (mark as processed and delete from inbox)."""
    try:
        conn = connect_imap()
        conn.select("INBOX")

        archived_count = 0
        for uid in uids:
            # Mark as deleted to remove from inbox
            status, _ = conn.uid("store", uid, "+FLAGS", "\\Deleted")
            if status == "OK":
                archived_count += 1

        # Expunge to permanently remove marked emails
        conn.expunge()
        print(json.dumps({"success": True, "archived": archived_count, "uids": uids}))
        conn.close()
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))


def command_watermark(uid: str) -> None:
    """Update the watermark to the highest UID processed."""
    state = load_state()
    state["high_uid"] = uid
    save_state(state)
    print(json.dumps({"success": True, "high_uid": uid}))


def command_auto_archive_old_events() -> None:
    """Automatically archive emails about events that are >1 week in the past."""
    try:
        conn = connect_imap()
        conn.select("INBOX")

        # Fetch all emails (or a large batch)
        status, msg_ids = conn.uid("search", None, "ALL")
        if status != "OK":
            print(json.dumps({"success": False, "error": "Failed to search emails"}))
            conn.close()
            return

        uids = msg_ids[0].split()
        if not uids:
            print(json.dumps({"success": True, "archived": 0, "reason": "No emails found"}))
            conn.close()
            return

        # Process emails to find old event emails (limit to last 100 for efficiency)
        uids_to_archive = []
        processed = 0
        max_process = 100

        # Start from most recent
        for uid in uids[-max_process:]:
            uid_str = uid.decode() if isinstance(uid, bytes) else uid
            email_data = get_email_full(conn, uid_str)

            if email_data and should_archive_event_email(email_data):
                uids_to_archive.append(uid_str)

            processed += 1

        # Archive the old event emails
        if uids_to_archive:
            for uid in uids_to_archive:
                status, _ = conn.uid("store", uid, "+FLAGS", "\\Deleted")
            conn.expunge()

        result = {
            "success": True,
            "archived": len(uids_to_archive),
            "processed": processed,
            "archived_uids": uids_to_archive,
        }
        print(json.dumps(result))
        conn.close()
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))


def main():
    parser = argparse.ArgumentParser(description="Email triage script")
    subparsers = parser.add_subparsers(dest="command", help="Command to run")

    # state command
    subparsers.add_parser("state", help="Show current triage state")

    # fetch command
    fetch_parser = subparsers.add_parser("fetch", help="Fetch new emails")
    fetch_parser.add_argument("--count", type=int, default=20, help="Number of emails to fetch")
    fetch_parser.add_argument("--headers-only", action="store_true", help="Only fetch headers")

    # unsubscribe command
    unsub_parser = subparsers.add_parser("unsubscribe", help="Unsubscribe from email")
    unsub_parser.add_argument("--uid", required=True, help="Email UID to unsubscribe")

    # archive command
    archive_parser = subparsers.add_parser("archive", help="Archive emails")
    archive_parser.add_argument("--uids", nargs="+", required=True, help="UIDs to archive")

    # watermark command
    wm_parser = subparsers.add_parser("watermark", help="Update watermark")
    wm_parser.add_argument("--uid", required=True, help="UID to set as watermark")

    # auto-archive-old-events command
    subparsers.add_parser("auto-archive-old-events", help="Auto-archive emails about events >1 week in the past")

    args = parser.parse_args()

    if args.command == "state":
        command_state()
    elif args.command == "fetch":
        command_fetch(args.count, args.headers_only)
    elif args.command == "unsubscribe":
        command_unsubscribe(args.uid)
    elif args.command == "archive":
        command_archive(args.uids)
    elif args.command == "watermark":
        command_watermark(args.uid)
    elif args.command == "auto-archive-old-events":
        command_auto_archive_old_events()
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
