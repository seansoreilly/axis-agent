# Top 5 NemoClaw-Inspired Improvements for Axis Agent

## Context

[NemoClaw](https://github.com/NVIDIA/NemoClaw) is NVIDIA's open-source governance layer for AI coding agents (announced GTC 2026). It wraps OpenClaw with enterprise-grade security: kernel-level sandboxing, declarative YAML policies, a privacy router for model selection by data sensitivity, and per-agent isolation. While Axis Agent doesn't need enterprise k8s infrastructure, several NemoClaw patterns address real gaps in the current codebase.

---

## 1. Per-User Permission Scoping (Priority: Highest)

**Inspired by**: NemoClaw's per-agent isolation with scoped permissions (principle of least privilege)

**Problem**: Every user gets identical broad tool access (`Read, Write, Edit, Bash, Glob, Grep, WebSearch, WebFetch, Task, mcp__*`). The `mcp__*` wildcard grants access to every MCP server. Critically, `checkPromptForSensitiveFiles()` only runs for jobs — Telegram messages bypass it entirely.

**Changes**:
- **Immediate fix** (~5 lines): Add `checkPromptForSensitiveFiles()` call in `src/telegram.ts` before dispatching to agent
- New file: `user-permissions.yaml` — maps user IDs to allowed tools, budget limits, model access
- New file: `src/user-permissions.ts` (~100 lines) — loads YAML, resolves effective permissions per userId
- Modify `src/agent.ts` — resolve user permissions in `run()`, pass scoped `allowedTools`
- Modify `src/persistent-process.ts` — accept per-user `allowedTools` override
- Backward-compatible: if YAML absent, current behavior preserved

## 2. Circuit Breaker with Failure Tracking (Priority: High)

**Inspired by**: NemoClaw's out-of-process enforcement — infrastructure safeguards that work regardless of agent behavior

**Problem**: No circuit breaker anywhere. If Claude API is down, every user message and scheduled task independently discovers this. `JobService` retries with linear backoff but has no global failure awareness.

**Changes**:
- New file: `src/circuit-breaker.ts` (~80 lines) — three-state breaker (closed/open/half-open) with configurable thresholds
- Two instances: **Agent breaker** (wraps CLI spawning) and **Service breaker** (wraps external calls)
- Modify `src/agent.ts` — wrap `runOneShot`/`runPersistent` with breaker
- Modify `src/jobs.ts` — check breaker state before processing (skip if open, requeue with backoff)
- Modify `src/gateway.ts` — expose breaker state in `/admin/status`
- Telegram notification when breaker opens

## 3. Declarative YAML Policy Engine (Priority: High)

**Inspired by**: NemoClaw's declarative YAML policies, version-controlled and independently evolvable

**Problem**: Policies in `src/policies.ts` are hardcoded regex arrays. Easily bypassed via obfuscation (base64, path traversal). Adding/modifying a policy requires code change + rebuild + deploy.

**Changes**:
- New file: `policies.yaml` — defines blocked commands, sensitive paths, allowed write paths
- New file: `src/policy-engine.ts` (~150 lines) — loads/validates YAML, provides same interfaces
- `src/policies.ts` becomes thin wrapper delegating to `PolicyEngine`
- Hot reload via `SIGHUP` signal in `src/index.ts`
- JSON Schema validation at startup (crash fast on invalid config)

## 4. Request Correlation and Structured Observability (Priority: Medium)

**Inspired by**: NemoClaw's per-agent traceability — every action attributable to a specific context

**Problem**: No correlation ID across the request lifecycle. When Telegram → agent → CLI → job, there's no way to trace the chain. `MetricsRegistry` is 27 lines of in-memory counters, lost on restart.

**Changes**:
- Modify `src/logger.ts` — add optional `correlationId` field, `createLogger(correlationId)` factory
- Modify `src/telegram.ts` — generate correlationId at message receipt
- Thread correlationId through `src/agent.ts` → `src/jobs.ts` → events/logs
- Modify `src/metrics.ts` — add `histogram()` for duration tracking, periodic SQLite flush
- New table: `metrics_snapshots` in `src/persistence.ts`

## 5. Health Watchdog (Priority: Medium)

**Inspired by**: NemoClaw's infrastructure-level monitoring independent of the agent

**Problem**: If the agent enters a degraded state (CLI timeouts, token refresh failing, process leaks), systemd sees Node.js as healthy and does nothing. No self-diagnosis capability.

**Changes**:
- New file: `src/watchdog.ts` (~120 lines) — runs every 60s, evaluates health checks
- Built-in checks: process leak detection, job queue depth, auth health, error rate, memory usage
- Critical failures (3 consecutive) trigger Telegram alert to primary user
- Modify `src/gateway.ts` — `/health` returns detailed check results (`ok`/`degraded`)
- Wire up in `src/index.ts` with shutdown cleanup

---

## Implementation Order

1. **Per-User Permissions** — closes a real security gap with a 5-line immediate fix
2. **Circuit Breaker** — small, self-contained, immediately valuable
3. **YAML Policy Engine** — incremental: externalize existing patterns first, extend later
4. **Correlation IDs** — touches many files but each change is small
5. **Health Watchdog** — most useful after better metrics and circuit breaker exist

**Estimated total effort**: 3-4 days

## Verification

- Run `npm test` after each improvement (existing test suite)
- Manual Telegram testing: send messages that would trigger policy checks
- Hit `/admin/status` and `/health` endpoints to verify new observability data
- Test circuit breaker by temporarily misconfiguring auth, verify it trips and recovers
- Test YAML hot reload via `kill -HUP <pid>`
