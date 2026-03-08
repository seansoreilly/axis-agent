#!/usr/bin/env python3
"""Anthropic Admin API client for organization management."""
import argparse
import json
import os
import sys
import urllib.request
import urllib.error

BASE_URL = "https://api.anthropic.com/v1/organizations"
API_VERSION = "2023-06-01"


def api_request(path: str, api_key: str, method: str = "GET", data: dict | None = None) -> dict:
    url = f"{BASE_URL}{path}"
    headers = {
        "x-api-key": api_key,
        "anthropic-version": API_VERSION,
        "content-type": "application/json",
    }
    body = json.dumps(data).encode() if data else None
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        error_body = e.read().decode()
        try:
            error_json = json.loads(error_body)
            print(json.dumps({"success": False, "error": error_json}), file=sys.stderr)
        except json.JSONDecodeError:
            print(json.dumps({"success": False, "error": error_body}), file=sys.stderr)
        sys.exit(1)


def paginate_all(path: str, api_key: str) -> list:
    """Fetch all pages of a paginated endpoint."""
    results = []
    url_path = f"{path}?limit=100"
    while True:
        resp = api_request(url_path, api_key)
        results.extend(resp.get("data", []))
        if not resp.get("has_more"):
            break
        url_path = f"{path}?limit=100&after_id={resp['last_id']}"
    return results


def cmd_org_info(args):
    result = api_request("/me", args.api_key)
    print(json.dumps(result, indent=2))


def cmd_list_users(args):
    users = paginate_all("/users", args.api_key)
    print(json.dumps(users, indent=2))


def cmd_list_keys(args):
    path = "/api_keys"
    params = f"?limit=100&status={args.status}" if args.status else "?limit=100"
    results = []
    url_path = f"{path}{params}"
    while True:
        resp = api_request(url_path, args.api_key)
        results.extend(resp.get("data", []))
        if not resp.get("has_more"):
            break
        url_path = f"{path}{params}&after_id={resp['last_id']}"
    print(json.dumps(results, indent=2))


def cmd_update_key(args):
    data = {}
    if args.name:
        data["name"] = args.name
    if args.status:
        data["status"] = args.status
    if not data:
        print(json.dumps({"success": False, "error": "Provide --name and/or --status"}))
        sys.exit(1)
    result = api_request(f"/api_keys/{args.key_id}", args.api_key, method="POST", data=data)
    print(json.dumps(result, indent=2))


def cmd_list_workspaces(args):
    workspaces = paginate_all("/workspaces", args.api_key)
    print(json.dumps(workspaces, indent=2))


def cmd_invite(args):
    data = {"email": args.email, "role": args.role}
    result = api_request("/invites", args.api_key, method="POST", data=data)
    print(json.dumps(result, indent=2))


def main():
    parser = argparse.ArgumentParser(description="Anthropic Admin API client")
    parser.add_argument(
        "--api-key",
        default=os.environ.get("ANTHROPIC_ADMIN_KEY"),
        help="Admin API key (or set ANTHROPIC_ADMIN_KEY env var)",
    )

    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("org-info", help="Get organization info")
    subparsers.add_parser("list-users", help="List organization members")

    keys_parser = subparsers.add_parser("list-keys", help="List API keys")
    keys_parser.add_argument("--status", default="active", choices=["active", "inactive"])

    update_parser = subparsers.add_parser("update-key", help="Update an API key")
    update_parser.add_argument("--key-id", required=True)
    update_parser.add_argument("--name")
    update_parser.add_argument("--status", choices=["active", "inactive"])

    subparsers.add_parser("list-workspaces", help="List workspaces")

    invite_parser = subparsers.add_parser("invite", help="Invite a user")
    invite_parser.add_argument("--email", required=True)
    invite_parser.add_argument(
        "--role", required=True,
        choices=["user", "claude_code_user", "developer", "billing", "admin"],
    )

    args = parser.parse_args()

    if not args.api_key:
        print(json.dumps({"success": False, "error": "No API key provided. Use --api-key or set ANTHROPIC_ADMIN_KEY"}))
        sys.exit(1)

    commands = {
        "org-info": cmd_org_info,
        "list-users": cmd_list_users,
        "list-keys": cmd_list_keys,
        "update-key": cmd_update_key,
        "list-workspaces": cmd_list_workspaces,
        "invite": cmd_invite,
    }
    commands[args.command](args)


if __name__ == "__main__":
    main()
