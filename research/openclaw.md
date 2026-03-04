# OpenClaw Research

## What is OpenClaw?

OpenClaw is a **free, open-source, autonomous AI agent** developed by Austrian developer Peter Steinberger. Originally published November 2025 as "Clawdbot", renamed to "Moltbot", then settled on **OpenClaw**. As of late February 2026: **226,887 GitHub stars**, **43,412 forks**, **852 contributors**. Crossed 100k stars in under a week — one of the fastest-growing repos in GitHub history. Drew 2 million visitors in a single week.

- **Repository**: https://github.com/openclaw/openclaw
- **Site**: https://openclaw.ai/
- On Feb 14, 2026, Steinberger announced he'd be joining OpenAI; project moving to an open-source foundation.

## What It Does

A **personal AI assistant that runs on your own hardware** (local machine or VPS). Connects to messaging platforms as its UI:

- **Chat platforms**: WhatsApp, Telegram, Slack, Discord, Google Chat, Signal, iMessage, Microsoft Teams, WebChat
- **Extension channels**: BlueBubbles, Matrix, Zalo

### Capabilities
- Browse the web, fill forms, extract data from sites
- Read/write files, run shell commands, e22xecute scripts
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
Skill registry with **5,700+ community-built skills** (565+ verified). Agent can search for and pull in skills automatically at runtime, selectively injecting only relevant skills per turn to avoid prompt bloat.

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
- Meta AI safety director's OpenClaw agent started **autonomously deleting all emails older than a week** — she had to physically run to her Mac mini to terminate it (widely covered incident)
- **Microsoft warning**: Researchers warned about running OpenClaw on standard workstations — risks from blending untrusted instructions with executable code using valid credentials
- Security firms (Cisco, BitSight, Malwarebytes) recommend running in **isolated Docker container** or VM
- Misconfigured instances with access to email/calendars/messaging present serious privacy risks
- **CLAWD token**: Unauthorized cryptocurrency token caused enough disruption that OpenClaw banned all crypto discussion on Discord
- Bleeping Computer found real supply-chain risks in skills marketplace but limited signs of large-scale criminal exploitation
- Global adoption including China (Alibaba, Tencent, ByteDance integrating with local messaging apps and DeepSeek)

## Top 10 Integrations

| # | Category | Integration | What it does |
|---|----------|-------------|--------------|
| 1 | **Messaging** | WhatsApp, Telegram, Signal, Discord, iMessage | Primary chat interfaces for interacting with the agent |
| 2 | **Messaging (Enterprise)** | Microsoft Teams | Enterprise-ready integration with org accounts and channels |
| 3 | **Productivity** | Notion, Obsidian, Apple Notes/Reminders, Things 3 | Task and note management from a single conversation |
| 4 | **Google Suite** | Gmail, Google Calendar, Google Drive | Calendar, email, and file management via the "gog" skill |
| 5 | **Project Management** | Trello, Linear, Jira | Autonomous project board management |
| 6 | **Dev/DevOps** | GitHub | Repo management, issues, PR reviews, workflow automation via chat |
| 7 | **Local AI** | Ollama | Run on local models for coding, reasoning, and tool execution |
| 8 | **Infrastructure** | Cloudflare Workers (Moltworker) | Serverless, always-on edge deployment |
| 9 | **Smart Home** | Home Assistant | Control devices via natural language |
| 10 | **Voice/Telephony** | Twilio, Telnyx, Plivo | Outbound notifications and multi-turn phone conversations |

**Ecosystem stats:** 50+ integrations, 5,400+ community skills in the official registry.

## Replicating with Claude Code SDK

To replicate OpenClaw's core functionality using Claude Code on Lightsail, you'd need:

1. **Always-on Gateway** — Node.js/TypeScript server (systemd/Docker), listens for incoming messages, dispatches to Claude Code SDK
2. **Messaging integrations** — Connectors for WhatsApp (Business API), Telegram (Bot API), Discord (Bot), etc.
3. **Tool/skill execution layer** — Claude Code already has file read/write, shell execution, web search
4. **Persistent memory** — File-based or database-backed memory system
5. **Scheduling** — Cron-like functionality for recurring tasks, reminders, webhook endpoints

### Status: All 5 Implemented

| # | Component | Our Implementation |
|---|---|---|
| 1 | **Always-on Gateway** | `src/gateway.ts` (Fastify, localhost:8080) + `src/index.ts` entrypoint, systemd service on Lightsail |
| 2 | **Messaging integrations** | `src/telegram.ts` — Telegram Bot API polling mode with commands, photos, voice, documents |
| 3 | **Tool/skill execution** | Claude Code SDK `query()` with `bypassPermissions` + skills in `.claude/skills/` (facebook, gmail, twilio, bitwarden, commit) + Zapier MCP + Trello MCP |
| 4 | **Persistent memory** | `src/memory.ts` — JSON file store at `~/.claude-agent/memory/store.json` (key-value facts + session records) |
| 5 | **Scheduling** | `src/scheduler.ts` — `node-cron`, Australia/Melbourne timezone, max 20 tasks, min 5-min interval |

### Integration Parity with OpenClaw Top 10

| # | OpenClaw Integration | Our Agent | Gap |
|---|---|---|---|
| 1 | Telegram | `src/telegram.ts` | **Parity** |
| 2 | Gmail | `.claude/skills/gmail/` + Zapier MCP | **Parity** |
| 3 | Google Calendar | Zapier MCP (`mcp__zapier__*`) | **Parity** |
| 4 | Google Contacts | Zapier MCP | **Parity** |
| 5 | Trello | `.mcp.json` → `trello` MCP server | **Parity** |
| 6 | Facebook | `.claude/skills/facebook/` | **Parity** |
| 7 | Twilio (SMS/Voice) | `.claude/skills/twilio/` | **Parity** |
| 8 | WhatsApp, Discord, Signal, Teams | Not implemented | **Gap** — additional messaging channels |
| 9 | Notion, Obsidian, Linear, Jira | Not implemented | **Gap** — productivity/PM tools |
| 10 | Home Assistant, Ollama | Not implemented | **Gap** — smart home, local AI |

## Top 5 OpenClaw Features We Don't Have

### 1. Browser Automation (Playwright/Puppeteer)
OpenClaw has built-in headless browser control — navigate pages, fill forms, click buttons, extract data, take screenshots, generate PDFs. Uses Playwright under the hood but abstracts it with an AI-friendly "Snapshot" system where the LLM understands page structure and decides next steps automatically. Two modes: Chrome Extension (relay to user's browser) and headless (server-side, isolated).

**Gap**: Our agent can `curl` and `WebFetch` but can't interact with dynamic pages, fill forms, or extract from JS-rendered sites. No browser instance available.

**Effort**: Medium. Could add via Playwright MCP server (already available in our local Claude Code setup) or the `browserless-agent` skill from ClawHub.

### 2. Autonomous Skill Generation (Self-Improving Agent)
OpenClaw can write new skills for itself on demand — user describes a capability in chat, and the agent generates a `SKILL.md` + supporting code, saves it to the skills directory, and starts using it immediately. Also captures errors, corrections, and learnings to improve over time.

**Gap**: Our agent can self-deploy and edit its own code, but doesn't have a structured workflow for generating new skills from conversation. It could technically do it (has Write + Bash + self-deploy), but there's no skill template system or error-learning loop.

**Effort**: Low-Medium. The primitives exist (self-deploy, skills directory, Write tool). Need a system prompt addition that teaches the agent the skill creation pattern + a learning/corrections log.

### 3. Proactive Agent / Heartbeat System
OpenClaw has a "proactive-agent" skill with a heartbeat system — the agent periodically checks in, reviews pending tasks, anticipates user needs based on context and memory, and proactively reaches out via messaging. Not just cron jobs (which we have), but intelligent context-aware check-ins.

**Gap**: Our scheduler runs prompts on cron schedules, but it's user-configured and static. No intelligent heartbeat that reviews memory/context and decides whether to proactively message the user. No "morning briefing" or "you have a meeting in 30 minutes" unprompted alerts.

**Effort**: Medium. Could build on existing `Scheduler` + `Memory` — add a heartbeat cron that runs a meta-prompt asking the agent to review calendar, pending tasks, and recent context to decide if anything warrants a proactive message.

### 4. Webhook Triggers (Inbound Event Processing)
OpenClaw supports inbound webhooks — external services POST events to the agent, which triggers automated responses. Examples: GitHub push webhook triggers a code review, Stripe payment webhook triggers a notification, form submission triggers data processing.

**Gap**: Our gateway has `POST /webhook` but it's a simple prompt relay — no event parsing, no per-source routing, no registered webhook handlers. External services can't trigger contextual agent actions.

**Effort**: Medium. Extend `Gateway` with webhook registration (source → prompt template mapping), event parsing, and response routing back through Telegram.

### 5. Agent-to-Agent Communication (Multi-Agent Network)
OpenClaw agents can communicate with each other — one user's agent can delegate tasks to or exchange information with another agent. This led to "Moltbook," a social network for AI agents. Enables collaborative workflows across multiple agent instances.

**Gap**: Our agent is single-instance, single-user. No protocol for agent-to-agent messaging or task delegation across instances.

**Effort**: High. Would need a discovery/registry mechanism, authentication between agents, message protocol, and trust model. Lowest priority — niche use case for a personal agent.

### Priority Ranking (by value-to-effort ratio)
1. **Autonomous Skill Generation** — low effort, high leverage (agent becomes self-extending)
2. **Proactive Agent / Heartbeat** — medium effort, high daily utility
3. **Browser Automation** — medium effort, unlocks entire category of web tasks
4. **Webhook Triggers** — medium effort, enables event-driven workflows
5. **Agent-to-Agent Communication** — high effort, niche value

## Recent News (late Feb 2026)

- **Steinberger joins OpenAI** (Feb 15, 2026) — OpenClaw Foundation being established for independent governance
- **Perplexity** launched a competing managed AI agent product in response to OpenClaw's rise
- Google's infrastructure experienced load issues attributed to OpenClaw usage
- OpenClaw's SOUL.md concept gaining traction as an industry pattern for agent persona/safety definition

## References

- [OpenClaw GitHub](https://github.com/openclaw/openclaw)
- [OpenClaw Official Site](https://openclaw.ai/)
- [OpenClaw - Wikipedia](https://en.wikipedia.org/wiki/OpenClaw)
- [Architecture Overview](https://ppaolo.substack.com/p/openclaw-system-architecture-overview)
- [OpenClaw vs Claude Code - DataCamp](https://www.datacamp.com/blog/openclaw-vs-claude-code)
- [AWS Setup Guide](https://dev.to/brayanarrieta/how-to-set-up-openclaw-ai-on-aws-3a0j)
- [Docker Security - Docker Blog](https://www.docker.com/blog/run-openclaw-securely-in-docker-sandboxes/)
- [Malwarebytes Safety Report](https://www.malwarebytes.com/blog/news/2026/02/openclaw-what-is-it-and-can-you-use-it-safely)
