#!/usr/bin/env python3
"""
Post a text-only update to a Facebook Page via the Graph API.

Usage:
  python3 post_text.py --message "Post text here"

Credentials (env vars take priority, JSON file is fallback):
  - FACEBOOK_PAGE_ID / FACEBOOK_PAGE_TOKEN env vars
  - /home/ubuntu/.claude-agent/facebook-page-token.json  (keys: page_id, page_access_token)

Output (stdout):
  Success: {"success": true, "post_id": "PAGE_ID_POST_ID", "url": "https://www.facebook.com/PAGE_ID/posts/POST_ID"}
  Error:   {"error": "description"}
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

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
# Graph API
# ---------------------------------------------------------------------------

def create_text_post(page_id, token, message):
    """
    POST to /feed with a plain text message.  Returns the full post ID string.
    """
    params = {"message": message, "access_token": token}
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
        try:
            body_text = exc.read().decode()
            err_data = json.loads(body_text)
            fb_err = err_data.get("error", {})
            msg = fb_err.get("message") or body_text
        except Exception:
            msg = f"HTTP {exc.code}"
        raise RuntimeError(f"Failed to create post: {msg}") from exc


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Post a text update to a Facebook Page"
    )
    parser.add_argument("--message", required=True, help="Post text")
    args = parser.parse_args()

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
        post_id_full = create_text_post(page_id, token, args.message)

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


if __name__ == "__main__":
    main()
