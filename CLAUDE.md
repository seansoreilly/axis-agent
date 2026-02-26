# Claude Code Agent

## Project Overview
Always-on AI agent powered by Claude Code Agent SDK with Telegram integration, deployed on AWS Lightsail behind Tailscale.

## Architecture
- `src/index.ts` — entrypoint, wires up all components
- `src/agent.ts` — wraps `@anthropic-ai/claude-agent-sdk` `query()` calls
- `src/telegram.ts` — Telegram bot (polling mode) with command handling
- `src/gateway.ts` — Fastify HTTP API (health, webhook, scheduled tasks)
- `src/scheduler.ts` — cron-based task scheduling via `node-cron`
- `src/config.ts` — env var loading and validation
- `src/memory.ts` — persistent fact storage for agent context
- `src/logger.ts` — structured logging

## Deployment
- **Host:** AWS Lightsail (`claude-code-agent` via Tailscale MagicDNS)
- **Deploy:** `./deploy.sh` (uses `DEPLOY_HOST` env var, defaults to Tailscale hostname)
- **Service:** systemd `claude-agent.service` with security hardening
- **Network:** Gateway bound to `127.0.0.1`, only reachable via Tailscale or local access

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

## Common Issues
- **"Claude Code process exited with code 1"** — usually a filesystem permission issue from systemd sandboxing. Check `ReadWritePaths`.
- **Exit code 226/NAMESPACE** — a directory in `ReadWritePaths` doesn't exist. Create it first.
- **Telegram redelivers messages on restart** — polling mode picks up unacked messages. The agent will process them and may hit stale session errors. This is benign.
