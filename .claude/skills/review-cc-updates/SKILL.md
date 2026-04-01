---
name: review-cc-updates
description: Audit all current Claude Code CLI features against agent usage, implement improvements, test, commit, and deploy
user_invocable: true
tags: [maintenance, cli, self-improvement, automation]
---

# /review-cc-updates — Claude Code CLI Feature Audit & Self-Improvement

Perform a comprehensive audit of ALL current Claude Code CLI features, flags, env vars, and capabilities. Compare against how this agent uses the CLI. Adopt anything that improves reliability, performance, security, or capability. Implement, test, commit, and deploy autonomously.

## Step 1: Discover All CLI Capabilities

Build a comprehensive inventory of every CLI feature available:

1. **Full CLI help**:
   ```bash
   claude --version
   claude --help 2>/dev/null
   ```

2. **Official documentation** — fetch the full docs:
   - WebFetch `https://code.claude.com/docs/en/reference/cli-commands` — all CLI flags and options
   - WebFetch `https://code.claude.com/docs/en/reference/env-variables` — all environment variables
   - WebFetch `https://code.claude.com/docs/en/reference/hooks` — hook events and configuration
   - WebFetch `https://code.claude.com/docs/en/reference/settings` — all settings
   - WebFetch `https://code.claude.com/docs/en/changelog` — recent changelog for context

3. **SDK capabilities** (for programmatic usage):
   ```bash
   npm view @anthropic-ai/claude-agent-sdk version 2>/dev/null
   find node_modules/@anthropic-ai/claude-agent-sdk -name '*.d.ts' -type f 2>/dev/null | head -5
   ```
   Read the main type definition file to understand the SDK API surface.

4. **Check for CLI updates**:
   ```bash
   npm view @anthropic-ai/claude-code version 2>/dev/null
   ```
   If the server CLI is behind, upgrade it: `sudo npm install -g @anthropic-ai/claude-code@latest`

Compile a structured inventory:
- **CLI flags**: every `--flag` with description
- **Environment variables**: every `CLAUDE_*` and `ANTHROPIC_*` var
- **Settings**: every configurable setting
- **Hook events**: every hook event type
- **Tools**: built-in tool list and configuration options
- **MCP**: configuration and management options

## Step 2: Audit Agent Usage

Read the agent's core files to understand current CLI usage:

| File | What to Check |
|---|---|
| `src/agent.ts` | CLI spawn args, env vars, `--allowed-tools`, `--agents`, one-shot mode |
| `src/persistent-process.ts` | Persistent process spawn args, env vars, stream-json handling |
| `src/dynamic-context.ts` | `--append-system-prompt` content |
| `src/config.ts` | CLI-related config options, env var mapping |
| `src/index.ts` | Startup sequence, env vars, feature flags |
| `src/auth.ts` | OAuth token handling |
| `src/policies.ts` | Command blocking patterns |
| `CLAUDE.md` | Documented CLI patterns |
| `workspace-CLAUDE.md` | Workspace-level instructions |
| `.mcp.json` | MCP server configuration |

For every CLI feature from Step 1, classify as:

- **adopt** — Clear improvement to reliability, performance, security, or capability. Low risk.
- **evaluate** — Potentially useful but has trade-offs. Needs testing or user input.
- **already-used** — Agent already uses this feature.
- **not-applicable** — Not relevant to headless/Telegram/systemd use case (e.g., voice, UI, interactive-only features).

Focus on:
- Security hardening env vars and flags
- Performance optimization options
- Reliability and error handling improvements
- New tools or capabilities that expand what the agent can do
- Better subprocess/process management options
- Improved MCP server management

## Step 3: Implement Improvements

For each **adopt** item:
1. Read the relevant source files fully before making changes
2. Implement the change
3. Log what changed and why

For each **evaluate** item:
- If running autonomously (scheduled task): implement behind an env var flag, default off
- If running interactively: describe the trade-off and ask the user

**Do not change behavior that is working well.** Only adopt features that are strictly additive or replace inferior patterns.

## Step 4: Test

1. **Build**: `npm run build` — must compile cleanly
2. **Unit tests**: `npm test` — all existing tests must pass
3. **If new behavior was added**: Write or update tests to cover it
4. **Regression**: Verify no existing functionality broke

If tests fail, fix the issue. Do not skip failing tests. If a change causes test failures that can't be resolved, revert it.

## Step 5: Commit & Deploy

Only proceed if changes were made in Step 3. If no improvements were found, skip to Step 6.

1. Check for secrets/PII in the diff
2. Version bump: `npm version patch` for fixes, `npm version minor` for new features
3. Commit with a descriptive message
4. Push to remote
5. Deploy: `DEPLOY_HOST="ubuntu@54.66.167.208" ./deploy.sh`
6. Verify all post-deploy health checks pass

## Step 6: Report

Send a summary via the response (Telegram if scheduled):

### CLI Version
- Installed version, latest available, whether an upgrade was performed

### Features Adopted
- What was implemented and why (bullet list)

### Features Evaluated
- Trade-offs noted, whether implemented behind flags

### Already In Use
- Confirmation of features the agent already leverages

### Not Applicable
- Brief list with one-line reasons

### Test & Deploy Results
- Build status, test count, deploy health check results
- "No changes needed" if nothing was adopted
