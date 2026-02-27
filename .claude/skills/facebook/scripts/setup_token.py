#!/usr/bin/env python3
"""
Facebook Page Access Token setup script.

Automates the token exchange flow:
1. Prints OAuth URL for user to visit in browser
2. User pastes back the redirect URL (contains auth code)
3. Exchanges code → short-lived user token
4. Exchanges → long-lived user token
5. Gets page access token for the target page
6. Saves to /home/ubuntu/.claude-agent/facebook-page-token.json

Usage:
  python3 setup_token.py --app-id APP_ID --app-secret APP_SECRET --page-name YOUR_PAGE_NAME
  python3 setup_token.py --app-id APP_ID --app-secret APP_SECRET --page-name YOUR_PAGE_NAME --user-token TOKEN
"""

import argparse
import json
import sys
import urllib.request
import urllib.parse
import urllib.error

GRAPH_API = "https://graph.facebook.com/v21.0"
REDIRECT_URI = "https://www.facebook.com/connect/login_success.html"
TOKEN_FILE = "/home/ubuntu/.claude-agent/facebook-page-token.json"

PERMISSIONS = [
    "pages_manage_posts",
    "pages_read_engagement",
    "pages_show_list",
    "pages_read_user_content",
]


def api_get(url):
    try:
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        try:
            err = json.loads(body)
            print(f"API Error: {json.dumps(err, indent=2)}", file=sys.stderr)
        except Exception:
            print(f"HTTP {e.code}: {body}", file=sys.stderr)
        sys.exit(1)


def exchange_code_for_token(app_id, app_secret, code):
    """Exchange authorization code for short-lived user access token."""
    params = urllib.parse.urlencode({
        "client_id": app_id,
        "redirect_uri": REDIRECT_URI,
        "client_secret": app_secret,
        "code": code,
    })
    url = f"{GRAPH_API}/oauth/access_token?{params}"
    data = api_get(url)
    return data["access_token"]


def extend_token(app_id, app_secret, short_token):
    """Exchange short-lived token for long-lived token (~60 days)."""
    params = urllib.parse.urlencode({
        "grant_type": "fb_exchange_token",
        "client_id": app_id,
        "client_secret": app_secret,
        "fb_exchange_token": short_token,
    })
    url = f"{GRAPH_API}/oauth/access_token?{params}"
    data = api_get(url)
    return data["access_token"]


def get_page_token(user_token, page_name):
    """Get never-expiring page access token from long-lived user token."""
    url = f"{GRAPH_API}/me/accounts?access_token={urllib.parse.quote(user_token)}"
    data = api_get(url)

    for page in data.get("data", []):
        if page_name.lower() in page.get("name", "").lower() or page_name.lower() in page.get("id", "").lower():
            return {
                "page_id": page["id"],
                "page_name": page["name"],
                "page_access_token": page["access_token"],
            }

    # Show available pages if not found
    available = [f"  - {p['name']} (ID: {p['id']})" for p in data.get("data", [])]
    print(f"Page matching '{page_name}' not found. Available pages:", file=sys.stderr)
    print("\n".join(available) if available else "  (none)", file=sys.stderr)
    sys.exit(1)


def main():
    parser = argparse.ArgumentParser(description="Set up Facebook Page Access Token")
    parser.add_argument("--app-id", required=True, help="Facebook App ID")
    parser.add_argument("--app-secret", required=True, help="Facebook App Secret")
    parser.add_argument("--page-name", required=True, help="Facebook Page name to find")
    parser.add_argument("--user-token", help="Skip OAuth — provide a user access token directly")
    parser.add_argument("--code", help="Authorization code from redirect URL")
    args = parser.parse_args()

    if args.user_token:
        # Direct token provided (e.g., from Graph API Explorer)
        short_token = args.user_token
    elif args.code:
        # Auth code provided
        print("Exchanging authorization code for access token...")
        short_token = exchange_code_for_token(args.app_id, args.app_secret, args.code)
    else:
        # Generate OAuth URL
        params = urllib.parse.urlencode({
            "client_id": args.app_id,
            "redirect_uri": REDIRECT_URI,
            "scope": ",".join(PERMISSIONS),
            "response_type": "code",
        })
        oauth_url = f"https://www.facebook.com/v21.0/dialog/oauth?{params}"

        print("=" * 60)
        print("STEP 1: Open this URL in your browser and authorize:")
        print()
        print(oauth_url)
        print()
        print("STEP 2: After authorizing, you'll be redirected.")
        print("Copy the FULL redirect URL and paste it below.")
        print("=" * 60)

        redirect_url = input("\nPaste redirect URL: ").strip()

        # Extract code from redirect URL
        parsed = urllib.parse.urlparse(redirect_url)
        params = urllib.parse.parse_qs(parsed.query)
        if "code" not in params:
            # Try fragment
            params = urllib.parse.parse_qs(parsed.fragment)
        if "code" not in params:
            print("Error: No authorization code found in URL", file=sys.stderr)
            sys.exit(1)

        code = params["code"][0]
        print("Exchanging authorization code for access token...")
        short_token = exchange_code_for_token(args.app_id, args.app_secret, code)

    print("Extending to long-lived token...")
    long_token = extend_token(args.app_id, args.app_secret, short_token)

    print(f"Getting page token for '{args.page_name}'...")
    page_info = get_page_token(long_token, args.page_name)

    # Save to file
    import os
    os.makedirs(os.path.dirname(TOKEN_FILE), exist_ok=True)
    with open(TOKEN_FILE, "w") as f:
        json.dump(page_info, f, indent=2)
    os.chmod(TOKEN_FILE, 0o600)

    print(f"\nSuccess! Saved to {TOKEN_FILE}")
    print(f"  Page: {page_info['page_name']}")
    print(f"  ID:   {page_info['page_id']}")
    print(f"  Token: {page_info['page_access_token'][:20]}...")
    print(json.dumps({"success": True, **{k: v for k, v in page_info.items() if k != "page_access_token"}}))


if __name__ == "__main__":
    main()
