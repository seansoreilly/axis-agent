#!/home/ubuntu/.claude-agent/venv/bin/python3
"""Triage inbox emails: classify with Haiku, archive unimportant, auto-unsubscribe.

Usage:
  python3 triage.py --count 20              # Triage 20 inbox emails
  python3 triage.py --count 10 --unread     # Unread only
  python3 triage.py --dry-run --count 5     # Classify but don't archive/unsubscribe
  python3 triage.py --no-unsubscribe        # Archive only, skip unsubscribe
"""

import argparse
import email
import imaplib
import json
import os
import re
import sys
from email.header import decode_header
from pathlib import Path

import anthropic
import requests

ENV_FILE = Path("/home/ubuntu/agent/.env")
CREDS_FILE = Path("/home/ubuntu/agent/gmail_app_password.json")
LABEL_NAME = "Auto-Archived"

CLASSIFY_PROMPT = """Classify this email as either "important" or "unimportant".

Important: personal messages, bills/invoices, appointments, action-required items,
security alerts, delivery updates for recent orders, work-related correspondence,
account notices, booking confirmations, legal or official correspondence.

Unimportant: marketing, newsletters, promotional offers, social media notifications,
automated digests, spam, mailing list bulk sends, "we miss you" re-engagement,
survey requests, product announcements.

Signals this is bulk/marketing mail:
- List-Unsubscribe header present: {has_unsubscribe}
- Precedence header: {precedence}

From: {sender}
Subject: {subject}
Date: {date}
Body (first 400 chars): {body}

Respond with ONLY a JSON object: {{"classification": "important" or "unimportant", "reason": "brief reason"}}"""


def load_env():
    """Load environment variables from .env file."""
    if ENV_FILE.exists():
        with open(ENV_FILE) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, _, value = line.partition("=")
                    os.environ.setdefault(key.strip(), value.strip())


def get_anthropic_client():
    """Create Anthropic client using API key from env or .env file."""
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise RuntimeError(
            "ANTHROPIC_API_KEY not set. Add it to /home/ubuntu/agent/.env"
        )
    return anthropic.Anthropic(api_key=api_key)


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
                payload = part.get_payload(decode=True)
                if payload:
                    return payload.decode("utf-8", errors="replace")
    else:
        payload = msg.get_payload(decode=True)
        if payload:
            return payload.decode("utf-8", errors="replace")
    return ""


def _has_calendar_invite(msg) -> bool:
    """Check if any MIME part is text/calendar."""
    for part in msg.walk():
        if part.get_content_type() == "text/calendar":
            return True
    return False


def fetch_emails(imap, count, unread_only):
    """Fetch emails using UIDs for stable references."""
    if unread_only:
        _, data = imap.uid("search", None, "UNSEEN")
    else:
        _, data = imap.uid("search", None, "ALL")

    uids = data[0].split()
    uids = uids[-count:]  # Most recent N

    emails = []
    for uid in reversed(uids):
        _, msg_data = imap.uid("fetch", uid, "(RFC822)")
        raw = msg_data[0][1]
        msg = email.message_from_bytes(raw)
        emails.append({
            "uid": uid,
            "from": decode_str(msg["From"]),
            "to": decode_str(msg["To"]),
            "subject": decode_str(msg["Subject"]),
            "date": msg["Date"],
            "body": get_body(msg)[:400],
            "list_unsubscribe": msg.get("List-Unsubscribe", ""),
            "list_unsubscribe_post": msg.get("List-Unsubscribe-Post", ""),
            "in_reply_to": msg.get("In-Reply-To", ""),
            "references": msg.get("References", ""),
            "precedence": (msg.get("Precedence") or "").lower(),
            "has_calendar_invite": _has_calendar_invite(msg),
        })

    return emails


def is_protected(em: dict) -> tuple[bool, str]:
    """Return (protected, reason). Protected emails are never auto-archived."""
    # Part of a thread
    if em.get("in_reply_to") or em.get("references"):
        return True, "thread reply"

    # Calendar invite
    if em.get("has_calendar_invite"):
        return True, "calendar invite"

    return False, ""


def classify_emails(emails, client):
    """Classify emails using Claude Haiku, with protection overrides."""
    for em in emails:
        protected, protect_reason = is_protected(em)
        if protected:
            em["protected"] = True
            em["protect_reason"] = protect_reason

        prompt = CLASSIFY_PROMPT.format(
            sender=em["from"],
            subject=em["subject"],
            date=em["date"],
            body=em["body"],
            has_unsubscribe="yes" if em.get("list_unsubscribe") else "no",
            precedence=em.get("precedence") or "none",
        )
        response = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=100,
            messages=[{"role": "user", "content": prompt}],
        )
        text = response.content[0].text.strip()
        json_match = re.search(r"\{[^}]+\}", text)
        try:
            result = json.loads(json_match.group()) if json_match else json.loads(text)
            em["classification"] = result.get("classification", "important")
            em["reason"] = result.get("reason", "")
        except (json.JSONDecodeError, AttributeError):
            em["classification"] = "important"
            em["reason"] = "Could not parse classification, defaulting to important"
        em["input_tokens"] = response.usage.input_tokens
        em["output_tokens"] = response.usage.output_tokens

        # Protected emails are always kept regardless of Haiku's classification
        if protected:
            em["classification"] = "important"

    return emails


def ensure_label(imap, label_name):
    """Create Gmail label if it doesn't exist."""
    _, folders = imap.list()
    for folder in folders:
        if isinstance(folder, bytes) and label_name.encode() in folder:
            return
    imap.create(label_name)


def archive_emails(imap, emails):
    """Archive unimportant emails: copy to label, remove from inbox."""
    ensure_label(imap, LABEL_NAME)
    archived = []
    for em in emails:
        if em["classification"] != "unimportant":
            continue
        uid = em["uid"]
        imap.uid("copy", uid, LABEL_NAME)
        imap.uid("store", uid, "+FLAGS", "\\Deleted")
        archived.append(em["subject"])
    if archived:
        imap.expunge()
    return archived


def try_unsubscribe(em):
    """Attempt to unsubscribe using List-Unsubscribe header. Returns status string."""
    header = em.get("list_unsubscribe", "")
    post_header = em.get("list_unsubscribe_post", "")
    if not header:
        return "no_header"

    urls = re.findall(r"<(https?://[^>]+)>", header)
    if not urls:
        return "mailto_only"

    https_url = urls[0]

    try:
        if post_header and "One-Click" in post_header:
            resp = requests.post(
                https_url,
                data={"List-Unsubscribe": "One-Click-Unsubscribe"},
                headers={"Content-Type": "application/x-www-form-urlencoded"},
                timeout=15,
                allow_redirects=True,
            )
            if resp.status_code < 400:
                return "unsubscribed_oneclick"
            return f"oneclick_failed_{resp.status_code}"

        resp = requests.get(https_url, timeout=15, allow_redirects=True)
        if resp.status_code < 400:
            return "unsubscribed_get"
        return f"get_failed_{resp.status_code}"

    except requests.RequestException as e:
        return f"request_error: {str(e)[:80]}"


def run_unsubscribe(emails):
    """Attempt unsubscribe for all unimportant emails."""
    results = []
    for em in emails:
        if em["classification"] != "unimportant":
            continue
        status = try_unsubscribe(em)
        results.append({
            "from": em["from"],
            "subject": em["subject"],
            "status": status,
        })
    return results


def format_telegram_summary(output: dict, dry_run: bool) -> str:
    """Format triage results as Telegram-friendly Markdown."""
    s = output["summary"]
    mode = " (dry run)" if dry_run else ""
    lines = [
        f"*Email Triage{mode} Complete*",
        f"Checked {s['total']} emails",
        "",
    ]

    if s["important"] > 0:
        lines.append(f"*Kept ({s['important']}):*")
        for em in output["important"]:
            subj = em["subject"][:55] + "..." if len(em["subject"]) > 55 else em["subject"]
            tag = " [protected]" if em.get("protected") else ""
            lines.append(f"  - {subj}{tag}")
        lines.append("")

    if s["unimportant"] > 0:
        action = "Would archive" if dry_run else f"Archived"
        lines.append(f"*{action} ({s['unimportant']}):*")
        for em in output["unimportant"]:
            subj = em["subject"][:55] + "..." if len(em["subject"]) > 55 else em["subject"]
            lines.append(f"  - {subj}")
        lines.append("")

    unsub = output.get("unsubscribe_results", [])
    if unsub:
        success = [r for r in unsub if "unsubscribed" in r["status"]]
        if success:
            lines.append(f"*Unsubscribed from {len(success)} sender(s)*")
            lines.append("")

    lines.append(f"_Cost: ${s['cost_usd']:.4f}_")
    return "\n".join(lines)


def emit(data):
    """Write JSON output to stdout."""
    sys.stdout.write(json.dumps(data, indent=2, ensure_ascii=False))
    sys.stdout.write("\n")


def main():
    parser = argparse.ArgumentParser(description="Triage inbox emails with AI classification")
    parser.add_argument("--count", type=int, default=20, help="Number of emails to triage")
    parser.add_argument("--unread", action="store_true", help="Only triage unread emails")
    parser.add_argument("--dry-run", action="store_true", help="Classify only, don't archive or unsubscribe")
    parser.add_argument("--no-unsubscribe", action="store_true", help="Archive but skip unsubscribe")
    args = parser.parse_args()

    load_env()
    user, password = load_creds()

    # Phase 1: Fetch all emails
    with imaplib.IMAP4_SSL("imap.gmail.com", 993) as imap:
        imap.login(user, password)
        imap.select("INBOX")
        emails = fetch_emails(imap, args.count, args.unread)

    if not emails:
        output = {"emails": [], "summary": "No emails to triage"}
        output["telegram_summary"] = "No emails to triage."
        emit(output)
        return

    # Phase 2: Classify with Haiku (protection guardrails applied inside)
    client = get_anthropic_client()
    classify_emails(emails, client)

    important = [e for e in emails if e["classification"] == "important"]
    unimportant = [e for e in emails if e["classification"] == "unimportant"]

    # Phase 3: Archive + Unsubscribe (unless dry run)
    archived = []
    unsub_results = []

    if not args.dry_run and unimportant:
        with imaplib.IMAP4_SSL("imap.gmail.com", 993) as imap:
            imap.login(user, password)
            imap.select("INBOX")
            archived = archive_emails(imap, emails)

        if not args.no_unsubscribe:
            unsub_results = run_unsubscribe(emails)

    # Build summary
    total_input = sum(e.get("input_tokens", 0) for e in emails)
    total_output = sum(e.get("output_tokens", 0) for e in emails)
    # Haiku pricing: $0.80/MTok input, $4/MTok output
    cost = (total_input * 0.80 + total_output * 4.0) / 1_000_000

    output = {
        "summary": {
            "total": len(emails),
            "important": len(important),
            "unimportant": len(unimportant),
            "archived": len(archived),
            "protected": len([e for e in emails if e.get("protected")]),
            "dry_run": args.dry_run,
            "cost_usd": round(cost, 6),
            "tokens": {"input": total_input, "output": total_output},
        },
        "important": [
            {
                "from": e["from"],
                "subject": e["subject"],
                "reason": e["reason"],
                **({"protected": True, "protect_reason": e["protect_reason"]} if e.get("protected") else {}),
            }
            for e in important
        ],
        "unimportant": [
            {"from": e["from"], "subject": e["subject"], "reason": e["reason"]}
            for e in unimportant
        ],
    }

    if unsub_results:
        output["unsubscribe_results"] = unsub_results

    output["telegram_summary"] = format_telegram_summary(output, args.dry_run)

    emit(output)


if __name__ == "__main__":
    main()
