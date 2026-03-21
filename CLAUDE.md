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
**Deploy (remote):** `./deploy.sh` — SSH-based deploy using `DEPLOY_HOST` env var. Automatically pulls agent-created files from the instance before pushing (additive only, won't overwrite local edits). Use `./deploy.sh --dry-run` to preview what rsync would sync/delete without making changes.

**Before committing:** Always check for hardcoded secrets, credentials, API keys, tokens, or PII in the diff. Never commit code that contains embedded secrets — credentials must come from env vars or external files only. Always update `README.md` to reflect any user-facing changes (new features, commands, integrations, config changes).

## Project Overview

Axis Agent — always-on AI agent powered by the **Claude Code CLI** (`claude`) with Telegram as the primary interface. Deployed on AWS Lightsail behind Tailscale VPN, running as a systemd service.

## Architecture

**Entrypoint flow** (`src/index.ts`): loads config → runs preflight health checks → creates Agent, Scheduler, TelegramIntegration → starts Telegram polling + Fastify HTTP gateway (with inbound SMS handler) → registers graceful shutdown handlers.

**Key components:**
- `Agent` (`src/agent.ts`) — spawns the `claude` CLI as a subprocess with `--output-format stream-json --verbose --dangerously-skip-permissions --append-system-prompt`. Injects dynamic context (scheduled tasks, security policies, current datetime) via `--append-system-prompt`. Claude Code auto-discovers `SOUL.md`, `CLAUDE.md`, `.mcp.json`, and skills from `workDir`. Uses `--resume <sessionId>` for session continuity (full history preserved). Returns `Promise<AgentResult>`. Auth: Max subscription OAuth (no `ANTHROPIC_API_KEY` needed).
- `DynamicContextBuilder` (`src/dynamic-context.ts`) — builds the `--append-system-prompt` payload: current datetime (Melbourne timezone), scheduled tasks list, security policies. No memory injection — Claude Code handles that natively via auto-memory.
- `Policies` (`src/policies.ts`) — declarative blocked-command policy system. Defines regex patterns for destructive commands (`rm -rf /`, `shutdown`, `mkfs`, `curl | bash`, etc.). Provides `checkBlockedCommand()` for hard enforcement and `buildPolicyPromptSection()` for soft enforcement via system prompt injection.
- `Preflight` (`src/preflight.ts`) — startup health checks. Validates work/memory directory permissions, OAuth credentials, `~/.claude` writability, Telegram bot token format, and Telegram API reachability. Logs clear pass/fail diagnostics. Non-fatal — agent starts with warnings on failure.
- `TelegramIntegration` (`src/telegram.ts`) — polling-mode bot. Handles commands (`/new`, `/cancel`, `/retry`, `/model`, `/cost`, `/schedule`, `/tasks`, `/status`, `/post`, `/call`), inline keyboard callbacks, photo/voice/document uploads, reply context, and per-user state (model override, cost tracking, abort controller, recent photos). Constructor signature: `(botToken, allowedUsers, agent, store, workDir, scheduler?, voiceService?)`. Delegates to extracted modules:
  - `TelegramMediaService` (`src/telegram-media.ts`) — file download, photo handling
  - `TelegramProgressReporter` (`src/telegram-progress.ts`) — delayed ack messages + periodic status updates
  - `TELEGRAM_COMMANDS` (`src/telegram-commands.ts`) — command registry with names/descriptions
- `Scheduler` (`src/scheduler.ts`) — cron-based task runner via `node-cron` with Australia/Melbourne timezone. Max 20 tasks, minimum 5-minute interval. Persists tasks to SQLite and restores on startup. Supports monitor-style tasks via optional `checkCommand` field — the command runs first via `execFile` (no shell interpretation), and the agent only runs if it produces non-empty output. Check commands are validated for shell metacharacters on add — pipes, semicolons, backticks, subshells, and redirects are rejected. `runNow(id)` triggers any task on demand (bypasses cron schedule). Results delivered via callback (wired to Telegram notifications in index.ts).
- `Gateway` (`src/gateway.ts`) — Fastify HTTP API on localhost:8080. Uses `@fastify/helmet` for security headers and `@fastify/rate-limit` for rate limiting (60 req/min global, 5/min on `/webhook`, 3/min on `/calls`). Protected routes require `Authorization: Bearer <GATEWAY_API_TOKEN>` when the token is configured (backward-compatible: no auth enforced if unset). Token comparison uses `crypto.timingSafeEqual` to prevent timing attacks. Public: `GET /health`. Protected: `POST /webhook`, `GET /tasks`, `POST /tasks`, `DELETE /tasks/:id`, `POST /tasks/:id/run` (trigger on demand), `GET/POST /calls`, `GET /admin/*`, `POST /twilio/inbound-sms`. Self-authenticated: `POST /owntracks` (own Bearer/Basic auth via `OWNTRACKS_TOKEN`). OwnTracks writes `current-location.json` to `workDir`.
- `JobService` (`src/jobs.ts`) — async job queue for webhook/scheduler prompts. Enqueues prompt jobs, runs them via the Agent, supports retries (`maxAttempts`). Backed by `SqliteStore`.
- `SqliteStore` (`src/persistence.ts`) — SQLite-backed persistence using `node:sqlite` (`DatabaseSync`). Stores sessions (cost tracking), scheduled tasks, job records, and events. No facts/memory table — Claude Code handles memory natively via auto-memory. Node.js 22+ built-in — no external SQLite dependency needed.
- `MetricsRegistry` (`src/metrics.ts`) — in-memory counters and gauges for operational metrics.
- `Auth` (`src/auth.ts`) — OAuth token refresh for Claude credentials (`~/.claude/.credentials.json`). Proactively refreshes tokens 10 minutes before expiry.
- `TrelloMcpServer` (`src/trello-mcp-server.ts`) — custom MCP server exposing Trello REST API as tools (list boards, create/update/archive cards, manage checklists, comments). Runs as stdio MCP server configured in `.mcp.json`. Requires `TRELLO_API_KEY` and `TRELLO_API_TOKEN` env vars.
- `VoiceService` (`src/voice.ts`) — manages outbound voice calls via Retell.ai SDK (`retell-sdk`). Uses a base Retell agent with per-call overrides via `agent_override` and `retell_llm_dynamic_variables` to inject dynamic system prompts. LLM: Claude 4.6 Sonnet. Uses `start_speaker: "user"` so the AI waits for the human to speak first. Supports `recipientName` for personalized greetings and `OWNER_NAME` env var for "calling on behalf of" context. `contextToQuestion()` transforms instruction-style context ("Ask what they're having") into natural spoken questions. Built-in `end_call` tool for hanging up. Polls call status via `client.call.retrieve()` until ended, reads structured transcript from `transcript_object`. Callback delivers results (with transcript) to Telegram.
- `TaskMonitor` (`src/task-monitor.ts`) — tracks active agent tasks with elapsed time, status, and long-running detection (5-min threshold). Per-user task listing for `/task-status` command.
- `TeamCoordinator` (`src/team-coordinator.ts`) — orchestrates parallel execution of specialized agents (research, reasoning, explore) using fan-out/fan-in pattern. Generates team plans with budget allocation, synthesizes results. Model routing: Opus for reasoning, Sonnet for research/explore.
- `Logger` (`src/logger.ts`) — minimal structured logger writing to stdout/stderr with `[axis-agent] [component]` prefix. Used by all components via `info()` and `error()` functions.
- `Config` (`src/config.ts`) — loads from env vars. Required: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USERS`. Optional: `PORT` (8080), `CLAUDE_MODEL` (claude-opus-4-6), `CLAUDE_MAX_TURNS` (25), `CLAUDE_MAX_BUDGET_USD` (5), `CLAUDE_AGENT_TIMEOUT_MS` (600000 / 10 min), `CLAUDE_WORK_DIR`, `MEMORY_DIR`, `OWNTRACKS_TOKEN`, `GATEWAY_API_TOKEN`, `RETELL_API_KEY`, `RETELL_PHONE_NUMBER`, `RETELL_AGENT_ID`, `RETELL_VOICE_ID`, `OWNER_NAME`. Auth: uses Max subscription OAuth credentials from `~/.claude/.credentials.json` (auto-refreshed by `Auth` module). No `ANTHROPIC_API_KEY` needed.

## ESM Module System

This project uses `"type": "module"` — all imports must use `.js` extensions (e.g., `import { Agent } from "./agent.js"`), even for TypeScript source files. This is a Node16 module resolution requirement.

## CLI Usage Patterns

- `claude -p --output-format stream-json --verbose --dangerously-skip-permissions` — headless invocation. `stream-json` emits newline-delimited JSON events; parse `type === "result"` for final output and `type === "system" && subtype === "init"` for session ID.
- `--append-system-prompt` — appends dynamic context on top of Claude Code's built-in system prompt (keeps SOUL.md/CLAUDE.md personality intact).
- `--resume <sessionId>` — resumes a previous conversation. Full history preserved; no custom summary injection needed.
- `--dangerously-skip-permissions` — required for headless/systemd environments. Without it, Claude Code prompts for TTY input and fails.
- `--allowed-tools` — limits which tools are available to the agent.
- `--agents` — configures sub-agents the main agent can delegate to.
- Claude Code auto-discovers: `SOUL.md` (personality), `CLAUDE.md` (instructions), `.mcp.json` (MCP servers), `.claude/skills/` (skills) from `workDir`.
- Auto-memory: Claude Code manages memory natively. No custom facts storage needed.

## Testing

Tests use vitest with ESM module mocking. Test files: `telegram.test.ts`, `agent.test.ts`, `scheduler.test.ts`, `dynamic-context.test.ts`, `jobs.test.ts`, `gateway.test.ts`, `voice.test.ts`, `team-coordinator.test.ts`. Key patterns:
- `vi.mock("node-telegram-bot-api")` with a shared `mockBotInstance` variable (ESM doesn't support `mock.instances`)
- Fire-and-forget handlers need `flush()` helper: `const flush = () => new Promise(r => setTimeout(r, 10))`
- Mock store must include `recordSession: vi.fn()` and `getLastSession: vi.fn().mockReturnValue(undefined)`
- Test files are excluded from `tsconfig.json` (`"src/**/*.test.ts"` in exclude) to keep them out of `dist/`

## Systemd Hardening

```ini
PrivateTmp=true
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/home/ubuntu/workspace /home/ubuntu/.claude-agent /home/ubuntu/agent /home/ubuntu/.claude /home/ubuntu/.config /home/ubuntu/.cache
PrivateDevices=false  # Chromium needs /dev/shm
```

**Critical:** `ProtectHome=read-only` blocks all home directory writes. The Claude Code CLI writes to `~/.claude/` — it **must** be in `ReadWritePaths` or the SDK subprocess exits with code 1. All paths in `ReadWritePaths` must exist before service start (exit code 226/NAMESPACE otherwise).

## Common Issues

- **CLI exit code 1** — filesystem permission issue from systemd sandboxing. Check `ReadWritePaths`. `~/.claude/` must be writable.
- **Exit code 226/NAMESPACE** — a directory in `ReadWritePaths` doesn't exist. Create it first.
- **Telegram redelivers on restart** — polling mode picks up unacked messages. Benign; may hit stale session errors.
- **Stale dist/ test files** — vitest may pick up `dist/telegram.test.js`. Delete it or rebuild.
- **`cron-parser` v5 API** — uses `CronExpressionParser.parse()` (not the old `parseExpression()`).
- **Chromium `/dev/shm`** — `PrivateDevices=false` is required in the systemd unit. Without it, Chromium crashes because it can't access shared memory.
- **Retell call fails** — check `RETELL_API_KEY`, `RETELL_PHONE_NUMBER`, and `RETELL_AGENT_ID` env vars. The phone number must be purchased from or imported into Retell.
- **SSH to instance from Codespace fails** — Tailscale in containers needs userspace networking (`--tun=userspace-networking`). Direct TCP doesn't work; use `tailscale nc` as SSH `ProxyCommand`. The SSH config is auto-generated by `post-create.sh`.
- **`check-imports.sh` false positives** — The import checker skips `node:` prefixed builtins but also handles bare Node.js built-in module names (path, url, fs, etc.).

## Capability Routing

The agent's system prompt includes a decision framework for adding new integrations. When the agent needs a new capability, it evaluates options in priority order:

1. **Google Workspace CLI (`gws`)** — Primary tool for ALL Google services (Gmail, Calendar, Contacts, Drive, Sheets, Docs). Uses OAuth token at `~/.config/gws/credentials.json`. Do NOT use Composio for Google operations.
2. **MCP server** — SDK-native tool provider. Config in `.mcp.json` (auto-loaded from cwd). Composio MCP (`mcp__composio__*`) is available for non-Google third-party integrations.
3. **Community skill** — Pre-built `.claude/skills/` package. Must support headless auth (no OAuth browser flows).
4. **Custom skill** — Hand-built in `.claude/skills/<name>/` with `SKILL.md`. Use existing facebook/twilio skills as templates. The `skill-generator` meta-skill (`.claude/skills/skill-generator/SKILL.md`) provides a structured template and validation checklist for creating new skills. Past learnings are logged in `LEARNINGS.md`.
5. **One-off Bash** — For simple, non-recurring tasks.

Key constraint: the agent runs headless under systemd, so only API keys / app passwords / service accounts work for auth. `allowedTools` includes `mcp__*` to permit any configured MCP server tools.

## MCP Servers

Configured in `.mcp.json` (auto-loaded by the SDK from cwd):

- **Composio** (URL-based, `backend.composio.dev/mcp`) — unified tool router for non-Google third-party integrations (1000+ services). Google services should use `gws` CLI instead. Uses HTTP transport with `x-api-key` header. Requires `COMPOSIO_API_KEY`.
- **Trello** (`src/trello-mcp-server.ts`) — custom native MCP server for Trello board/card/checklist management. Runs from `dist/trello-mcp-server.js` (must `npm run build` first). Requires `TRELLO_API_KEY`, `TRELLO_API_TOKEN`. Uses `zod` for input validation (available via `@modelcontextprotocol/sdk`, not a direct dependency).
- **Playwright** (`@playwright/mcp`) — headless Chromium browser automation (screenshots, form filling, navigation). Viewport: 1280x720. `PrivateDevices=false` required in systemd unit for `/dev/shm` access.
- **Context7** (`@upstash/context7-mcp`) — library documentation lookup. Resolves library names to Context7-compatible IDs and fetches up-to-date docs/examples on demand.

## Google Workspace CLI (`gws`)

The `@googleworkspace/cli` package is installed globally, providing a unified CLI for ALL Google Workspace APIs. This is the **only tool** for Google operations — do NOT use Composio, googleapis scripts, or skill scripts for Google services.

**Auth:** OAuth credentials at `~/.config/gws/credentials.json` (plaintext, auto-refreshes). Do NOT set `GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE` — it overrides the working OAuth token with a service account that can't access consumer Gmail contacts. Current scopes: `contacts.readonly`, `gmail.modify`, `calendar`.

**Important:** Always append `2>/dev/null` to gws commands — it emits harmless token cache warnings on stderr that are not errors. The JSON on stdout is always valid.

**Usage pattern:**
```bash
gws <service> <resource> <method> [--params '{"key":"value"}'] [--json '{"body":"..."}'] 2>/dev/null
```

**Contact lookup:**
```bash
gws people people searchContacts --params '{"query": "<name>", "readMask": "names,emailAddresses,phoneNumbers"}' 2>/dev/null
```

**Calendar:**
```bash
gws calendar +agenda 2>/dev/null                    # today's events
gws calendar events list --params '{"calendarId": "primary", "timeMin": "2026-03-17T00:00:00Z", "maxResults": 10, "singleEvents": true, "orderBy": "startTime"}' 2>/dev/null
```

**Gmail:**
```bash
gws gmail +triage 2>/dev/null                       # inbox summary
gws gmail +send --params '{"userId": "me"}' --json '{"to": "user@example.com", "subject": "Hello", "body": "Message"}' 2>/dev/null
```

**Drive / Sheets / Docs:**
```bash
gws drive files list --params '{"pageSize": 10}' 2>/dev/null
gws sheets +read --params '{"spreadsheetId": "ID", "range": "Sheet1!A1:C10"}' 2>/dev/null
gws schema drive.files.list                          # inspect any method's schema
```

**Flags:** `--dry-run` (preview), `--page-all` (auto-paginate), `--page-limit N`, `--format table|yaml|csv`, JSON output by default.

**Available services:** people (contacts), calendar, gmail, drive, sheets, docs, slides, tasks, chat, classroom, forms, keep, meet, admin-reports. Helper commands (prefixed with `+`) are available for common operations — run `gws <service> --help` to see them.

## OwnTracks Location Tracking

Real-time GPS location from the user's phone via OwnTracks app. The `POST /owntracks` endpoint accepts location updates and stores them as a `current-location` memory fact. Auth supports both Bearer token and HTTP Basic auth (iOS OwnTracks uses Basic by default — password field = token). Set `OWNTRACKS_TOKEN` env var to enable. Telegram live location sharing also updates the same memory fact.

## Adding Telegram Slash Commands

When adding a new slash command, update ALL of these locations:

1. **`handleCommand()` switch statement** in `src/telegram.ts` — the actual handler
2. **`/start` case help text** — welcome message listing commands
3. **`default` case command list** — fallback "unknown command" response
4. **`workspace-CLAUDE.md` Telegram Commands section** — so the agent knows about it (deployed to `workDir`)
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
| `telegram-bot-token` | `.env` → `TELEGRAM_BOT_TOKEN` |
| `telegram-allowed-users` | `.env` → `TELEGRAM_ALLOWED_USERS` |
| `gh-token` | `.env` → `GH_TOKEN` |
| `ical-url` | `.env` → `ICAL_URL` |
| `google-maps-api-key` | `.env` → `GOOGLE_MAPS_API_KEY` |
| `facebook-app-id` | `.env` → `FACEBOOK_APP_ID` |
| `facebook-app-secret` | `.env` → `FACEBOOK_APP_SECRET` |
| `facebook-page-id` | `.env` → `FACEBOOK_PAGE_ID` |
| `facebook-page-token-env` | `.env` → `FACEBOOK_PAGE_TOKEN` |
| `composio-api-key` | `.env` → `COMPOSIO_API_KEY` |
| `trello-api-key` | `.env` → `TRELLO_API_KEY` |
| `trello-api-token` | `.env` → `TRELLO_API_TOKEN` |
| `owntracks-token` | `.env` → `OWNTRACKS_TOKEN` |
| `gateway-api-token` | `.env` → `GATEWAY_API_TOKEN` |
| `retell-api-key` | `.env` → `RETELL_API_KEY` |
| `retell-phone-number` | `.env` → `RETELL_PHONE_NUMBER` |
| `retell-agent-id` | `.env` → `RETELL_AGENT_ID` |
| `gmail` | `/home/ubuntu/agent/gmail_app_password.json` |
| `facebook` | `/home/ubuntu/.claude-agent/facebook-page-token.json` |
| `google-service-account` | `/home/ubuntu/.claude-agent/google-service-account.json` |
| `google-credentials` | `/home/ubuntu/.claude-agent/google-credentials.json` |
| `claude-oauth` | `/home/ubuntu/.claude/.credentials.json` (OAuth credentials) |
| `gws-oauth-token` | `~/.config/gws/credentials.json` (OAuth token for Google Workspace CLI, Codespaces only) |
| `claude-code-admin-key` | Admin API key (`sk-ant-admin...`) for org management (not synced to server) |
| `lightsail-ssh-key` | `~/.ssh/claude-code-agent-key.pem` (deploy SSH key, Codespaces only) |

**Workflows:**
- **Sync secrets:** `bash scripts/sync-secrets.sh` (or `./deploy.sh --sync-secrets`)
- **Add/rotate a secret:** Update the individual entry in Bitwarden vault → run sync
- **Split migration:** `bash scripts/split-env-secrets.sh` (one-time: splits old `env-secrets` blob into individual entries)
- **Rollback:** `bash scripts/rollback-secrets.sh <backup-dir>` (backups created by migration script in `~/.claude-agent-backup-*`)
- **New instance:** Install `bw` CLI locally, run `sync-secrets.sh` after placing config-only `.env` on server

General config (PORT, CLAUDE_MODEL, etc.) stays in `.env` on the server and is not managed by Bitwarden. See `.env.example` for the split.

**Codespaces / devcontainer:**
- `postCreateCommand` runs `.devcontainer/post-create.sh` automatically — installs tools (`bw`, `gh`, `claude`, `gws`, `tmux`), `npm install`, generates config-only `.env` with Codespace paths, configures SSH proxy for Tailscale
- Devcontainer features: GitHub CLI, Bitwarden CLI, Tailscale (all pre-installed via `devcontainer.json`)
- After Codespace opens: `bash .devcontainer/setup-secrets.sh` to inject secrets from Bitwarden (interactive login required)
- **Tailscale connectivity:** Containers lack `/dev/net/tun`, so Tailscale must use userspace networking: `sudo tailscaled --tun=userspace-networking &` then `sudo tailscale up`. SSH to the instance uses `ProxyCommand sudo tailscale nc %h %p` (auto-configured in `~/.ssh/config` by `post-create.sh`).
- JSON credential files are written to `./` and `~/.claude-agent/` (Codespace-local paths, not server paths)
- Idempotent — safe to re-run `setup-secrets.sh` after vault changes
- Requires `BW_GMAIL_ID`, `BW_FACEBOOK_ID`, `BW_GOOGLE_SA_ID`, `BW_GOOGLE_CREDS_ID` env vars for JSON credentials (same as `sync-secrets.sh`)

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

- Gateway binds to `0.0.0.0` (all interfaces) — Tailscale VPN + cloud firewall provide network access control
- **Gateway auth**: `GATEWAY_API_TOKEN` env var enables bearer token auth on all endpoints except `/health` and `/owntracks` (which has its own auth). Optional — no auth enforced if unset (backward-compatible).
- **Security headers**: `@fastify/helmet` sets `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Strict-Transport-Security`, disables `X-Powered-By`. CSP disabled (API-only, no HTML).
- **Rate limiting**: `@fastify/rate-limit` with in-memory store. Global: 60 req/min. `/webhook`: 5 req/min. `/calls`: 3 req/min.
- Telegram auth is fail-closed: empty `allowedUsers` = crash at startup
- Error messages to users are generic; details logged server-side only
- Scheduler limits: max 20 tasks, minimum 5-minute interval
- Gateway body limit: 10KB
