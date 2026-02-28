# Claude Code Agent

An always-on AI agent powered by the [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview). Receives messages via Telegram, dispatches them to Claude Code, and returns results. General-purpose assistant + task automation (web browsing, file management, research, scheduled tasks, calendar integration, email, social media posting).

## Why This Over OpenClaw?

[OpenClaw](https://github.com/openclaw/openclaw) is a popular open-source AI agent (140k+ stars) that connects to messaging platforms. This project takes a different approach by wrapping Claude Code directly via the Agent SDK:

| | Claude Code Agent | OpenClaw |
|---|---|---|
| **Token cost** | Uses your Max/Pro plan tokens (included in subscription) | Requires separate API key billing |
| **Always up to date** | Inherits Claude Code's tools, models, and capabilities as they ship | Must wait for OpenClaw maintainers to integrate updates |
| **Tool ecosystem** | Full Claude Code toolset (Read, Write, Edit, Bash, Glob, Grep, WebSearch, WebFetch, Task) + MCP servers | Custom skills system (ClawHub — with known supply-chain risks from malicious skills) |
| **Security** | Anthropic-managed sandboxing, no third-party skill registry | User-managed Docker sandbox recommended; 386 malicious skills found on ClawHub (Feb 2026) |
| **Complexity** | ~500 lines of TypeScript, single Node.js process | Full Docker Compose stack, 4+ GB RAM recommended |
| **LLM lock-in** | Claude only | Multi-provider (Claude, GPT, DeepSeek) |
| **Messaging** | Telegram + HTTP webhook | 10+ platforms (WhatsApp, Slack, Discord, etc.) |

The key advantage: **if you're already paying for a Claude Max or Pro plan, this agent uses those same tokens at no additional cost.** OpenClaw requires a separate API key with per-token billing.

> **Note:** Anthropic's Max plan is licensed for development and personal use only, not production workloads. If you're deploying for production, use the Anthropic API with per-token billing instead.

## Architecture

```
Telegram --> TelegramIntegration --> Agent (Claude Agent SDK) --> Claude
HTTP API --> Fastify Gateway --------^
Cron    --> Scheduler ---------------^
```

The agent runs as a single Node.js process under systemd with security hardening. Health monitoring via GitHub Actions auto-restarts the service or reboots the instance if needed.

## Features

### Telegram Bot
- **Conversational**: persistent sessions per user, with session resume across restarts
- **Session summaries**: auto-generated for sessions costing ≥$0.05, injected when resuming context
- **Model switching**: `/model opus|sonnet|haiku` to change models per session
- **Cancel/retry**: `/cancel` aborts a running request, `/retry` re-runs the last prompt
- **Cost tracking**: `/cost` shows accumulated usage and per-request averages
- **Media support**: photos (vision), voice messages (with duration), and document uploads
- **Progress indicators**: typing status, ETA based on recent response times, periodic updates every 60s
- **Inline keyboards**: retry and new session buttons on every response
- **Persistent memory**: `/remember key=value`, `/forget key`, `/memories`
- **Reply context**: reply to a specific message to include it as context

### Scheduled Tasks
- Create via Telegram (`/schedule add`) or HTTP API
- Cron-based scheduling with Australia/Melbourne timezone
- Results sent as Telegram notifications
- Limits: max 20 tasks, minimum 5-minute interval

### Integrations
- **Google Calendar** — read events via iCal feed (fast) or Google Calendar API (full CRUD). Requires a Google service account.
- **Gmail** — send and read emails via app password authentication (headless-compatible)
- **Facebook** — post text and photos to a Facebook Page via Graph API. Use `/post` in Telegram after uploading photos.

### Orchestration
- Spawns parallel subagents for complex multi-part tasks
- Chooses model tier per subtask (Opus for reasoning, Sonnet for coding, Haiku for lookups)
- Structured capability routing for adding new integrations (MCP servers → community skills → custom skills → one-off Bash)

### Self-Modification
- The agent can edit its own source code and redeploy via `scripts/deploy-self.sh`
- Use `/sync-from-instance` locally to pull changes back to the repo

### Health Monitoring
- **GitHub Actions** workflow runs every 30 minutes — checks instance state, SSH connectivity, and service health
- **Self-heal script** runs on the instance via systemd timer — restarts the service if it becomes inactive
- **Local health check** script verifies Tailscale, AWS instance state, and peer connectivity

## Installation

### Prerequisites

- Node.js 22+
- A server or VPS (e.g. AWS Lightsail $12/mo)
- Claude Code CLI installed and authenticated (`npm install -g @anthropic-ai/claude-code && claude`)
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- Your Telegram user ID from [@userinfobot](https://t.me/userinfobot)

### 1. Clone and install

```bash
git clone https://github.com/seansoreilly/claude-code-agent.git
cd claude-code-agent
npm install
npm run build
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with general config (ports, model settings, paths). Secrets (API keys, tokens) are managed separately via Bitwarden — see [Secret Management](#secret-management) below.

```bash
PORT=8080
CLAUDE_MODEL=claude-sonnet-4-6
CLAUDE_MAX_TURNS=25
CLAUDE_MAX_BUDGET_USD=5
CLAUDE_WORK_DIR=/home/ubuntu/workspace
MEMORY_DIR=/home/ubuntu/.claude-agent/memory
```

### 3. Authenticate Claude Code on the server

```bash
claude auth login
```

This authenticates with your Max/Pro plan. The Agent SDK inherits this auth — no API key needed.

### 4. Create required directories

The systemd service uses `ProtectHome=read-only` with explicit write paths. These directories must exist before the service starts:

```bash
mkdir -p /home/ubuntu/workspace /home/ubuntu/.claude-agent/memory /home/ubuntu/.claude /home/ubuntu/.config
```

### 5. Install and configure Tailscale (recommended)

The gateway binds to `127.0.0.1` — it is not publicly accessible. Use [Tailscale](https://tailscale.com) to access it remotely:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --hostname=claude-code-agent
```

Authenticate via the URL printed, then verify:

```bash
tailscale ip -4
```

Enable Tailscale SSH so you can connect without managing SSH keys:

```bash
sudo tailscale set --ssh
```

You can then close all inbound ports on your cloud firewall (including SSH 22) — access is entirely via Tailscale.

### 6. Run directly

```bash
npm start
```

### 7. Run as a systemd service (recommended)

```bash
sudo cp systemd/claude-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable claude-agent
sudo systemctl start claude-agent
```

Check status:

```bash
sudo systemctl status claude-agent
journalctl -u claude-agent -f
```

### Deploy updates

If developing on a local machine, use `deploy.sh` to rsync and restart on the server:

```bash
# Uses Tailscale MagicDNS hostname by default, or override:
DEPLOY_HOST="ubuntu@your-server-ip" ./deploy.sh
```

## Usage

### Telegram Commands

| Command | Description |
|---|---|
| `/start` | Welcome message with command list |
| `/new` | Clear session, start fresh conversation |
| `/cancel` | Abort the current running request |
| `/retry` | Re-run the last prompt |
| `/model [opus\|sonnet\|haiku\|default]` | Switch model for this session |
| `/cost` | Show accumulated usage costs |
| `/schedule add\|remove\|enable\|disable` | Manage scheduled tasks |
| `/tasks` | List all scheduled tasks |
| `/remember key=value` | Store a persistent fact |
| `/forget key` | Remove a fact |
| `/memories` | List all facts |
| `/status` | Show uptime, sessions, model, cost, tasks |
| `/post [notes]` | Create a Facebook post using recently uploaded photos |

Any other message is sent to Claude as a prompt. Sessions persist — follow-up messages maintain conversation context.

### HTTP API

| Endpoint | Method | Description |
|---|---|---|
| `/health` | GET | Health check (returns uptime and timestamp) |
| `/webhook` | POST | Send prompt to agent (`{ "prompt": "...", "sessionId?": "..." }`) |
| `/tasks` | GET | List scheduled tasks |
| `/tasks` | POST | Create scheduled task (`{ "id", "name", "schedule", "prompt" }`) |
| `/tasks/:id` | DELETE | Remove scheduled task |

## Secret Management

Secrets (API keys, tokens, credentials) are stored in [Bitwarden](https://bitwarden.com/) and synced to the server at deploy time. The `bw` CLI runs **locally only** — your master password never touches the server.

**Setup:**
1. Install the Bitwarden CLI: `npm install -g @bitwarden/cli`
2. Run the one-time migration: `bash scripts/migrate-secrets-to-bitwarden.sh`
3. Sync secrets to server: `bash scripts/sync-secrets.sh` (or `./deploy.sh --sync-secrets`)

**Vault folder:** `claude-agent-lightsail` — contains Secure Notes for env secrets, Gmail, Facebook, and Google credentials.

**Workflows:**
- **Rotate a secret:** Update in Bitwarden → `bash scripts/sync-secrets.sh`
- **Deploy with secrets:** `./deploy.sh --sync-secrets`
- **Rollback:** `bash scripts/rollback-secrets.sh ~/.claude-agent-backup-<timestamp>`

See `CLAUDE.md` for the full secret inventory and `.env.example` for the config vs secrets split.

## Security

- **Secret management**: Secrets stored in Bitwarden vault, synced to server via SCP. Master password never leaves the local machine. Server files are `chmod 600`.
- **Network isolation**: Gateway binds to `127.0.0.1` only — not reachable on public IP. Use Tailscale for remote access.
- **Telegram auth**: Fail-closed — if `TELEGRAM_ALLOWED_USERS` is empty, the service refuses to start. If set, only listed user IDs can interact.
- **Systemd sandboxing**: `ProtectHome=read-only`, `ProtectSystem=strict`, `NoNewPrivileges=true`, `PrivateTmp=true`, with explicit `ReadWritePaths` for required directories.
- **Request limits**: Gateway body size capped at 10KB. Scheduler limited to 20 tasks with minimum 5-minute intervals.
- **Error sanitization**: Internal errors return generic messages to users; details logged server-side only.

## Project Structure

```
src/
  index.ts            # Entry point - starts all services
  config.ts           # Environment config loader
  agent.ts            # Wraps Claude Agent SDK query() calls
  gateway.ts          # Fastify HTTP server (webhook + task management)
  telegram.ts         # Telegram Bot API connector (commands, media, inline keyboards)
  telegram.test.ts    # Tests (vitest)
  memory.ts           # Persistent file-based memory store
  scheduler.ts        # Cron-based task scheduling
  logger.ts           # Structured logging
scripts/
  sync-secrets.sh     # Fetch secrets from Bitwarden, push to server via SCP
  migrate-secrets-to-bitwarden.sh  # One-time migration of server secrets to vault
  rollback-secrets.sh # Restore server secrets from local backup
  deploy-self.sh      # Self-deploy (runs on the server)
  health-check.sh     # Local health monitoring (Tailscale, AWS, SSH, service)
  self-heal.sh        # Auto-restart service if inactive (systemd timer)
  remember.js         # CLI for persistent fact CRUD
  daily_briefing.py   # Daily briefing script
  calendar/           # Google Calendar integration (Python)
.claude/skills/
  gmail/              # Send and read emails via app password
  google-calendar/    # Full calendar CRUD via service account
  facebook/           # Post text and photos to Facebook Page
  commit/             # Safe git commit with secret/PII leak prevention
.github/workflows/
  health-check.yml    # GitHub Actions health monitoring (every 30 min)
systemd/
  claude-agent.service  # Systemd unit file with security hardening
deploy.sh               # Deploy from local to remote server
```

## License

MIT
