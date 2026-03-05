# Bitwarden Skill Learnings

Append entries below when a vault operation succeeds, fails, or requires correction.

## Entry Format

### [date] - [operation] - [outcome: success|failure|correction]
- **What happened**: Brief description
- **Root cause** (if failure/correction): What went wrong
- **Fix applied**: What was changed
- **Lesson**: What to do differently next time

---

<!-- Entries below -->

### 2026-03-05 - vault unlock - correction
- **What happened**: Running `bw unlock --raw` in a subshell without exporting `BW_SESSION` meant subsequent `bw` commands in the parent shell still saw the vault as locked.
- **Root cause**: `BW_SESSION=$(bw unlock --raw)` without `export` only sets the variable for the current shell. Subshells and chained commands don't inherit it.
- **Fix applied**: Always use `export BW_SESSION=$(bw unlock --raw)` and verify with `bw status`.
- **Lesson**: Always `export` the session token. When chaining commands across subshells, pass `--session "$BW_SESSION"` explicitly.

### 2026-03-05 - vault search - lesson
- **What happened**: Searched for a "gemini" API key in the vault. The search returned empty, which was correct (key didn't exist), but the search workflow wasn't documented in the skill.
- **Lesson**: Document search patterns in the skill. Use `bw list items --search "term"` for name search, and `bw get notes "$ID"` to read content. Always search before assuming a secret doesn't exist — it might be nested inside `env-secrets` notes field.

### 2026-03-05 - env-secrets grep - lesson
- **What happened**: After searching for a named item failed, needed to also grep inside the `env-secrets` notes field since individual API keys are stored as `KEY=value` lines there, not as separate vault items.
- **Lesson**: Two-layer search needed: (1) `bw list items --search` for named items, (2) `bw get notes "$BW_ENV_SECRETS_ID" | grep KEY_NAME` for keys inside env-secrets. Always check both.
