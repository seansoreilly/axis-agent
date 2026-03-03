#!/usr/bin/env python3
"""
Gmail email triage via IMAP — fetch, archive, unsubscribe, and track progress.

Uses dual UID watermarks for stable cursor tracking (immune to inbox churn).
high_uid = newest processed, low_uid = oldest processed. Range [low, high] = done.

Usage:
  python3 email_triage.py fetch --count 10
  python3 email_triage.py fetch --count 10 --below-uid 45000 --headers-only
  python3 email_triage.py fetch --count 10 --above-uid 45000
  python3 email_triage.py archive --message-id "<id>" --label "Auto-Archive"
  python3 email_triage.py unsubscribe --message-id "<id>" --label "Auto-Unsubscribe"
  python3 email_triage.py state
  python3 email_triage.py watermark --high 47000 --low 45000
  python3 email_triage.py reset

Credentials: /home/ubuntu/agent/gmail_app_password.json
  {"email": "...", "app_password": "...", "imap_host": "imap.gmail.com", "imap_port": 993,
   "smtp_host": "smtp.gmail.com", "smtp_port": 465}

Output (stdout): JSON
"""

import argparse
import datetime
import email
import email.header
import email.utils
import html
import imaplib
import json
import os
import re
import smtplib
import ssl
import sys
import urllib.error
import urllib.request
from email.mime.text import MIMEText

CREDS_FILE = "/home/ubuntu/agent/gmail_app_password.json"
STATE_FILE = "/home/ubuntu/.claude-agent/email-triage-state.json"


def output(data: object) -> None:
    """Write JSON to stdout."""
    sys.stdout.write(json.dumps(data, indent=2) + "\n")
    sys.stdout.flush()


def output_error(msg: str) -> None:
    """Write error JSON to stdout and exit."""
    sys.stdout.write(json.dumps({"error": msg}) + "\n")
    sys.stdout.flush()
    sys.exit(1)


def load_credentials() -> dict:
    try:
        with open(CREDS_FILE) as f:
            creds = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError, OSError) as exc:
        output_error(f"Cannot read {CREDS_FILE}: {exc}")

    required = ["email", "app_password"]
    for key in required:
        if not creds.get(key):
            output_error(f"Missing '{key}' in {CREDS_FILE}")

    creds.setdefault("imap_host", "imap.gmail.com")
    creds.setdefault("imap_port", 993)
    creds.setdefault("smtp_host", "smtp.gmail.com")
    creds.setdefault("smtp_port", 465)
    return creds


def connect_imap(creds: dict) -> imaplib.IMAP4_SSL:
    ctx = ssl.create_default_context()
    conn = imaplib.IMAP4_SSL(creds["imap_host"], creds["imap_port"], ssl_context=ctx)
    conn.login(creds["email"], creds["app_password"])
    return conn


def decode_header_value(raw: str) -> str:
    """Decode RFC 2047 encoded header values."""
    if not raw:
        return ""
    parts = email.header.decode_header(raw)
    decoded = []
    for part, charset in parts:
        if isinstance(part, bytes):
            decoded.append(part.decode(charset or "utf-8", errors="replace"))
        else:
            decoded.append(part)
    return " ".join(decoded)


def extract_snippet(msg: email.message.Message, max_len: int = 200) -> str:
    """Extract plain text snippet from email body."""
    body = ""
    if msg.is_multipart():
        for part in msg.walk():
            ct = part.get_content_type()
            if ct == "text/plain":
                payload = part.get_payload(decode=True)
                if payload:
                    charset = part.get_content_charset() or "utf-8"
                    body = payload.decode(charset, errors="replace")
                    break
            elif ct == "text/html" and not body:
                payload = part.get_payload(decode=True)
                if payload:
                    charset = part.get_content_charset() or "utf-8"
                    raw_html = payload.decode(charset, errors="replace")
                    body = re.sub(r"<[^>]+>", " ", raw_html)
                    body = html.unescape(body)
    else:
        payload = msg.get_payload(decode=True)
        if payload:
            charset = msg.get_content_charset() or "utf-8"
            body = payload.decode(charset, errors="replace")
            if msg.get_content_type() == "text/html":
                body = re.sub(r"<[^>]+>", " ", body)
                body = html.unescape(body)

    body = re.sub(r"\s+", " ", body).strip()
    return body[:max_len] if body else ""


def parse_unsubscribe_header(msg: email.message.Message) -> tuple[bool, str]:
    """Parse List-Unsubscribe header. Returns (has_unsub, link)."""
    raw = msg.get("List-Unsubscribe", "")
    if not raw:
        return False, ""

    links = re.findall(r"<([^>]+)>", raw)
    https_link = next((lnk for lnk in links if lnk.startswith("https://")), "")
    if https_link:
        return True, https_link
    http_link = next((lnk for lnk in links if lnk.startswith("http://")), "")
    if http_link:
        return True, http_link
    mailto_link = next((lnk for lnk in links if lnk.startswith("mailto:")), "")
    if mailto_link:
        return True, mailto_link
    return bool(links), links[0] if links else ""


def get_gmail_labels(conn: imaplib.IMAP4_SSL, uid: bytes) -> list[str]:
    """Fetch Gmail labels for a message using X-GM-LABELS extension."""
    try:
        status, data = conn.uid("FETCH", uid, "(X-GM-LABELS)")
        if status == "OK" and data[0]:
            raw = data[0].decode("utf-8", errors="replace") if isinstance(data[0], bytes) else str(data[0])
            match = re.search(r"X-GM-LABELS \(([^)]*)\)", raw)
            if match:
                labels_raw = match.group(1)
                labels = re.findall(r'"([^"]*)"|\S+', labels_raw)
                return [lbl for lbl in labels if lbl]
    except imaplib.IMAP4.error:
        pass
    return []


# ---------------------------------------------------------------------------
# State management (dual UID watermarks)
# ---------------------------------------------------------------------------

def load_state() -> dict:
    """Load triage state from file, returning defaults if missing.

    Two watermarks track a processed range [low_uid, high_uid]:
    - high_uid: highest UID processed — new arrivals are above this
    - low_uid: lowest UID processed — backlog is below this
    Everything between low_uid and high_uid has been evaluated.
    """
    defaults = {"high_uid": None, "low_uid": None, "last_run": None, "total_processed": 0}
    try:
        with open(STATE_FILE) as f:
            state = json.load(f)
        for key, val in defaults.items():
            state.setdefault(key, val)
        return state
    except (FileNotFoundError, json.JSONDecodeError):
        return dict(defaults)


def save_state(state: dict) -> None:
    """Persist triage state to file."""
    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    with open(STATE_FILE, "w") as f:
        json.dump(state, f, indent=2)


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

def fetch_email_entry(conn: imaplib.IMAP4_SSL, uid: bytes, headers_only: bool) -> dict | None:
    """Fetch and parse a single email, returning a dict or None on failure."""
    fetch_part = "(RFC822.HEADER)" if headers_only else "(RFC822)"
    status, msg_data = conn.uid("FETCH", uid, fetch_part)
    if status != "OK" or not msg_data[0]:
        return None

    raw_email = msg_data[0][1]
    msg = email.message_from_bytes(raw_email)

    message_id = msg.get("Message-ID", "").strip()
    subject = decode_header_value(msg.get("Subject", ""))
    from_addr = decode_header_value(msg.get("From", ""))
    date_str = msg.get("Date", "")
    labels = get_gmail_labels(conn, uid)
    has_unsub, unsub_link = parse_unsubscribe_header(msg)

    entry = {
        "message_id": message_id,
        "uid": uid.decode("utf-8"),
        "subject": subject,
        "from": from_addr,
        "date": date_str,
        "labels": labels,
        "has_unsubscribe": has_unsub,
        "unsubscribe_link": unsub_link,
    }
    if not headers_only:
        entry["snippet"] = extract_snippet(msg)

    return entry


def cmd_fetch(args: argparse.Namespace) -> None:
    creds = load_credentials()
    conn = connect_imap(creds)

    try:
        conn.select("INBOX")

        below_uid = getattr(args, "below_uid", None)
        above_uid = getattr(args, "above_uid", None)
        headers_only = getattr(args, "headers_only", False)

        # Build IMAP UID SEARCH criteria
        if below_uid is not None:
            if below_uid <= 1:
                output({"emails": [], "total_inbox": 0, "mode": "backlog", "backlog_complete": True})
                return
            search_criteria = f"UID 1:{below_uid - 1}"
        elif above_uid is not None:
            search_criteria = f"UID {above_uid + 1}:*"
        else:
            search_criteria = "ALL"

        status, data = conn.uid("SEARCH", None, search_criteria)
        if status != "OK" or not data[0]:
            mode = "backlog" if below_uid else ("new" if above_uid else "latest")
            output({
                "emails": [],
                "total_inbox": 0,
                "mode": mode,
                "backlog_complete": below_uid is not None,
            })
            return

        uids = data[0].split()

        # Also get total inbox count for progress reporting
        all_status, all_data = conn.uid("SEARCH", None, "ALL")
        total_inbox = len(all_data[0].split()) if all_status == "OK" and all_data[0] else 0

        # Take the N highest UIDs (newest) from the matching set
        batch_uids = uids[-(args.count):] if len(uids) > args.count else uids
        batch_uids = list(reversed(batch_uids))  # newest first

        results = []
        for uid in batch_uids:
            entry = fetch_email_entry(conn, uid, headers_only)
            if entry:
                results.append(entry)

        # Determine mode and completion status
        if below_uid is not None:
            mode = "backlog"
            remaining = len(uids) - len(batch_uids)
            backlog_complete = remaining == 0
        elif above_uid is not None:
            mode = "new"
            remaining = len(uids) - len(batch_uids)
            backlog_complete = False
        else:
            mode = "latest"
            remaining = len(uids) - len(batch_uids)
            backlog_complete = False

        output({
            "emails": results,
            "total_inbox": total_inbox,
            "matched": len(uids),
            "count": len(results),
            "remaining": remaining,
            "mode": mode,
            "backlog_complete": backlog_complete,
        })
    finally:
        conn.close()
        conn.logout()


def ensure_label(conn: imaplib.IMAP4_SSL, label: str) -> None:
    """Create a Gmail label if it doesn't exist."""
    status, folders = conn.list()
    if status == "OK":
        label_exists = any(
            f'"{label}"' in (f.decode("utf-8", errors="replace") if isinstance(f, bytes) else str(f))
            for f in folders
            if f
        )
        if not label_exists:
            conn.create(label)


def find_uid_in_inbox(conn: imaplib.IMAP4_SSL, message_id: str) -> bytes | None:
    """Search INBOX for a message by Message-ID header."""
    conn.select("INBOX")
    safe_id = message_id.replace('"', '\\"')
    status, data = conn.uid("SEARCH", None, f'HEADER Message-ID "{safe_id}"')
    if status == "OK" and data[0]:
        uids = data[0].split()
        if uids:
            return uids[0]
    return None


def apply_label_and_archive(conn: imaplib.IMAP4_SSL, uid: bytes, label: str) -> None:
    """Apply a Gmail label and remove from INBOX (archive).

    Gmail IMAP: deleting from INBOX = archiving (message stays in All Mail).
    We apply the label first, then mark as deleted and expunge from INBOX.
    """
    ensure_label(conn, label)
    conn.uid("STORE", uid, "+X-GM-LABELS", f'("{label}")')
    # In Gmail, deleting from INBOX archives (removes INBOX label, keeps in All Mail)
    conn.uid("STORE", uid, "+FLAGS", "(\\Deleted)")
    conn.expunge()


def cmd_archive(args: argparse.Namespace) -> None:
    creds = load_credentials()
    conn = connect_imap(creds)

    try:
        uid = find_uid_in_inbox(conn, args.message_id)
        if not uid:
            output_error(f"Message not found in INBOX: {args.message_id}")

        apply_label_and_archive(conn, uid, args.label)

        output({
            "success": True,
            "message_id": args.message_id,
            "label": args.label,
        })
    finally:
        try:
            conn.close()
        except imaplib.IMAP4.error:
            pass
        conn.logout()


def follow_unsubscribe(link: str, creds: dict) -> str:
    """Follow an unsubscribe link. Returns method used."""
    if link.startswith("https://") or link.startswith("http://"):
        try:
            req = urllib.request.Request(
                link,
                headers={"User-Agent": "Mozilla/5.0 (compatible; email-triage/1.0)"},
            )
            with urllib.request.urlopen(req, timeout=15) as resp:
                resp.read()
            return "https"
        except (urllib.error.URLError, urllib.error.HTTPError, OSError):
            # Try RFC 8058 One-Click Unsubscribe (POST)
            try:
                req = urllib.request.Request(
                    link,
                    data=b"List-Unsubscribe=One-Click",
                    headers={
                        "User-Agent": "Mozilla/5.0 (compatible; email-triage/1.0)",
                        "Content-Type": "application/x-www-form-urlencoded",
                    },
                    method="POST",
                )
                with urllib.request.urlopen(req, timeout=15) as resp:
                    resp.read()
                return "https"
            except (urllib.error.URLError, urllib.error.HTTPError, OSError):
                return "https-failed"

    elif link.startswith("mailto:"):
        mailto = link[7:]
        parts = mailto.split("?", 1)
        to_addr = parts[0]
        subject = "Unsubscribe"

        if len(parts) > 1:
            params = dict(p.split("=", 1) for p in parts[1].split("&") if "=" in p)
            subject = params.get("subject", subject)

        try:
            msg = MIMEText("Unsubscribe")
            msg["From"] = creds["email"]
            msg["To"] = to_addr
            msg["Subject"] = subject

            ctx = ssl.create_default_context()
            with smtplib.SMTP_SSL(creds["smtp_host"], creds["smtp_port"], context=ctx) as smtp:
                smtp.login(creds["email"], creds["app_password"])
                smtp.send_message(msg)
            return "mailto"
        except (smtplib.SMTPException, OSError):
            return "mailto-failed"

    return "none"


def cmd_state(args: argparse.Namespace) -> None:
    """Print current triage state."""
    output(load_state())


def cmd_watermark(args: argparse.Namespace) -> None:
    """Set high_uid, low_uid, or both."""
    state = load_state()
    if args.high is not None:
        state["high_uid"] = args.high
    if args.low is not None:
        state["low_uid"] = args.low
    state["last_run"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    save_state(state)
    output(state)


def cmd_reset(args: argparse.Namespace) -> None:
    """Reset both watermarks to None (will be re-initialized on next fetch)."""
    state = load_state()
    state["high_uid"] = None
    state["low_uid"] = None
    state["last_run"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    save_state(state)
    output(state)


def cmd_unsubscribe(args: argparse.Namespace) -> None:
    creds = load_credentials()
    conn = connect_imap(creds)

    try:
        uid = find_uid_in_inbox(conn, args.message_id)
        if not uid:
            output_error(f"Message not found in INBOX: {args.message_id}")

        status, msg_data = conn.uid("FETCH", uid, "(RFC822.HEADER)")
        if status != "OK" or not msg_data[0]:
            output_error("Failed to fetch message headers")

        raw_headers = msg_data[0][1]
        msg = email.message_from_bytes(raw_headers)
        has_unsub, unsub_link = parse_unsubscribe_header(msg)

        method = "none"
        if has_unsub and unsub_link:
            method = follow_unsubscribe(unsub_link, creds)

        apply_label_and_archive(conn, uid, args.label)

        output({
            "success": True,
            "message_id": args.message_id,
            "label": args.label,
            "unsubscribe_method": method,
        })
    finally:
        try:
            conn.close()
        except imaplib.IMAP4.error:
            pass
        conn.logout()


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="Gmail email triage via IMAP")
    subparsers = parser.add_subparsers(dest="command", required=True)

    fetch_parser = subparsers.add_parser("fetch", help="Fetch INBOX emails")
    fetch_parser.add_argument("--count", type=int, default=10, help="Number of emails (default 10)")
    fetch_parser.add_argument("--below-uid", type=int, default=None, help="Fetch emails with UID below this value (backlog)")
    fetch_parser.add_argument("--above-uid", type=int, default=None, help="Fetch emails with UID above this value (new arrivals)")
    fetch_parser.add_argument("--headers-only", action="store_true", help="Fetch headers only (no body/snippet)")

    archive_parser = subparsers.add_parser("archive", help="Label and archive an email")
    archive_parser.add_argument("--message-id", required=True, help="Message-ID header value")
    archive_parser.add_argument("--label", default="Auto-Archive", help="Label to apply")

    unsub_parser = subparsers.add_parser("unsubscribe", help="Unsubscribe, label, and archive")
    unsub_parser.add_argument("--message-id", required=True, help="Message-ID header value")
    unsub_parser.add_argument("--label", default="Auto-Unsubscribe", help="Label to apply")

    subparsers.add_parser("state", help="Print current triage state")

    watermark_parser = subparsers.add_parser("watermark", help="Set UID watermarks")
    watermark_parser.add_argument("--high", type=int, default=None, help="Set high_uid (new arrivals boundary)")
    watermark_parser.add_argument("--low", type=int, default=None, help="Set low_uid (backlog boundary)")

    subparsers.add_parser("reset", help="Reset watermark to None")

    args = parser.parse_args()

    if args.command == "fetch":
        cmd_fetch(args)
    elif args.command == "archive":
        cmd_archive(args)
    elif args.command == "unsubscribe":
        cmd_unsubscribe(args)
    elif args.command == "state":
        cmd_state(args)
    elif args.command == "watermark":
        cmd_watermark(args)
    elif args.command == "reset":
        cmd_reset(args)


if __name__ == "__main__":
    main()
