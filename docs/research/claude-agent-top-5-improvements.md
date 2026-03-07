# Claude Agent: Top 5 Improvements

> Research date: 2026-03-06
> Scope: clean-code improvements that also unlock useful new capabilities
> Test status: `npm test` passed locally (`49/49`)

## Summary

The agent is already in a good place operationally: small codebase, clear module boundaries at the top level, and strong feature density for a single-process service. The main limitation is that several important behaviors are still concentrated in a few large classes and string-built prompts, which makes new features slower to add and harder to validate.

The best next step is not a rewrite. It is a targeted refactor of the orchestration layer, persistence layer, and integration surface so new capabilities can be added without continuing to grow `src/telegram.ts` and `src/agent.ts`.

---

## 1. Split `TelegramIntegration` into a message pipeline, command registry, and media service

**Why this is the highest-value clean-code change**

`src/telegram.ts` currently owns transport concerns, message normalization, file download, temp-file lifecycle, location persistence, progress updates, session handling, and command execution in one class. The concentration starts immediately in [`src/telegram.ts:54`](/home/sean/projects/claude-code-agent/src/telegram.ts#L54) and the message handler becomes a large workflow hub at [`src/telegram.ts:234`](/home/sean/projects/claude-code-agent/src/telegram.ts#L234).

**Problems today**

- One class is responsible for too many policies.
- Adding one new command or media type likely touches multiple branches in the same file.
- Behavior is harder to unit test in isolation because transport and business rules are interleaved.

**Recommended change**

Split Telegram handling into:

- `telegram/transport.ts`: raw bot wiring, polling, send/edit/delete wrappers
- `telegram/message-normalizer.ts`: convert Telegram messages into one internal input shape
- `telegram/command-registry.ts`: command metadata plus handlers
- `telegram/media-store.ts`: download, temp-path allocation, cleanup, size/type validation
- `telegram/session-service.ts`: concurrency, retries, resume, progress updates

**New features unlocked**

- Easier addition of new transports later (Slack/WhatsApp/web chat) because agent-facing input becomes transport-agnostic.
- Better media support: audio transcription, image batching, attachment validation, file-size limits, per-type processors.
- Safer admin commands such as `/skills`, `/sessions`, `/approve`, `/jobs`.

**Expected impact**

This reduces feature friction more than any other single refactor in the repo.

---

## 2. Replace ad hoc JSON persistence with repositories and atomic storage, then move to SQLite

**Why this matters**

`src/memory.ts` and `src/scheduler.ts` both use direct JSON file reads and writes as the source of truth. Examples are in [`src/memory.ts:134`](/home/sean/projects/claude-code-agent/src/memory.ts#L134), [`src/memory.ts:164`](/home/sean/projects/claude-code-agent/src/memory.ts#L164), and [`src/scheduler.ts:82`](/home/sean/projects/claude-code-agent/src/scheduler.ts#L82). This is fine for bootstrap simplicity, but it is starting to carry product cost.

**Problems today**

- Persistence logic is embedded directly in domain classes.
- Writes are not obviously atomic.
- Query capability is weak once facts, sessions, and tasks grow.
- `getFact()` mutates `lastAccessedAt` in memory without persisting it, which means read metadata is only partially trustworthy; see [`src/memory.ts:181`](/home/sean/projects/claude-code-agent/src/memory.ts#L181).

**Recommended change**

Do this in two stages:

1. Introduce repository interfaces now:
   - `FactRepository`
   - `SessionRepository`
   - `TaskRepository`
2. Back those repositories with SQLite next:
   - facts table
   - sessions table
   - scheduled_tasks table
   - event_log table

Use transactions and atomic updates rather than whole-file rewrites.

**New features unlocked**

- Searchable memory and scheduled-task history.
- Better `/status` and future dashboard views.
- Audit trail for “what happened and why”.
- Easier migration to semantic search or FTS later.

**Expected impact**

This is the most important infrastructure change for long-term maintainability.

---

## 3. Turn the scheduler and webhooks into a durable job system

**Why this matters**

The current scheduling and event flow is intentionally lightweight, but it is also fragile for richer automation. The scheduler serializes all tasks behind one boolean gate at [`src/scheduler.ts:56`](/home/sean/projects/claude-code-agent/src/scheduler.ts#L56) and [`src/scheduler.ts:133`](/home/sean/projects/claude-code-agent/src/scheduler.ts#L133). The gateway is similarly thin, with a generic `/webhook` and basic task CRUD in [`src/gateway.ts:62`](/home/sean/projects/claude-code-agent/src/gateway.ts#L62).

**Problems today**

- A single long-running task blocks every other scheduled task.
- No retry policy, job history, deduplication, or delivery guarantees.
- Webhooks trigger work directly instead of creating tracked jobs.

**Recommended change**

Introduce a small internal job model:

- `queued | running | succeeded | failed | cancelled`
- persisted job payloads
- retry count + backoff
- correlation IDs for webhook-originated work

Keep the runtime simple. This does not require a distributed queue. SQLite-backed jobs plus one worker loop is enough.

**New features unlocked**

- Event-driven automation: GitHub webhooks, email ingestion, RSS monitors, price alerts.
- A `/jobs` command or dashboard view for current and failed work.
- Safe future additions like “approve before sending email/SMS/posting”.

**Expected impact**

This is the cleanest way to expand beyond “chat bot plus cron” into a real automation agent.

---

## 4. Make prompt construction data-driven instead of hardcoded string assembly

**Why this matters**

`src/agent.ts` contains a large amount of policy encoded as inline string arrays. The core prompt starts at [`src/agent.ts:125`](/home/sean/projects/claude-code-agent/src/agent.ts#L125) and the extended prompt starts at [`src/agent.ts:219`](/home/sean/projects/claude-code-agent/src/agent.ts#L219). This works, but it is already large enough that consistency becomes a maintenance problem.

**Problems today**

- Capabilities, commands, routing rules, and integration docs are duplicated in prose.
- It is easy for README, `CLAUDE.md`, and the runtime prompt to drift.
- New commands/features require careful multi-file prompt edits.

**Recommended change**

Move prompt inputs into structured metadata:

- command definitions
- enabled integrations
- model-routing rules
- memory policy sections
- feature flags

Then render the final prompt from templates plus metadata. Keep `SOUL.md` for persona, but move operational facts into typed config.

**New features unlocked**

- `/capabilities` or `/help` generated from the same source as the system prompt.
- Easier per-user or per-mode prompt variants.
- Safer future experimentation with feature flags and A/B prompt changes.

**Expected impact**

This will slow prompt sprawl and make the agent easier to reason about as features grow.

---

## 5. Add an observability and operator UX layer: metrics, audit log, and lightweight dashboard

**Why this is the best product-facing feature addition**

The service is operationally important, but the current visibility surface is minimal: plain text logging in [`src/logger.ts:1`](/home/sean/projects/claude-code-agent/src/logger.ts#L1) and a basic health endpoint in [`src/gateway.ts:56`](/home/sean/projects/claude-code-agent/src/gateway.ts#L56). Startup orchestration in [`src/index.ts:10`](/home/sean/projects/claude-code-agent/src/index.ts#L10) also wires several important flows with no central runtime state view.

**Problems today**

- Hard to inspect recent runs, failures, retries, and costs without reading logs.
- No structured event stream for later debugging.
- No operator-facing surface for sessions, jobs, tasks, or integrations.

**Recommended change**

Add:

- structured JSON logging
- metrics counters/timers
- a small `/admin` or `/debug` HTTP surface
- a lightweight web dashboard for:
  - current sessions
  - recent jobs
  - task history
  - cost by user/day
  - integration health

**New features unlocked**

- Faster debugging when the SDK, Telegram, or external tools misbehave.
- Human approval flows for risky actions.
- Better product polish if you ever expose this beyond a single trusted user.

**Expected impact**

This is the highest-value new feature for day-2 operations because it improves reliability, not just capability count.

---

## Recommended Order

1. Refactor Telegram into smaller services.
2. Introduce repository interfaces and move persistence toward SQLite.
3. Add a durable job model for scheduler and webhooks.
4. Convert prompt assembly to metadata + templates.
5. Build observability on top of the new repositories and job history.

## Bottom Line

The agent does not need more random integrations right now. It needs a stronger internal platform so new integrations and automations land cleanly. If you only do two things next, do `TelegramIntegration` decomposition and persistence/job-system cleanup first. Those two changes will make almost every future feature cheaper to ship and safer to operate.
