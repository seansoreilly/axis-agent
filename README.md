# Claude Code Agent

An always-on AI agent powered by the [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview). Receives messages via Telegram, dispatches them to Claude Code, and returns results. General-purpose assistant + task automation (web browsing, file management, research, scheduled tasks).

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

## Architecture

```
Telegram --> TelegramIntegration --> Agent (Claude Agent SDK) --> Claude
HTTP API --> Fastify Gateway --------^
Cron    --> Scheduler ---------------^
```

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

Edit `.env`:

```bash
TELEGRAM_BOT_TOKEN=your-token-from-botfather
TELEGRAM_ALLOWED_USERS=your-numeric-telegram-id
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
| `/start` | Welcome message |
| `/new` | Clear session, start fresh conversation |
| `/remember key=value` | Store a persistent memory |
| `/forget key` | Remove a memory |
| `/memories` | List all memories |
| `/status` | Show uptime and stats |

Any other message is sent to Claude as a prompt. Sessions persist — follow-up messages maintain conversation context.

### HTTP API

| Endpoint | Method | Description |
|---|---|---|
| `/health` | GET | Health check |
| `/webhook` | POST | Send prompt to agent (`{ "prompt": "...", "sessionId?": "..." }`) |
| `/tasks` | GET | List scheduled tasks |
| `/tasks` | POST | Create scheduled task (`{ "id", "name", "schedule", "prompt" }`) |
| `/tasks/:id` | DELETE | Remove scheduled task |

### Scheduled Tasks

Create recurring tasks via the HTTP API:

```bash
curl -X POST http://localhost:8080/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "id": "daily-summary",
    "name": "Daily News Summary",
    "schedule": "0 9 * * *",
    "prompt": "Search for the top 5 tech news stories today and summarize them"
  }'
```

Results are sent to the primary Telegram user as notifications.

## Security

- **Network isolation**: Gateway binds to `127.0.0.1` only — not reachable on public IP. Use Tailscale for remote access.
- **Telegram auth**: Fail-closed — if `TELEGRAM_ALLOWED_USERS` is empty, the service refuses to start. If set, only listed user IDs can interact.
- **Systemd sandboxing**: `ProtectHome=read-only`, `ProtectSystem=strict`, `NoNewPrivileges=true`, `PrivateTmp=true`, with explicit `ReadWritePaths` for required directories.
- **Request limits**: Gateway body size capped at 10KB. Scheduler limited to 20 tasks with minimum 5-minute intervals.
- **Error sanitization**: Internal errors return generic messages to users; details logged server-side only.

## Project Structure

```
src/
  index.ts       # Entry point - starts all services
  config.ts      # Environment config loader
  agent.ts       # Wraps Claude Agent SDK query() calls
  gateway.ts     # Fastify HTTP server (webhook + task management)
  telegram.ts    # Telegram Bot API connector
  memory.ts      # Persistent file-based memory store
  scheduler.ts   # Cron-based task scheduling
  logger.ts      # Structured logging
systemd/
  claude-agent.service  # Systemd unit file
deploy.sh              # Deploy to remote server
```

## License

MIT
