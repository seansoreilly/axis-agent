#!/usr/bin/env python3
"""
Post a multi-photo update to a Facebook Page via the Graph API.

Usage:
  python3 post_photos.py --message "Post text here" --photos /tmp/photo1.jpg /tmp/photo2.jpg

Credentials (env vars take priority, JSON file is fallback):
  - FACEBOOK_PAGE_ID / FACEBOOK_PAGE_TOKEN env vars
  - /home/ubuntu/.claude-agent/facebook-page-token.json  (keys: page_id, page_access_token)

Output (stdout):
  Success: {"success": true, "post_id": "PAGE_ID_POST_ID", "url": "https://www.facebook.com/PAGE_ID/posts/POST_ID"}
  Error:   {"error": "description"}
"""

import argparse
import io
import json
import mimetypes
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid

GRAPH_API = "https://graph.facebook.com/v21.0"
TOKEN_FILE = "/home/ubuntu/.claude-agent/facebook-page-token.json"


# ---------------------------------------------------------------------------
# Credentials
# ---------------------------------------------------------------------------

def load_credentials():
    page_id = os.environ.get("FACEBOOK_PAGE_ID")
    token = os.environ.get("FACEBOOK_PAGE_TOKEN")

    if page_id and token:
        return page_id, token

    # Fall back to JSON file
    try:
        with open(TOKEN_FILE) as f:
            data = json.load(f)
        page_id = data.get("page_id")
        token = data.get("page_access_token")
        if page_id and token:
            return page_id, token
    except FileNotFoundError:
        pass
    except (json.JSONDecodeError, OSError) as exc:
        print(f"Warning: could not read {TOKEN_FILE}: {exc}", file=sys.stderr)

    return None, None


# ---------------------------------------------------------------------------
# Multipart form-data helpers (stdlib only)
# ---------------------------------------------------------------------------

def _encode_multipart(fields, files):
    """
    Build a multipart/form-data body.

    fields : dict of {name: value}  (plain text fields)
    files  : list of (field_name, filename, content_type, data_bytes)

    Returns (body_bytes, content_type_header_value).
    """
    boundary = uuid.uuid4().hex
    buf = io.BytesIO()

    def write(s):
        buf.write(s if isinstance(s, bytes) else s.encode())

    crlf = b"\r\n"

    for name, value in fields.items():
        write(f"--{boundary}\r\n")
        write(f'Content-Disposition: form-data; name="{name}"\r\n')
        write(crlf)
        write(f"{value}\r\n")

    for field_name, filename, content_type, data in files:
        write(f"--{boundary}\r\n")
        write(
            f'Content-Disposition: form-data; name="{field_name}"; filename="{filename}"\r\n'
        )
        write(f"Content-Type: {content_type}\r\n")
        write(crlf)
        buf.write(data)
        buf.write(crlf)

    write(f"--{boundary}--\r\n")

    body = buf.getvalue()
    content_type_header = f"multipart/form-data; boundary={boundary}"
    return body, content_type_header


# ---------------------------------------------------------------------------
# Graph API helpers
# ---------------------------------------------------------------------------

def _handle_http_error(exc):
    """Parse a Facebook HTTPError and return a human-readable string."""
    try:
        body = exc.read().decode()
        err_data = json.loads(body)
        fb_err = err_data.get("error", {})
        return fb_err.get("message") or body
    except Exception:
        return f"HTTP {exc.code}"


def upload_photo_unpublished(page_id, token, photo_path):
    """
    Upload a single photo as unpublished and return its photo ID.
    """
    mime_type, _ = mimetypes.guess_type(photo_path)
    if not mime_type:
        mime_type = "application/octet-stream"

    with open(photo_path, "rb") as f:
        photo_data = f.read()

    filename = os.path.basename(photo_path)

    fields = {
        "published": "false",
        "access_token": token,
    }
    files = [("source", filename, mime_type, photo_data)]

    body, ct_header = _encode_multipart(fields, files)

    url = f"{GRAPH_API}/{page_id}/photos"
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": ct_header},
        method="POST",
    )

    try:
        with urllib.request.urlopen(req) as resp:
            result = json.loads(resp.read().decode())
            return result["id"]
    except urllib.error.HTTPError as exc:
        msg = _handle_http_error(exc)
        raise RuntimeError(f"Failed to upload photo '{filename}': {msg}") from exc


def create_feed_post(page_id, token, message, photo_ids):
    """
    Create a feed post that attaches the given (already-uploaded) photo IDs.
    """
    params = {"message": message, "access_token": token}

    for i, pid in enumerate(photo_ids):
        params[f"attached_media[{i}]"] = json.dumps({"media_fbid": pid})

    body = urllib.parse.urlencode(params).encode()
    url = f"{GRAPH_API}/{page_id}/feed"
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(req) as resp:
            result = json.loads(resp.read().decode())
            return result["id"]
    except urllib.error.HTTPError as exc:
        msg = _handle_http_error(exc)
        raise RuntimeError(f"Failed to create feed post: {msg}") from exc


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Post multiple photos to a Facebook Page"
    )
    parser.add_argument("--message", required=True, help="Post caption / text")
    parser.add_argument(
        "--photos", required=True, nargs="+", metavar="FILE", help="Photo file paths"
    )
    args = parser.parse_args()

    # Validate photo files exist before hitting the API
    for path in args.photos:
        if not os.path.isfile(path):
            print(json.dumps({"error": f"Photo file not found: {path}"}))
            sys.exit(1)

    page_id, token = load_credentials()
    if not page_id or not token:
        print(
            json.dumps(
                {
                    "error": (
                        "Credentials not found. Set FACEBOOK_PAGE_ID and "
                        f"FACEBOOK_PAGE_TOKEN env vars, or populate {TOKEN_FILE}"
                    )
                }
            )
        )
        sys.exit(1)

    try:
        photo_ids = []
        for path in args.photos:
            print(f"Uploading {path} ...", file=sys.stderr)
            pid = upload_photo_unpublished(page_id, token, path)
            print(f"  -> photo ID {pid}", file=sys.stderr)
            photo_ids.append(pid)

        print("Creating post ...", file=sys.stderr)
        post_id_full = create_feed_post(page_id, token, args.message, photo_ids)

        # The returned id is typically "PAGE_ID_POST_ID"; extract the numeric post part
        post_numeric = post_id_full.split("_")[-1] if "_" in post_id_full else post_id_full

        result = {
            "success": True,
            "post_id": post_id_full,
            "url": f"https://www.facebook.com/{page_id}/posts/{post_numeric}",
        }
        print(json.dumps(result))
        sys.exit(0)

    except RuntimeError as exc:
        print(json.dumps({"error": str(exc)}))
        sys.exit(1)
    except OSError as exc:
        print(json.dumps({"error": f"File error: {exc}"}))
        sys.exit(1)


if __name__ == "__main__":
    main()
