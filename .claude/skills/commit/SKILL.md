---
name: commit
description: Safe git commit and push with secret/PII leak prevention
user_invocable: true
tags: [git, security, commit]
---

# /commit — Safe Git Commit & Push

When the user invokes `/commit`, perform ALL of the following steps in order. Do not skip any step. Stop and warn the user if any check fails.

## Step 1: Update .gitignore

Review the repo for files that should never be committed. Ensure `.gitignore` includes at minimum:

```
node_modules/
dist/
.env
*.log
*.json.bak
__pycache__/
```

Also glob for any credential/secret files (e.g. `*password*`, `*credentials*`, `*token*`, `*secret*`, `*service-account*`, `*.pem`, `*.key`) and ensure they are in `.gitignore`. If `.gitignore` needs updating, edit it and stage the change.

## Step 2: Check secrets in .env

Read `.env` and extract all secret key names (tokens, passwords, API keys). Then scan all staged files (`git diff --cached`) for any of those secret **values**. If any secret value appears in staged content, **stop immediately** and warn the user. Do NOT commit.

Secret patterns to check for in staged diffs:
- All values from `.env` that look like tokens/keys/passwords (not ports, model names, or directory paths)
- Hardcoded API keys, bot tokens, app passwords, GH tokens
- Any string matching common secret patterns: `ghp_`, `sk-`, `AIza`, `xoxb-`, `AAAA` (Telegram bot tokens)

## Step 3: Check for personal information

Scan all staged file diffs (`git diff --cached`) for personal information that shouldn't be committed:
- Email addresses (except in config templates like `.env.example`)
- Phone numbers
- Physical addresses
- Full names associated with accounts

If PII is found in code/config files (not documentation that intentionally references it), warn the user and list what was found. Ask for confirmation before proceeding.

## Step 4: Git commit

- Run `git status` to show what will be committed
- Stage all changes with `git add -A`
- Re-run the checks from steps 2-3 on the final staged diff
- Write a clear, concise commit message summarizing the changes
- Commit (do NOT use `--no-verify`)

## Step 5: Git push

- Push to the current branch's remote tracking branch
- If no upstream is set, push with `-u origin <branch>`
- Report the result (success or failure) to the user
