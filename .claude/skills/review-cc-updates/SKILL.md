---
name: Review Claude Code CLI Updates
description: Research recent Claude Code CLI updates, identify agent improvements, implement changes, test, commit, and deploy
user_invocable: true
tags: [maintenance, cli, self-improvement, automation]
---

# /review-cc-updates — Claude Code CLI Update Review & Implementation

When the user invokes `/review-cc-updates [N]`, research the latest Claude Code CLI updates from the last N days (default: 2), identify improvements that benefit the agent, implement them, test, commit, and deploy.

## Step 1: Research Recent CLI Updates

Use multiple sources to find what changed in the last N days:

1. **WebSearch** for:
   - `"Claude Code" changelog site:docs.anthropic.com` (last N days)
   - `"Claude Code" new features OR update OR release` (last N days)
   - `anthropic claude code CLI changelog`

2. **Check the installed CLI**:
   ```bash
   claude --version 2>/dev/null
   claude --help 2>/dev/null | head -50
   ```

3. **Check npm for Claude Code packages**:
   ```bash
   npm view @anthropic-ai/claude-code versions --json 2>/dev/null | tail -10
   npm view @anthropic-ai/claude-agent-sdk versions --json 2>/dev/null | tail -10
   ```

4. **Check GitHub releases** (if available):
   ```bash
   gh api repos/anthropics/claude-code/releases --jq '.[0:5] | .[] | "\(.tag_name) \(.published_at) \(.name)"' 2>/dev/null
   ```

5. **Fetch official docs** for any new features discovered:
   - Use `context7` MCP to look up Claude Code documentation
   - Use `WebFetch` on any changelog URLs found

Compile a bullet list of all new features, flags, options, and behavioral changes found.

## Step 2: Analyze Agent Impact

Read the agent's core files to understand current CLI usage patterns:

| File | What to Check |
|---|---|
| `src/agent.ts` | CLI flags, spawn args, `--output-format`, `--input-format`, `--allowed-tools`, `--agents` |
| `src/persistent-process.ts` | Process management, stream-json handling, model switching |
| `src/dynamic-context.ts` | `--append-system-prompt` usage |
| `src/config.ts` | CLI-related config options |
| `src/index.ts` | Startup flags, env vars like `CLAUDE_CODE_EXPERIMENTAL_*` |
| `CLAUDE.md` | Documented CLI usage patterns |
| `workspace-CLAUDE.md` | Workspace-level agent instructions |

For each new feature found in Step 1, classify as:

- **adopt** — Direct benefit to the agent. Clear improvement in reliability, performance, or capability.
- **evaluate** — Potentially useful but needs testing or has trade-offs.
- **skip** — Not relevant to this agent's headless/Telegram use case.

## Step 3: Implement Beneficial Changes

For each **adopt** item:

1. Read the relevant source files fully before making changes
2. Implement the change
3. Explain what changed and why in a brief comment to the user

For each **evaluate** item:
- Describe the trade-off and ask the user before implementing (or implement behind a feature flag / env var)

For **skip** items:
- List them with a one-line reason why they don't apply

## Step 4: Test

1. **Build**: `npm run build` — must compile cleanly
2. **Unit tests**: `npm test` — all existing tests must pass
3. **If new behavior was added**: Write or update tests to cover it
4. **Regression check**: Ensure no existing functionality broke

If tests fail, fix the issue before proceeding. Do not skip failing tests.

## Step 5: Commit & Deploy

1. Run `/commit` skill (or follow its process: check secrets, check PII, update README if needed, commit, push)
2. Version bump: `npm version patch` for fixes, `npm version minor` for new features
3. Deploy: `DEPLOY_HOST="ubuntu@54.66.167.208" ./deploy.sh`
4. Verify deployment: check post-deploy health checks pass

## Step 6: Report

Output a summary:

### CLI Updates Found (last N days)
- Bullet list of changes discovered

### Changes Implemented
- What was adopted and why

### Changes Skipped
- What was not adopted and why

### Test Results
- Build status, test count, any new tests added

### Deploy Status
- Version deployed, health check results
