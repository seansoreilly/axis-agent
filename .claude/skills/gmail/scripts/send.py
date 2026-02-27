#!/usr/bin/env python3
"""Send an email via Gmail using app password.

Usage:
  python3 send.py --to recipient@example.com --subject "Hello" --body "Message body"
  python3 send.py --to a@b.com --subject "Hi" --body "Hello" --html
"""

import argparse
import json
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path

CREDS_FILE = Path("/home/ubuntu/agent/gmail_app_password.json")


def load_creds():
    with open(CREDS_FILE) as f:
        c = json.load(f)
    return c["email"], c["app_password"].replace(" ", "")


def send_email(to: str, subject: str, body: str, html: bool = False):
    email, password = load_creds()

    msg = MIMEMultipart("alternative" if html else "mixed")
    msg["From"] = email
    msg["To"] = to
    msg["Subject"] = subject
    msg.attach(MIMEText(body, "html" if html else "plain"))

    with smtplib.SMTP_SSL("smtp.gmail.com", 465) as smtp:
        smtp.login(email, password)
        smtp.sendmail(email, to, msg.as_string())

    print(f"✅ Email sent to {to}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Send email via Gmail")
    parser.add_argument("--to", required=True, help="Recipient email address")
    parser.add_argument("--subject", required=True, help="Email subject")
    parser.add_argument("--body", required=True, help="Email body")
    parser.add_argument("--html", action="store_true", help="Send as HTML")
    args = parser.parse_args()

    send_email(args.to, args.subject, args.body, args.html)
