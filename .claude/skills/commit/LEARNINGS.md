# Commit Skill Learnings

Append entries below when a commit operation succeeds, fails, or requires correction.

## Entry Format

### [date] - [operation] - [outcome: success|failure|correction]
- **What happened**: Brief description
- **Root cause** (if failure/correction): What went wrong
- **Fix applied**: What was changed
- **Lesson**: What to do differently next time

---

<!-- Entries below -->

### 2026-03-05 - PII in repo - correction
- **What happened**: Hardcoded IP addresses, SSH key paths, and server hostnames were found in committed code (health-check.sh, sync-secrets.sh, etc.).
- **Root cause**: Scripts were written with literal values instead of env vars.
- **Fix applied**: Replaced hardcoded values with env vars (`DEPLOY_HOST`, `DEPLOY_HOST_IP`, `SSH_KEY`). Committed the cleanup as a dedicated fix.
- **Lesson**: Always use env vars for server addresses, IPs, and key paths. The secret check in Step 2 catches API keys but not infrastructure details — Step 3 (PII check) must also cover IPs and hostnames.

### 2026-03-05 - instance repo sync - lesson
- **What happened**: The instance repo frequently has uncommitted changes from agent self-modifications. Step 7 catches these and commits them to `claude-agent-internal`.
- **Lesson**: Always run Step 7. The instance repo diverges from the local repo because the agent modifies its own source code on the server. Both repos should be committed and pushed after every session.

### 2026-03-05 - nanobanana-output in gitignore - lesson
- **What happened**: Image generation tool (nano-banana/Gemini) creates output in `nanobanana-output/` which shouldn't be committed.
- **Fix applied**: Added `nanobanana-output/` to `.gitignore`.
- **Lesson**: When new tools create output directories, add them to `.gitignore` in Step 1 before staging.

### 2026-03-05 - version bump - lesson
- **What happened**: Project uses semver with `npm version`. Every commit should consider whether a version bump is needed.
- **Lesson**: Run `npm version patch|minor|major --no-git-tag-version` before committing, then stage `package.json` and `package-lock.json`. Don't forget to push tags and create GitHub releases for significant changes.
