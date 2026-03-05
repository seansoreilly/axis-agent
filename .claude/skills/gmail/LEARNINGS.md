# Gmail Skill Learnings

Append entries below when an email triage operation succeeds, fails, or requires correction.

## Entry Format

### [date] - [operation] - [outcome: success|failure|correction]
- **What happened**: Brief description
- **Root cause** (if failure/correction): What went wrong
- **Fix applied**: What was changed
- **Lesson**: What to do differently next time

---

<!-- Entries below -->

### 2026-03-05 - dual watermark design - lesson
- **What happened**: Initial single-watermark approach failed because processing new arrivals (above watermark) and backlog (below watermark) fought over the same cursor value.
- **Lesson**: Use dual watermarks — `high_uid` only moves up (new arrivals), `low_uid` only moves down (backlog). The processed range `[low_uid, high_uid]` only grows. IMAP UIDs are immutable so this is safe against inbox churn.

### 2026-03-05 - headers-only mode - lesson
- **What happened**: Backlog processing was slow because full email bodies were being fetched for emails that would be archived based on subject/sender alone.
- **Lesson**: Use `--headers-only` for backlog passes. Only fetch full body when the agent needs to read content to make a decision. This significantly speeds up bulk triage.

### 2026-03-05 - IMAP credentials - lesson
- **What happened**: Gmail requires an app password for IMAP access (not the regular account password). 2FA must be enabled first.
- **Lesson**: Credentials are in `gmail_app_password.json` managed via Bitwarden. If IMAP auth fails, check that the app password hasn't been revoked and that "Less secure apps" isn't a factor (app passwords bypass this).
