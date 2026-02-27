#!/usr/bin/env python3
"""Read emails from Gmail via IMAP using app password.

Usage:
  python3 read.py --count 10                  # Last 10 inbox emails
  python3 read.py --count 5 --unread          # Unread only
  python3 read.py --count 5 --folder INBOX    # Specific folder
  python3 read.py --search "from:boss@work.com"  # Search
"""

import argparse
import email
import imaplib
import json
from email.header import decode_header
from pathlib import Path

CREDS_FILE = Path("/home/ubuntu/agent/gmail_app_password.json")


def load_creds():
    with open(CREDS_FILE) as f:
        c = json.load(f)
    return c["email"], c["app_password"].replace(" ", "")


def decode_str(s):
    if s is None:
        return ""
    parts = decode_header(s)
    result = []
    for part, enc in parts:
        if isinstance(part, bytes):
            result.append(part.decode(enc or "utf-8", errors="replace"))
        else:
            result.append(part)
    return "".join(result)


def get_body(msg):
    if msg.is_multipart():
        for part in msg.walk():
            ct = part.get_content_type()
            cd = str(part.get("Content-Disposition", ""))
            if ct == "text/plain" and "attachment" not in cd:
                return part.get_payload(decode=True).decode("utf-8", errors="replace")
    else:
        return msg.get_payload(decode=True).decode("utf-8", errors="replace")
    return ""


def read_emails(count=10, unread_only=False, folder="INBOX", search=None):
    user, password = load_creds()

    with imaplib.IMAP4_SSL("imap.gmail.com", 993) as imap:
        imap.login(user, password)
        imap.select(folder)

        if search:
            _, data = imap.search(None, search)
        elif unread_only:
            _, data = imap.search(None, "UNSEEN")
        else:
            _, data = imap.search(None, "ALL")

        ids = data[0].split()
        ids = ids[-count:]  # Most recent N

        results = []
        for uid in reversed(ids):
            _, msg_data = imap.fetch(uid, "(RFC822)")
            msg = email.message_from_bytes(msg_data[0][1])
            results.append({
                "id": uid.decode(),
                "from": decode_str(msg["From"]),
                "to": decode_str(msg["To"]),
                "subject": decode_str(msg["Subject"]),
                "date": msg["Date"],
                "body": get_body(msg)[:500],  # Truncate long bodies
            })

        return results


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Read emails from Gmail")
    parser.add_argument("--count", type=int, default=10, help="Number of emails to fetch")
    parser.add_argument("--unread", action="store_true", help="Only unread emails")
    parser.add_argument("--folder", default="INBOX", help="Mailbox folder")
    parser.add_argument("--search", help='IMAP search string e.g. "FROM boss@work.com"')
    args = parser.parse_args()

    emails = read_emails(args.count, args.unread, args.folder, args.search)
    print(json.dumps(emails, indent=2, ensure_ascii=False))
