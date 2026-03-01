# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Test Commands

Requires Node.js >=22.0.0.

```bash
npm run build          # TypeScript compile (tsc) → dist/
npm run dev            # Run with tsx (no compile step)
npm start              # Run compiled dist/index.js
npm test               # vitest run (all tests)
npx vitest run src/telegram.test.ts  # Run a single test file
```

**Deploy (on the server itself):** `bash scripts/deploy-self.sh` — builds, prunes devDeps, installs systemd service, restarts.
**Deploy (remote):** `./deploy.sh` — SSH-based deploy using `DEPLOY_HOST` env var.

## Project Overview

Always-on AI agent powered by the Claude Code Agent SDK (`@anthropic-ai/claude-agent-sdk`) with Telegram as the primary interface. Deployed on AWS Lightsail behind Tailscale VPN, running as a systemd service.

## Architecture

**Entrypoint flow** (`src/index.ts`): loads config → creates Memory, Agent, Scheduler, TelegramIntegration → starts Telegram polling + Fastify HTTP gateway → registers graceful shutdown handlers.

**Key components:**
- `Agent` (`src/agent.ts`) — wraps SDK `query()` as an async generator. Builds a system prompt with memory context, orchestration instructions, and calendar tools. Supports session resumption (`options.resume`), per-call model override, and `AbortSignal` for cancellation.
- `TelegramIntegration` (`src/telegram.ts`) — polling-mode bot. Handles commands (`/new`, `/cancel`, `/retry`, `/model`, `/cost`, `/schedule`, `/tasks`, `/remember`, `/forget`, `/memories`, `/status`, `/post`), inline keyboard callbacks, photo/voice/document uploads, reply context, and per-user state (model override, cost tracking, abort controller, recent photos). Constructor takes optional `Scheduler` as 5th param.
- `Scheduler` (`src/scheduler.ts`) — cron-based task runner via `node-cron` with Australia/Melbourne timezone. Max 20 tasks, minimum 5-minute interval. Results delivered via callback (wired to Telegram notifications in index.ts).
- `Gateway` (`src/gateway.ts`) — Fastify HTTP API on localhost:8080. Routes: `GET /health`, `POST /webhook`, `GET /tasks`, `POST /tasks`, `DELETE /tasks/:id`.
- `Memory` (`src/memory.ts`) — JSON file store at `~/.claude-agent/memory/store.json`. Stores key-value facts and session records. `getLastSession(userId)` enables session persistence across restarts.
- `Config` (`src/config.ts`) — loads from env vars. Required: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USERS`. Optional: `PORT` (8080), `CLAUDE_MODEL` (claude-sonnet-4-6), `CLAUDE_MAX_TURNS` (25), `CLAUDE_MAX_BUDGET_USD` (5), `CLAUDE_WORK_DIR`, `MEMORY_DIR`.

## ESM Module System

This project uses `"type": "module"` — all imports must use `.js` extensions (e.g., `import { Agent } from "./agent.js"`), even for TypeScript source files. This is a Node16 module resolution requirement.

## SDK Usage Patterns

- `bypassPermissions` + `allowDangerouslySkipPermissions: true` is required for headless/systemd environments. Other permission modes prompt for TTY input and fail.
- `query()` returns an async generator. Stream messages looking for `type === "result"` for the final output and `type === "system"` with `subtype === "init"` for session ID.
- Session resumption: pass `options.resume = sessionId` to continue a previous conversation.
- `allowedTools` controls which tools are available but does NOT replace permission prompts in non-bypass modes.

## Testing

Tests use vitest with ESM module mocking. Key patterns in `src/telegram.test.ts`:
- `vi.mock("node-telegram-bot-api")` with a shared `mockBotInstance` variable (ESM doesn't support `mock.instances`)
- Fire-and-forget handlers need `flush()` helper: `const flush = () => new Promise(r => setTimeout(r, 10))`
- Mock Memory must include `getLastSession: vi.fn().mockReturnValue(undefined)` or session persistence code will fail
- Test files are excluded from `tsconfig.json` (`"src/**/*.test.ts"` in exclude) to keep them out of `dist/`

## Systemd Hardening

```ini
PrivateTmp=true
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/home/ubuntu/workspace /home/ubuntu/.claude-agent /home/ubuntu/agent /home/ubuntu/.claude /home/ubuntu/.config
```

**Critical:** `ProtectHome=read-only` blocks all home directory writes. The Claude Code CLI writes to `~/.claude/` — it **must** be in `ReadWritePaths` or the SDK subprocess exits with code 1. All paths in `ReadWritePaths` must exist before service start (exit code 226/NAMESPACE otherwise).

## Common Issues

- **SDK exit code 1** — filesystem permission issue from systemd sandboxing. Check `ReadWritePaths`.
- **Exit code 226/NAMESPACE** — a directory in `ReadWritePaths` doesn't exist. Create it first.
- **Telegram redelivers on restart** — polling mode picks up unacked messages. Benign; may hit stale session errors.
- **Stale dist/ test files** — vitest may pick up `dist/telegram.test.js`. Delete it or rebuild.
- **`cron-parser` v5 API** — uses `CronExpressionParser.parse()` (not the old `parseExpression()`).

## Capability Routing

The agent's system prompt includes a decision framework for adding new integrations. When the agent needs a new capability, it evaluates options in priority order:

1. **Zapier MCP** — Pre-configured via `.mcp.json`. Provides 24 tools across Google Calendar, Gmail, Google Contacts, and Trello. Primary integration for Google services.
2. **MCP server** — SDK-native tool provider. Config in `.mcp.json` (auto-loaded from cwd). Best option when one exists.
3. **Community skill** — Pre-built `.claude/skills/` package. Must support headless auth (no OAuth browser flows).
4. **Custom skill** — Hand-built in `.claude/skills/<name>/` with `SKILL.md`. Use existing facebook/twilio skills as templates.
5. **One-off Bash** — For simple, non-recurring tasks.

Key constraint: the agent runs headless under systemd, so only API keys / app passwords / service accounts work for auth. `allowedTools` includes `mcp__*` to permit any configured MCP server tools.

## Adding Telegram Slash Commands

When adding a new slash command, update ALL of these locations:

1. **`handleCommand()` switch statement** in `src/telegram.ts` — the actual handler
2. **`/start` case help text** — welcome message listing commands
3. **`default` case command list** — fallback "unknown command" response
4. **`src/agent.ts` system prompt** — "Telegram Commands" section so the agent knows about it
5. **Telegram Bot API `setMyCommands`** — update via API call so commands appear in Telegram's autocomplete:
   ```bash
   TOKEN=$(grep TELEGRAM_BOT_TOKEN .env | cut -d= -f2)
   curl -s "https://api.telegram.org/bot${TOKEN}/setMyCommands" \
     -H "Content-Type: application/json" \
     -d '{"commands": [{"command": "name", "description": "Description"}, ...]}'
   ```
6. **This file (`CLAUDE.md`)** — update the command list in the TelegramIntegration description above

## Secret Management

Secrets are stored in Bitwarden and synced to the server at deploy time. The `bw` CLI runs **locally only** — the master password never touches the server.

**Vault folder:** `claude-agent-lightsail`

| Vault Item | Server Destination |
|---|---|
| `env-secrets` | `/home/ubuntu/agent/.env` (merged with config vars) |
| `gmail` | `/home/ubuntu/agent/gmail_app_password.json` |
| `facebook` | `/home/ubuntu/.claude-agent/facebook-page-token.json` |
| `google-service-account` | `/home/ubuntu/.claude-agent/google-service-account.json` |
| `google-credentials` | `/home/ubuntu/.claude-agent/google-credentials.json` |
| `google-contacts-token` | `/home/ubuntu/.claude-agent/google-contacts-token.json` |
| `env-secrets` (ZAPIER_API_KEY) | `/home/ubuntu/agent/.env` (via EnvironmentFile) |

**Workflows:**
- **Sync secrets:** `bash scripts/sync-secrets.sh` (or `./deploy.sh --sync-secrets`)
- **Add/rotate a secret:** Update in Bitwarden vault → run sync
- **Rollback:** `bash scripts/rollback-secrets.sh <backup-dir>` (backups created by migration script in `~/.claude-agent-backup-*`)
- **New instance:** Install `bw` CLI locally, run `sync-secrets.sh` after placing config-only `.env` on server

General config (PORT, CLAUDE_MODEL, etc.) stays in `.env` on the server and is not managed by Bitwarden. See `.env.example` for the split.

## Versioning

This project uses [semver](https://semver.org/) with `npm version` and GitHub Releases.

**When committing changes, bump the version:**
- `npm version patch` — bug fixes, minor tweaks (0.1.0 → 0.1.1)
- `npm version minor` — new features, integrations (0.1.0 → 0.2.0)
- `npm version major` — breaking changes (0.1.0 → 1.0.0)

**After bumping, push the tag and create a release:**
```bash
git push --follow-tags
gh release create v<VERSION> --title "v<VERSION>" --generate-notes
```

The `--generate-notes` flag auto-generates release notes from commit messages since the last tag.

**Important:** Always bump the version as part of the commit workflow. Do not create commits without considering whether a version bump is needed.

## Security Model

- Gateway is localhost-only (Tailscale provides network access control)
- Telegram auth is fail-closed: empty `allowedUsers` = crash at startup
- Error messages to users are generic; details logged server-side only
- Scheduler limits: max 20 tasks, minimum 5-minute interval
- Gateway body limit: 10KB
