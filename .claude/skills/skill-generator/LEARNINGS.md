# Skill Generation Learnings

Append entries below when a skill creation succeeds, fails, or requires correction.

## Entry Format

### [date] - [skill-name] - [outcome: success|failure|correction]
- **What happened**: Brief description
- **Root cause** (if failure/correction): What went wrong
- **Fix applied**: What was changed
- **Lesson**: What to do differently next time

---

<!-- Entries below -->

### 2026-03-05 - twilio - correction
- **What happened**: Twilio skill had SKILL.md and `_common.py` but `send_sms.py` was never created. The skill was documented but non-functional.
- **Root cause**: Skeleton was committed (SKILL.md + shared helpers) without the actual scripts that do the work.
- **Fix applied**: Created `send_sms.py` using stdlib `urllib` (no external deps) and the existing `_common.py` helpers.
- **Lesson**: Always create the actual executable scripts alongside SKILL.md. A skill isn't done until you can run its commands end-to-end.

### 2026-03-05 - twilio - correction
- **What happened**: Twilio AU1 region returned error 20003 (Authenticate) when using Account SID + Auth Token for Basic auth.
- **Root cause**: AU1 region requires API Key SID + API Key Secret for authentication, not the main Account SID + Auth Token. The credentials file had both `api_key_sid`/`api_key_secret` and `account_sid`/`auth_token`, but `_common.py` only used the latter.
- **Fix applied**: Updated `load_credentials()` to return a 5-tuple, preferring API Key credentials when available. Updated `make_auth_header()` to accept generic auth_user/auth_secret params.
- **Lesson**: Twilio regional deployments (AU1, IE1, etc.) require API Key auth. When building Twilio integrations, always prefer API Key credentials over Account SID + Auth Token.

### 2026-03-05 - twilio - correction
- **What happened**: Agent ignored the contact lookup instructions and asked the user for phone numbers instead of looking them up via Google Contacts.
- **Root cause**: SOUL.md was loaded as the core prompt, completely bypassing the built-in fallback prompt in `agent.ts` which contained the contact lookup instructions. SOUL.md had no contact lookup section.
- **Fix applied**: Added the "Contact Lookup (MANDATORY)" section to SOUL.md with explicit steps for lookup → extract → send.
- **Lesson**: When the agent uses SOUL.md for personality, ALL critical instructions must be in SOUL.md — the built-in fallback prompt in agent.ts is never used. Any new workflow instructions must be added to SOUL.md, not just agent.ts.

### 2026-03-05 - general - lesson
- **What happened**: Skill scripts handle credentials (API keys, tokens, auth secrets) that get loaded from JSON files or env vars.
- **Lesson**: Before deploying any skill script, always audit for hardcoded secrets, debug logging that could leak credentials, or credential values that could end up in git. Check that credentials are loaded from external files/env vars only, never embedded in code.

### 2026-03-08 - claude-admin - success
- **What happened**: Created Claude Code Admin skill for Anthropic Admin API (org management, users, API keys, workspaces, invites).
- **Lesson**: The Anthropic Admin API uses `sk-ant-admin...` keys (different from regular API keys). Base URL is `https://api.anthropic.com/v1/organizations/`. The Admin API covers org/user/key/workspace management but does NOT expose subscription billing (Claude Pro/Max/Team plans) — only API usage. New API keys can only be created via Console UI, not via API.

### 2026-03-08 - bitwarden - lesson
- **What happened**: Bitwarden CLI `bw unlock --raw` doesn't work with interactive input in Claude Code's bash tool. Each bash invocation is a separate process so BW_SESSION tokens don't persist.
- **Fix applied**: Pass password directly to `bw unlock 'password' --raw` and chain all commands in a single bash call.
- **Lesson**: For Bitwarden operations in Claude Code, always chain unlock + operations + lock in a single bash command. The session token won't persist across separate tool invocations. Ask user for master password via AskUserQuestion if needed.
