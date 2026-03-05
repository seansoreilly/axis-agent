# Facebook Skill Learnings

Append entries below when a posting operation succeeds, fails, or requires correction.

## Entry Format

### [date] - [operation] - [outcome: success|failure|correction]
- **What happened**: Brief description
- **Root cause** (if failure/correction): What went wrong
- **Fix applied**: What was changed
- **Lesson**: What to do differently next time

---

<!-- Entries below -->

### 2026-03-05 - photo optimization - lesson
- **What happened**: The optimize_photo.mjs script handles EXIF rotation, exposure/saturation/contrast adjustment, saliency-based smart crop, and sharpening. Two modes: `single` (4:5 portrait) and `multi` (1:1 square).
- **Lesson**: Always optimize photos before posting — phone photos often have EXIF rotation issues and suboptimal exposure. Use `--mode single` for single-photo posts (portrait crop) and `--mode multi` for multi-photo posts (square crop). Batch mode processes in parallel for speed.

### 2026-03-05 - app mode - lesson
- **What happened**: Facebook posts succeed but return a warning when the app is in Development mode (posts only visible to app admins/testers).
- **Lesson**: Check the `warning` field in post output. If present, the app needs to be switched to Live mode in the Facebook Developer Console for public visibility.

### 2026-03-05 - credential storage - lesson
- **What happened**: Page token is stored in `/home/ubuntu/.claude-agent/facebook-page-token.json` and managed via Bitwarden vault.
- **Lesson**: Token refresh requires running `setup_token.py` interactively (OAuth browser flow). This can't be done headless — must be done on a machine with a browser, then synced to the server via Bitwarden.
