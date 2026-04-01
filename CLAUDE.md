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

**Deploy (remote):** `./deploy.sh` — SSH-based deploy using `DEPLOY_HOST` env var. Pulls agent-created files from instance before pushing. Use `--dry-run` to preview.
**Deploy (on server):** `bash scripts/deploy-self.sh`

**Before committing:** Check for hardcoded secrets in the diff. Credentials must come from env vars or external files only. Update `README.md` for user-facing changes.

## Project Overview

Axis Agent — always-on AI agent powered by the **Claude Code CLI** (`claude`) with Telegram as the primary interface. Deployed on AWS Lightsail behind Tailscale VPN, running as a systemd service.

## Architecture

**Entrypoint** (`src/index.ts`): config → preflight checks → Agent, Scheduler, TelegramIntegration → Telegram polling + Fastify gateway → shutdown handlers.

**Core:**
- `Agent` (`src/agent.ts`) — manages claude CLI interactions. Persistent processes for Telegram users (via `ProcessManager`), one-shot spawns for jobs/webhooks. Injects dynamic context via `--append-system-prompt`. Configures sub-agents via `--agents` and enables agent teams via env var. Auth: Max subscription OAuth.
- `PersistentProcess` / `ProcessManager` (`src/persistent-process.ts`) — long-lived `claude` process per user via `--input-format stream-json`. Handles idle reaping, model switches, crash recovery, and self-review.
- `DynamicContextBuilder` (`src/dynamic-context.ts`) — builds `--append-system-prompt` payload: datetime, scheduled tasks, security policies.
- `Policies` (`src/policies.ts`) — blocked-command regex patterns for destructive commands.

**Telegram:**
- `TelegramIntegration` (`src/telegram.ts`) — polling-mode bot. Commands: `/new`, `/cancel`, `/retry`, `/model`, `/cost`, `/schedule`, `/tasks`, `/status`, `/post`, `/call`. Delegates to `TelegramMediaService`, `TelegramProgressReporter`, `TELEGRAM_COMMANDS`.

**Infrastructure:**
- `Scheduler` (`src/scheduler.ts`) — cron tasks via `node-cron` (Melbourne TZ). Max 20 tasks, min 5-min interval. SQLite-persisted. Monitor-style tasks via `checkCommand`.
- `Gateway` (`src/gateway.ts`) — Fastify on :8080. Auth via `GATEWAY_API_TOKEN`. Rate-limited. Endpoints: `/health`, `/webhook`, `/tasks`, `/calls`, `/admin/*`, `/twilio/inbound-sms`, `/owntracks`.
- `JobService` (`src/jobs.ts`) — async job queue with retries, backed by `SqliteStore`.
- `SqliteStore` (`src/persistence.ts`) — SQLite via `node:sqlite` (Node 22+ built-in). Sessions, tasks, jobs, events.
- `Auth` (`src/auth.ts`) — OAuth token refresh for `~/.claude/.credentials.json`.

**Reliability:**
- `Checkpoint` (`src/checkpoint.ts`) — conversation state snapshots for crash recovery.
- `CircuitBreaker` (`src/circuit-breaker.ts`) — closed/open/half-open circuit for failing external calls.
- `Heartbeat` (`src/heartbeat.ts`) — periodic liveness signals, writes to filesystem.
- `Watchdog` (`src/watchdog.ts`) — monitors health checks, triggers alerts on failure.
- `Logger` (`src/logger.ts`) — structured logging with component prefixes.
- `Preflight` (`src/preflight.ts`) — startup validation (CLI exists, credentials valid, paths writable).

**Integrations:**
- `TrelloMcpServer` (`src/trello-mcp-server.ts`) — MCP server for Trello API. Configured in `.mcp.json`.
- `VoiceService` (`src/voice.ts`) — outbound calls via Retell.ai SDK.
- `TeamCoordinator` (`src/team-coordinator.ts`) — parallel fan-out/fan-in for specialized agents (research, reasoning, explore).
- `MetricsRegistry` (`src/metrics.ts`) — in-memory counters and gauges.
- `GwsAuth` (`src/gws-auth.ts`) — Google Workspace OAuth token management and health checks.
- `PromptConfig` (`src/prompt-config.ts`) — structured prompt section builder for system prompts.
- `Identity` (`src/identity.ts`) — persistent agent identity file management.

**Config** (`src/config.ts`): Required: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USERS`. See `.env.example` for all options.

## ESM Module System

Uses `"type": "module"` — all imports must use `.js` extensions (e.g., `import { Agent } from "./agent.js"`).

## CLI Usage Patterns

- **Persistent multi-turn** (primary): `claude -p --input-format stream-json --output-format stream-json --verbose --dangerously-skip-permissions` — JSON lines to stdin, stream-json events on stdout.
- **One-shot** (fallback for jobs): `claude -p --output-format stream-json --verbose --dangerously-skip-permissions`
- `--append-system-prompt` — dynamic context on top of built-in system prompt.
- `--resume <sessionId>` — resumes previous conversation.
- `--dangerously-skip-permissions` — required for headless/systemd.
- `--allowed-tools` — limits available tools.
- `--agents` — configures sub-agents (research, reasoning) the main agent can delegate to.
- `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` — enables native agent teams for parallel collaboration.
- Auto-discovers: `SOUL.md`, `CLAUDE.md`, `.mcp.json`, `.claude/skills/` from `workDir`.

## Testing

Vitest with ESM module mocking. Key patterns:
- `vi.mock("node-telegram-bot-api")` with shared `mockBotInstance` variable (ESM doesn't support `mock.instances`)
- Fire-and-forget handlers need `flush()`: `const flush = () => new Promise(r => setTimeout(r, 10))`
- Mock store needs `recordSession: vi.fn()` and `getLastSession: vi.fn().mockReturnValue(undefined)`
- Test files excluded from `tsconfig.json` to keep them out of `dist/`

## Systemd Hardening

```ini
PrivateTmp=true
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/home/ubuntu/workspace /home/ubuntu/.claude-agent /home/ubuntu/agent /home/ubuntu/.claude /home/ubuntu/.config /home/ubuntu/.cache
PrivateDevices=false  # Chromium needs /dev/shm
```

**Critical:** `~/.claude/` must be in `ReadWritePaths` or CLI exits with code 1. All paths must exist before service start (exit code 226/NAMESPACE otherwise).

## Common Issues

- **CLI exit code 1** — filesystem permission issue from systemd sandboxing. Check `ReadWritePaths`.
- **Exit code 226/NAMESPACE** — directory in `ReadWritePaths` doesn't exist.
- **Stale dist/ test files** — vitest picks up `dist/*.test.js`. Delete or rebuild.
- **`cron-parser` v5 API** — uses `CronExpressionParser.parse()` (not old `parseExpression()`).
- **Chromium `/dev/shm`** — `PrivateDevices=false` required in systemd unit.
- **Retell call fails** — check `RETELL_API_KEY`, `RETELL_PHONE_NUMBER`, `RETELL_AGENT_ID` env vars.

## MCP Servers

Configured in `.mcp.json` (auto-loaded from cwd):
- **Composio** — third-party integrations (not for Google — use `gws` CLI instead). Requires `COMPOSIO_API_KEY`.
- **Trello** (`dist/trello-mcp-server.js`) — board/card/checklist management. Requires `TRELLO_API_KEY`, `TRELLO_API_TOKEN`.
- **Playwright** (`@playwright/mcp`) — headless Chromium browser automation.
- **Context7** (`@upstash/context7-mcp`) — library documentation lookup.
- **Gemini** (`@fre4x/gemini`) — multimodal analysis, image generation (Imagen), video generation (Veo). Requires `GEMINI_API_KEY`.

## Google Operations

**Prefer MCP tools** (`mcp__claude_ai_Google_Calendar__*`, `mcp__claude_ai_Gmail__*`) for Calendar and Gmail — they support parallel queries, return structured JSON, and provide richer API access.

**Fall back to `gws` CLI** for services without MCP support (Contacts, Drive, Sheets, Docs, Slides, Tasks, Chat, Forms, Keep, Meet) or quick one-off lookups.

**Never use Composio** for Google operations.

### `gws` CLI

The `@googleworkspace/cli` package provides unified CLI for ALL Google APIs.

**Auth:** OAuth at `~/.config/gws/credentials.json`. Do NOT set `GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE`. Append `2>/dev/null` to suppress harmless stderr warnings.

```bash
gws <service> <resource> <method> [--params '{"key":"value"}'] [--json '{"body":"..."}'] 2>/dev/null
gws people people searchContacts --params '{"query": "<name>", "readMask": "names,emailAddresses,phoneNumbers"}' 2>/dev/null
gws calendar +agenda 2>/dev/null
gws gmail +triage 2>/dev/null
```

Services: people, calendar, gmail, drive, sheets, docs, slides, tasks, chat, forms, keep, meet. Run `gws <service> --help` for helper commands.

## Adding Telegram Slash Commands

Update ALL locations:
1. `handleCommand()` switch in `src/telegram.ts`
2. `/start` case help text
3. `default` case command list
4. `workspace-CLAUDE.md` Telegram Commands section
5. Telegram Bot API `setMyCommands` via curl
6. This file's TelegramIntegration description

## Secret Management

Secrets stored in Bitwarden (`claude-agent-lightsail` folder), synced via `bash scripts/sync-secrets.sh`. See `.env.example` for the config/secrets split.

**Workflows:** `sync-secrets.sh` (sync), `deploy.sh --sync-secrets` (sync + deploy), `rollback-secrets.sh <backup-dir>` (rollback).

**Codespaces:** `post-create.sh` runs automatically. Then `bash .devcontainer/setup-secrets.sh` for Bitwarden injection. Tailscale needs userspace networking (`--tun=userspace-networking`).

## Versioning

Semver with `npm version` and GitHub Releases. Always bump version when committing:
- `npm version patch` — bug fixes
- `npm version minor` — new features
- `npm version major` — breaking changes

Then: `git push --follow-tags && gh release create v<VERSION> --title "v<VERSION>" --generate-notes`

## Learnings

Non-obvious discoveries recorded in `LEARNINGS.md`. **Auto-retain rule:** after any debugging session with a surprising root cause, append an entry before completing.

## Security Model

- Gateway on `0.0.0.0` — Tailscale VPN + cloud firewall for access control
- `GATEWAY_API_TOKEN` enables bearer auth (optional, backward-compatible)
- `@fastify/helmet` security headers, `@fastify/rate-limit` (60/min global, 5/min webhook, 3/min calls)
- Telegram auth fail-closed: empty `allowedUsers` = crash at startup
- Gateway body limit: 10KB
