# Claude Code Agent

## Project Overview
Always-on AI agent powered by Claude Code Agent SDK with Telegram integration, deployed on AWS Lightsail behind Tailscale.

## Architecture
- `src/index.ts` — entrypoint, wires up all components
- `src/agent.ts` — wraps `@anthropic-ai/claude-agent-sdk` `query()` calls, supports AbortSignal for cancellation
- `src/telegram.ts` — Telegram bot (polling mode) with command handling, inline keyboards, photo/voice support
- `src/gateway.ts` — Fastify HTTP API (health, webhook, scheduled tasks)
- `src/scheduler.ts` — cron-based task scheduling via `node-cron`
- `src/config.ts` — env var loading and validation
- `src/memory.ts` — persistent fact storage for agent context
- `src/logger.ts` — structured logging

## Deployment
- **Host:** AWS Lightsail (`claude-code-agent` via Tailscale MagicDNS)
- **Timezone:** `Australia/Melbourne` (set via `TZ` env var in systemd service)
- **Remote deploy:** `./deploy.sh` (uses `DEPLOY_HOST` env var, defaults to Tailscale hostname)
- **Self-deploy:** `bash /home/ubuntu/agent/scripts/deploy-self.sh` (runs on the server itself — builds, installs service, restarts)
- **Service:** systemd `claude-agent.service` with security hardening
- **Network:** Gateway bound to `127.0.0.1`, only reachable via Tailscale or local access
- **Testing:** `npm test` (vitest)

## SDK Learnings

### Permission Modes
- `bypassPermissions` is the only mode that works reliably in headless/systemd environments
- `acceptEdits` still prompts for Bash tool permissions — without a TTY the subprocess exits with code 1
- When using `bypassPermissions`, you MUST set `allowDangerouslySkipPermissions: true`
- `allowedTools` array controls which tools are available but does NOT replace permission prompts in non-bypass modes

### cron-parser v5 API
- The `cron-parser` package v5+ uses `CronExpressionParser.parse()` instead of the old `parseExpression()`
- Import: `import { CronExpressionParser } from "cron-parser"`

## Systemd Hardening

### Working Configuration
```ini
PrivateTmp=true
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/home/ubuntu/workspace /home/ubuntu/.claude-agent /home/ubuntu/agent /home/ubuntu/.claude /home/ubuntu/.config
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
```

### Critical: ReadWritePaths
- `ProtectHome=read-only` blocks writes to the entire home directory
- The Claude Code CLI writes to `~/.claude/` (sessions, cache, debug, backups, todos, shell-snapshots, statsig)
- **You MUST include `/home/ubuntu/.claude` in `ReadWritePaths`** or the SDK subprocess will exit with code 1
- All directories in `ReadWritePaths` must exist before the service starts, otherwise systemd fails with exit code 226/NAMESPACE
- `/home/ubuntu/.config` is also needed for general Node.js/tool config storage

## Security Model
- Gateway is localhost-only (Tailscale provides network access control)
- Telegram auth is fail-closed: `allowedUsers.size === 0` returns `false`
- `TELEGRAM_ALLOWED_USERS` is validated at startup — empty = crash with clear error
- Error messages to users are generic; details logged server-side only
- Scheduler limits: max 20 tasks, minimum 5-minute interval
- Gateway body limit: 10KB

## Telegram Bot Features

### Commands
- `/new` — clear session, start fresh
- `/cancel` — abort running request (uses AbortController signal passed to agent)
- `/retry` — re-run the last prompt
- `/model [opus|sonnet|haiku|default]` — switch model per user session; no arg shows inline keyboard
- `/cost` — show accumulated cost, request count, avg cost per request
- `/schedule add|remove|enable|disable` — manage cron tasks from Telegram
- `/tasks` — list all scheduled tasks
- `/remember key=value` — store persistent fact
- `/forget key` — delete a fact
- `/memories` — list all facts
- `/status` — uptime, sessions, memories, model, cost, scheduled tasks

### Media Support
- **Photos**: saved to `/tmp/telegram_photo_*.jpg`, agent reads them with the Read tool (vision)
- **Voice messages**: saved to `/tmp/telegram_voice_*.ogg`, agent processes via Bash
- **Documents**: downloaded as text and prepended to the message

### UX
- **Inline reply context**: replying to a bot message prepends the quoted text as context
- **Callback buttons**: every response includes "Retry" and "New session" inline keyboard buttons
- **Per-user state**: model override, cost tracking, last prompt (for /retry), abort controller
- **Bot command menu**: updated via `setMyCommands` API — must be re-run if commands change

### Key Patterns
- `TelegramIntegration` constructor accepts optional `Scheduler` (5th param) for `/schedule` and `/tasks`
- `UserState` map tracks per-user: `lastPrompt`, `modelOverride`, `totalCostUsd`, `requestCount`, `abortController`
- `runAgent()` is the shared method for both regular messages and `/retry`/callback retries
- `handleCallbackQuery()` handles inline keyboard button presses
- `sanitizeKey()` strips non-alphanumeric chars from schedule IDs and memory keys

## Common Issues
- **"Claude Code process exited with code 1"** — usually a filesystem permission issue from systemd sandboxing. Check `ReadWritePaths`.
- **Exit code 226/NAMESPACE** — a directory in `ReadWritePaths` doesn't exist. Create it first.
- **Telegram redelivers messages on restart** — polling mode picks up unacked messages. The agent will process them and may hit stale session errors. This is benign.
- **Stale dist/ test files** — vitest picks up `dist/telegram.test.js` if it exists. Delete it or ensure `npm run build` is current before testing.
