# OpenClaw Research

## What is OpenClaw?

OpenClaw is a **free, open-source, autonomous AI agent** developed by Austrian developer Peter Steinberger. Originally published November 2025 as "Clawdbot", renamed to "Moltbot", then settled on **OpenClaw**. As of early February 2026: **140,000+ GitHub stars**, **20,000+ forks**.

- **Repository**: https://github.com/openclaw/openclaw
- **Site**: https://openclaw.ai/
- On Feb 14, 2026, Steinberger announced he'd be joining OpenAI; project moving to an open-source foundation.

## What It Does

A **personal AI assistant that runs on your own hardware** (local machine or VPS). Connects to messaging platforms as its UI:

- **Chat platforms**: WhatsApp, Telegram, Slack, Discord, Google Chat, Signal, iMessage, Microsoft Teams, WebChat
- **Extension channels**: BlueBubbles, Matrix, Zalo

### Capabilities
- Browse the web, fill forms, extract data from sites
- Read/write files, run shell commands, execute scripts
- Control smart home devices, manage Spotify playback
- Send emails, manage calendars, set reminders
- Scheduled cron jobs and webhook triggers
- **Persistent memory** across sessions

## Architecture

Hub-and-spoke architecture centered on a single always-on process called the **Gateway**:

### 1. Gateway
WebSocket server acting as the control plane. Connects to messaging platforms, manages sessions, channels, tools, and events. Runs on a machine you control (Mac mini, VPS, Lightsail instance).

### 2. Agent Runtime
When a message arrives, the Gateway dispatches it to the Agent Runtime which:
- Assembles context from session history and memory
- Invokes the configured LLM (Claude, GPT, DeepSeek, etc.)
- Watches for tool calls in model response
- Executes tools (optionally inside Docker sandbox)
- Streams tool results back into ongoing model generation
- Sends final response back through messaging channel

### 3. Skills System
Three extension types:
- **Skills** — Natural-language-driven API integrations defined in `SKILL.md` files (JS/TS functions)
- **Plugins** — Deep Gateway extensions in TypeScript/JavaScript
- **Webhooks** — HTTP endpoints that external systems POST to

### 4. ClawHub
Skill registry with **5,700+ community-built skills**. Agent can search for and pull in skills automatically at runtime, selectively injecting only relevant skills per turn to avoid prompt bloat.

### 5. Memory/Workspace
Personal data stored at `~/.openclaw/workspace` (skills, prompts, memories). Saves files, breadcrumbs, and chat histories for multi-day tasks without losing context.

## Technical Stack

- **Runtime**: Node.js 22+
- **Language**: TypeScript/JavaScript
- **Deployment**: Docker Compose (recommended)
- **Configuration**: `~/.openclaw/`
- **Setup**: CLI wizard via `openclaw onboard`
- **npm package**: `openclaw`

## OpenClaw vs Claude Code

| Aspect | OpenClaw | Claude Code |
|---|---|---|
| **Purpose** | General-purpose life/task assistant | Purpose-built coding agent |
| **Interface** | Messaging apps (WhatsApp, Telegram, etc.) | Terminal / IDE |
| **Hosting** | Self-hosted (your machine/VPS) | Anthropic-hosted model, local CLI |
| **Memory** | Persistent across sessions | Fresh each session (unless using CLAUDE.md) |
| **Coding** | Basic (via skills/shell commands) | Deep codebase understanding, refactoring |
| **Automation** | 50+ integrations, cron jobs, webhooks | Focused on development workflows |
| **LLM** | Configurable (Claude, GPT, DeepSeek, etc.) | Claude models only |
| **Security** | User-managed (Docker sandbox recommended) | Anthropic-managed sandboxing |

## Server Requirements

- **Minimum**: 2 vCPU, 4 GB RAM, 40 GB SSD
- **Recommended** (browser automation + multiple channels): 4 vCPU, 8 GB RAM, 80 GB SSD
- **OS**: Ubuntu 22.04 or Debian 12
- **Docker 24+** required

## Security Concerns

- Feb 2026: **386 malicious skills** discovered on ClawHub (supply-chain risk)
- Meta AI researcher had OpenClaw **delete 200 emails** when agent "ran amok"
- Security firms (Cisco, BitSight, Malwarebytes) recommend running in **isolated Docker container** or VM
- Misconfigured instances with access to email/calendars/messaging present serious privacy risks

## Replicating with Claude Code SDK

To replicate OpenClaw's core functionality using Claude Code on Lightsail, you'd need:

1. **Always-on Gateway** — Node.js/TypeScript server (systemd/Docker), listens for incoming messages, dispatches to Claude Code SDK
2. **Messaging integrations** — Connectors for WhatsApp (Business API), Telegram (Bot API), Discord (Bot), etc.
3. **Tool/skill execution layer** — Claude Code already has file read/write, shell execution, web search
4. **Persistent memory** — File-based or database-backed memory system
5. **Scheduling** — Cron-like functionality for recurring tasks, reminders, webhook endpoints

## References

- [OpenClaw GitHub](https://github.com/openclaw/openclaw)
- [OpenClaw Official Site](https://openclaw.ai/)
- [OpenClaw - Wikipedia](https://en.wikipedia.org/wiki/OpenClaw)
- [Architecture Overview](https://ppaolo.substack.com/p/openclaw-system-architecture-overview)
- [OpenClaw vs Claude Code - DataCamp](https://www.datacamp.com/blog/openclaw-vs-claude-code)
- [AWS Setup Guide](https://dev.to/brayanarrieta/how-to-set-up-openclaw-ai-on-aws-3a0j)
- [Docker Security - Docker Blog](https://www.docker.com/blog/run-openclaw-securely-in-docker-sandboxes/)
- [Malwarebytes Safety Report](https://www.malwarebytes.com/blog/news/2026/02/openclaw-what-is-it-and-can-you-use-it-safely)
