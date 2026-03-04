# OpenClaw Feature Gap Analysis

> Research date: 2026-03-04
> Comparing: OpenClaw (github.com/openclaw/openclaw, 247K+ GitHub stars) vs this repo (Claude Code Agent SDK + Telegram)

## Background

OpenClaw (formerly Clawdbot/Moltbot) is an MIT-licensed, open-source autonomous AI agent by Peter Steinberger. It became the fastest-growing GitHub project in history (250K+ stars in ~4 months). It uses a five-component architecture: **Gateway** (message routing), **Brain** (ReAct LLM loop), **Memory** (Markdown files on disk), **Skills** (plug-in capabilities), and **Heartbeat** (cron + proactive monitoring).

---

## Feature Gap Summary

### Tier 1: High-Value, Actionable Gaps

#### 1. SOUL.md Personality File
**OpenClaw:** Defines agent identity, communication style, values, and ethical constraints in a `SOUL.md` file loaded at the start of every reasoning cycle. Separates persona from code.

**Our status:** System prompt hardcoded in `agent.ts` `buildSystemPrompt()` method.

**Recommendation:** Extract system prompt into a `SOUL.md` (or similar) file loaded at runtime. Makes personality tweaks trivial without code changes. Could support per-user or per-context personas.

**Effort:** Low (1-2 hours) | **Value:** Medium

---

#### 2. Automatic Session Compaction
**OpenClaw:** Automatically summarizes older conversation parts before they fall out of context window. Runs a "memory flush" step that promotes durable information (facts, decisions, preferences) into persistent memory files before compacting. This means long conversations don't lose critical context.

**Our status:** Only generates summaries for sessions costing >$0.05, and only at session end. No mid-session compaction. No automatic fact extraction during conversations.

**Recommendation:** Add mid-conversation compaction that:
- Detects when context is approaching limits
- Extracts durable facts into memory store automatically
- Summarizes older turns while preserving recent ones
- Injects the summary as context for continued conversation

**Effort:** Medium (1-2 days) | **Value:** High

---

#### 3. Semantic Memory Search (Hybrid Vector + BM25)
**OpenClaw:** 12-layer memory architecture with:
- Hybrid search: 70% vector (embeddings) + 30% BM25 keyword search (SQLite FTS5)
- Embedding auto-selection: Local (node-llama-cpp) → OpenAI → Gemini → BM25-only fallback
- Temporal decay: stale facts drop in rank despite semantic similarity (configurable half-life)
- Optional knowledge graph plugins (Cognee, Graphiti) for entity/relationship extraction
- Extracted as standalone library "memsearch" (backed by Milvus)

**Our status:** Simple JSON key-value store with category-based filtering and recency sorting. No semantic search. No decay model. Cap at 30 facts in context.

**Recommendation:** Incrementally improve memory:
1. **Phase 1:** Add SQLite FTS5 for keyword search over facts (low effort, big win)
2. **Phase 2:** Add embedding-based semantic search (OpenAI embeddings API or local)
3. **Phase 3:** Add temporal decay weighting to prevent stale facts dominating

**Effort:** Medium-High (3-5 days for phases 1-2) | **Value:** High

---

#### 4. Proactive Heartbeat Monitoring
**OpenClaw:** The Heartbeat component wakes the agent at configurable intervals to proactively check inboxes, run monitors, and trigger actions — without any user prompt. It can monitor Gmail, check RSS feeds, watch file changes, etc.

**Our status:** Scheduler runs cron tasks but each task runs a full agent prompt. No "check and only act if needed" monitoring mode. No inbox monitoring.

**Recommendation:** Add a lightweight "monitor" task type to the scheduler that:
- Runs a check (e.g., new emails since last check, new Trello cards, RSS updates)
- Only triggers full agent processing if something interesting is found
- Supports configurable check scripts/commands

**Effort:** Low-Medium (1 day) | **Value:** Medium

---

#### 5. Event-Driven Webhook Triggers
**OpenClaw:** Webhook system turns the agent into an event-driven automation hub:
- `POST /hooks/wake` — triggers immediate or next-heartbeat wake
- `POST /hooks/agent` — sends prompt to AI for processing
- `POST /hooks/gmail` — specific Gmail notification handler
- Gmail Pub/Sub integration: Email arrives → Gmail Watch API → Google Pub/Sub → webhook → AI processing → notification (seconds, not minutes)
- Token-authenticated, rate-limited, with agent routing in multi-agent setups

**Our status:** Basic `POST /webhook` endpoint that runs a prompt. No event-specific handlers. Gmail uses IMAP polling via skill script. No Pub/Sub integration.

**Recommendation:**
1. Add typed webhook handlers (generic, email, GitHub, etc.) with structured payload parsing
2. Implement Gmail Pub/Sub push notifications to replace IMAP polling
3. Add webhook-to-Telegram notification routing (process event → notify user)

**Effort:** Medium (2-3 days) | **Value:** Medium

---

### Tier 2: Valuable But Higher Effort

#### 6. Multi-Channel Messaging
**OpenClaw:** 50+ channels — WhatsApp, Slack, Discord, Signal, iMessage (BlueBubbles), Google Chat, Teams, Matrix, Feishu, LINE, Mattermost, IRC, Twitch, and more. All through a single Gateway with unified message routing.

**Our status:** Telegram only.

**Recommendation:** If needed, add WhatsApp (via whatsapp-web.js or Twilio API) or Slack as second channel. Abstract the message interface to support multiple transports. However, Telegram-only is fine for a personal assistant.

**Effort:** High (1-2 weeks per channel) | **Value:** Medium (depends on use case)

---

#### 7. Model-Agnostic LLM Support
**OpenClaw:** Bring your own API key for Claude, GPT, Gemini, DeepSeek, Llama, Minimax. Local models via Ollama. OpenRouter auto-routing for cost optimization.

**Our status:** Claude-only via the Claude Code Agent SDK. Model selection limited to Opus/Sonnet/Haiku.

**Recommendation:** The SDK locks us to Claude, which is actually a feature (consistent tool use, session management, etc.). If model diversity is desired, could add a lightweight "ask another model" tool that queries OpenRouter/OpenAI for second opinions without replacing the primary SDK.

**Effort:** Medium | **Value:** Low (Claude is already best-in-class for agent work)

---

#### 8. Multi-Agent Routing
**OpenClaw:** Single Gateway hosts multiple isolated agents, each with its own workspace, persona, tools, sessions, and auth. Binding configuration routes `(channel, account, peer)` → `agentId`. Pre-built 9-agent collaborative kit available.

**Our status:** Single agent, single primary user.

**Recommendation:** Not needed for personal use. If scaling to multiple users/personas, abstract agent creation to support isolated workspaces per agent ID.

**Effort:** High | **Value:** Low (single-user setup)

---

#### 9. Voice: Wake Word + ElevenLabs TTS
**OpenClaw:** Full voice pipeline: Porcupine wake word → Whisper STT → AI → ElevenLabs TTS with streaming playback. Multi-turn follow-up without re-triggering wake word. Custom voice cloning. Self-hosted browser variant available.

**Our status:** Voice messages downloaded as `.ogg` files, sent to agent as file reference. No TTS output. No wake word.

**Recommendation:** Add ElevenLabs TTS for Telegram voice message replies:
1. Agent generates text response
2. Send text to ElevenLabs API → receive audio
3. Send audio as Telegram voice message
Wake word detection doesn't apply to a server-side bot.

**Effort:** Medium (1-2 days for TTS replies) | **Value:** Medium

---

#### 10. Live Canvas / A2UI Visual Workspace
**OpenClaw:** Agent-controlled visual workspace using A2UI protocol. Renders dashboards, forms, whiteboards, debug panels as interactive HTML/CSS/JS pushed over WebSocket. Runs as separate server process (port 18793). Embedded as WKWebView on macOS.

**Our status:** No visual workspace. All output is text via Telegram.

**Recommendation:** Could implement a lightweight web dashboard showing:
- Agent status, active sessions, memory stats
- Scheduled task overview
- Recent conversation summaries
- Cost tracking dashboard
But this is polish, not core functionality.

**Effort:** High | **Value:** Low

---

#### 11. ClawHub-Style Skill Marketplace
**OpenClaw:** 13,700+ community skills on ClawHub with CLI install/search/publish, versioning, vector search, moderation hooks, VirusTotal scanning. Skills are just folders with `SKILL.md` + supporting files.

**Our status:** 7 hand-built skills in `.claude/skills/`. No registry, no discovery, no versioning beyond git.

**Recommendation:** Your skill format (SKILL.md + scripts) is already compatible with the concept. Adding:
1. A skill manifest/registry file listing available skills
2. A `/skills` Telegram command to list/enable/disable skills
3. Git-based skill installation from remote repos
would provide most of the value without the full marketplace infrastructure.

**Effort:** Medium | **Value:** Medium

---

### Tier 3: Already Covered or Not Applicable

| OpenClaw Feature | Our Status | Notes |
|---|---|---|
| Browser automation (CDP) | Playwright MCP | Equivalent capability |
| Cron scheduling | Scheduler with node-cron | Equivalent, 20-task limit |
| Session persistence | Memory + session resumption | Equivalent |
| Systemd deployment | Hardened systemd unit | More secure than OpenClaw's default |
| Location tracking | OwnTracks integration | Unique advantage |
| Cost tracking & budgets | Per-user cost tracking | OpenClaw has none |
| Secret management | Bitwarden integration | More secure than plaintext |
| Tailscale remote access | Used for network access | Equivalent |

---

## What We Do Better Than OpenClaw

1. **Security:** Fail-closed auth, systemd sandboxing, Bitwarden secrets, no public skill registry attack surface. OpenClaw has documented issues (10.8% malicious skills on ClawHub, prompt injection vulnerabilities, plaintext API keys).

2. **Cost management:** Per-request budgets ($5 default), per-user tracking, auto-summaries for expensive runs. OpenClaw has no built-in cost controls (creator spent $10-20K/month out of pocket).

3. **SDK-native tool integration:** MCP servers (Zapier, Trello, Playwright) are first-class SDK tools with proper permission models. OpenClaw wraps raw API calls.

4. **Operational maturity:** Graceful shutdown, stale session recovery, concurrent request prevention, typing indicators with ETA, response chunking. Small but polished.

5. **Location awareness:** OwnTracks GPS integration with real-time memory updates. Not available in OpenClaw out of the box.

---

## Recommended Implementation Roadmap

| Priority | Feature | Effort | Impact |
|---|---|---|---|
| 1 | SOUL.md personality file | 1-2 hours | Quick win, better maintainability |
| 2 | Proactive heartbeat monitors | 1 day | Inbox/feed monitoring without prompts |
| 3 | Session compaction | 1-2 days | Better long conversation quality |
| 4 | SQLite FTS5 memory search | 2-3 days | Better fact retrieval at scale |
| 5 | Webhook event handlers | 2-3 days | Event-driven automation |
| 6 | ElevenLabs TTS replies | 1-2 days | Voice message responses |
| 7 | Skill registry & management | 3-5 days | Better skill organization |
| 8 | Embedding-based semantic search | 3-5 days | Advanced memory retrieval |

Total estimated effort for top 5: ~1-2 weeks of focused work.

---

## Sources

- [GitHub - openclaw/openclaw](https://github.com/openclaw/openclaw)
- [OpenClaw Official Site](https://openclaw.ai/)
- [OpenClaw Docs](https://docs.openclaw.ai/)
- [OpenClaw - Wikipedia](https://en.wikipedia.org/wiki/OpenClaw)
- [Milvus Blog: Complete Guide to OpenClaw](https://milvus.io/blog/openclaw-formerly-clawdbot-moltbot-explained-a-complete-guide-to-the-autonomous-ai-agent.md)
- [DigitalOcean: What is OpenClaw?](https://www.digitalocean.com/resources/articles/what-is-openclaw)
- [CrowdStrike: Security Teams & OpenClaw](https://www.crowdstrike.com/en-us/blog/what-security-teams-need-to-know-about-openclaw-ai-super-agent/)
- [OpenClaw Memory Architecture](https://github.com/coolmanns/openclaw-memory-architecture)
- [OpenClaw Canvas Docs](https://docs.openclaw.ai/platforms/mac/canvas)
- [OpenClaw Multi-Agent Routing](https://docs.openclaw.ai/concepts/multi-agent)
- [OpenClaw Talk Mode](https://docs.openclaw.ai/nodes/talk)
- [OpenClaw Webhooks](https://docs.openclaw.ai/automation/webhook)
- [ClawHub Skill Registry](https://docs.openclaw.ai/tools/clawhub)
- [VoltAgent/awesome-openclaw-skills](https://github.com/VoltAgent/awesome-openclaw-skills)
