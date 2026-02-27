# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Test Commands

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
- `TelegramIntegration` (`src/telegram.ts`) — polling-mode bot. Handles commands (`/new`, `/cancel`, `/retry`, `/model`, `/cost`, `/schedule`, `/tasks`, `/remember`, `/forget`, `/memories`, `/status`), inline keyboard callbacks, photo/voice/document uploads, reply context, and per-user state (model override, cost tracking, abort controller). Constructor takes optional `Scheduler` as 5th param.
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

## Security Model

- Gateway is localhost-only (Tailscale provides network access control)
- Telegram auth is fail-closed: empty `allowedUsers` = crash at startup
- Error messages to users are generic; details logged server-side only
- Scheduler limits: max 20 tasks, minimum 5-minute interval
- Gateway body limit: 10KB
