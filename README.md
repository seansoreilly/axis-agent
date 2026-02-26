# Claude Code Agent

Always-on AI agent powered by the Claude Agent SDK, running on a Lightsail instance. Receives messages via Telegram, dispatches them to Claude Code, and returns results. General-purpose assistant + task automation (web browsing, file management, research, scheduled tasks).

## Architecture

```
Telegram --> TelegramIntegration --> Agent (Claude Agent SDK) --> Claude
HTTP API --> Fastify Gateway --------^
Cron    --> Scheduler ---------------^
```

## Instance Details

| Detail | Value |
|---|---|
| **Name** | `claude-code-agent` |
| **Region** | `ap-southeast-2` (Sydney) |
| **Static IP** | `REDACTED_SERVER_IP` |
| **OS** | Ubuntu 24.04 LTS |
| **Size** | 2 CPU, 2GB RAM, 60GB disk ($12/mo) |
| **Node.js** | v22 |

## Project Structure

```
src/
  index.ts       # Entry point - starts all services
  agent.ts       # Wraps Claude Agent SDK query() calls
  gateway.ts     # Fastify HTTP server (webhook + task management)
  telegram.ts    # Telegram Bot API connector
  memory.ts      # Persistent file-based memory store
  scheduler.ts   # Cron-based task scheduling
  logger.ts      # Structured logging
  config.ts      # Environment config loader
systemd/
  claude-agent.service  # Systemd unit file
deploy.sh              # Deploy to Lightsail
```

## Setup

1. Copy `.env.example` to `.env` and fill in values
2. `npm install`
3. `npm run build`
4. `npm start`

## Telegram Commands

| Command | Description |
|---|---|
| `/start` | Welcome message |
| `/new` | Clear session, start fresh conversation |
| `/remember key=value` | Store a persistent memory |
| `/forget key` | Remove a memory |
| `/memories` | List all memories |
| `/status` | Show uptime and stats |

Any other message is sent to Claude as a prompt.

## HTTP API

| Endpoint | Method | Description |
|---|---|---|
| `/health` | GET | Health check |
| `/webhook` | POST | Send prompt to agent (`{ "prompt": "...", "sessionId?": "..." }`) |
| `/tasks` | GET | List scheduled tasks |
| `/tasks` | POST | Create scheduled task (`{ "id", "name", "schedule", "prompt" }`) |
| `/tasks/:id` | DELETE | Remove scheduled task |

## Deploy

```bash
./deploy.sh
```

Syncs code to Lightsail, installs deps, restarts systemd service.

## Connect to Instance

```bash
ssh -i ~/.ssh/claude-code-agent-key.pem ubuntu@REDACTED_SERVER_IP
```

## Manage Instance

```bash
# Start/Stop
aws lightsail start-instance --instance-name claude-code-agent --region ap-southeast-2
aws lightsail stop-instance --instance-name claude-code-agent --region ap-southeast-2

# Status
aws lightsail get-instance --instance-name claude-code-agent --region ap-southeast-2 \
  --query "instance.{ip:publicIpAddress,state:state.name}" --output table

# Service logs
ssh -i ~/.ssh/claude-code-agent-key.pem ubuntu@REDACTED_SERVER_IP "journalctl -u claude-agent -f"
```
