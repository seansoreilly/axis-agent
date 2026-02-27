# Sync Local Repo from Deployed Instance

Pull all changes the agent has made to itself on the Lightsail instance back to this local repo, scrub personal data, and commit.

## Context

The agent on Lightsail can modify its own source code via `scripts/deploy-self.sh`. This means the instance may have changes not reflected in this repo. This skill syncs the local repo to match.

- **SSH key:** `~/.ssh/claude-code-agent-key.pem`
- **Instance:** `ubuntu@REDACTED_SERVER_IP` (use `DEPLOY_HOST` env var if set)
- **Remote dir:** `/home/ubuntu/agent`

## Steps

### 1. Rsync from instance

Pull all files from the instance, excluding generated/sensitive files:

```bash
REMOTE="${DEPLOY_HOST:-ubuntu@REDACTED_SERVER_IP}"
rsync -avz --delete \
  --exclude node_modules \
  --exclude dist \
  --exclude .env \
  --exclude .git \
  --exclude memories.json \
  --exclude store.json \
  --exclude '__pycache__' \
  -e "ssh -i ~/.ssh/claude-code-agent-key.pem" \
  "$REMOTE:/home/ubuntu/agent/" ./
```

### 2. Check what changed

Run `git status` and `git diff --stat` to understand the scope of changes.

### 3. Scrub personal data

Search for and remove any personal data that should not be in a public repo. Check for:
- Telegram bot tokens, user IDs
- API keys, passwords, secrets
- Google service account emails
- iCal/calendar URLs
- IP addresses (except in CLAUDE.md deployment docs)
- Email addresses (except in generic docs)
- Any PII the agent may have embedded

Use this search:
```
grep -riE '(sk-ant|bot[0-9]{8,}|@.*gserviceaccount|calendar\.google\.com/calendar/ical|TELEGRAM_BOT_TOKEN=\S+|TELEGRAM_ALLOWED_USERS=[0-9])' --include='*.ts' --include='*.py' --include='*.js' --include='*.md' --include='*.json' .
```

Replace any hardcoded secrets with environment variable references. If secrets were in the system prompt (`src/agent.ts`), replace with generic instructions pointing to `.env`.

### 4. Install and build

```bash
npm install
npm run build
```

Verify TypeScript compiles clean. Fix any issues.

### 5. Run tests (if available)

```bash
npm test
```

Fix any failures before committing.

### 6. Commit and push

Stage all changes and create a conventional commit:
- Type: `feat` if new features were added, `fix` for fixes, `chore` for maintenance
- Include a summary of what the agent changed in the commit body
- Push to origin

## Important

- **Do NOT redeploy to the instance.** The scrubbing is only for the public git repo. The instance is private and the unscrubbed version is fine there. Redeploying could break things by removing hardcoded values the agent relies on.
- NEVER commit files containing real tokens, passwords, or API keys
- The `.env` file is gitignored and should never be synced
- `memories.json` and `store.json` contain user data and are gitignored
- Google credential files (`google-credentials.json`, `google-token.json`) live on the instance only
- If unsure whether something is sensitive, ask the user before committing

$ARGUMENTS
