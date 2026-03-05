# Agent Auto-Recovery Improvements

Ideas for improving the agent's ability to self-recover from failures without manual intervention.

**Context**: The agent experienced a multi-hour outage (2026-03-05) caused by an expired OAuth token. The refresh token was also invalid, requiring manual re-authentication. This exposed gaps in the recovery pipeline.

**Current recovery mechanisms**:
- `self-heal.sh` systemd timer — restarts service if inactive (every 5 min)
- `claude-token-refresh.timer` — refreshes OAuth token hourly (independent of agent process)
- In-process `setInterval` — refreshes token every 30 min while running
- Pre-flight `ensureValidToken()` — checks before every `query()` call
- GitHub Actions health check — every 30 min, restarts or reboots if needed

---

## 1. Health-Aware Self-Restart with Diagnostics

Before restarting, the self-heal script runs a diagnostic checklist (token validity, disk space, memory, network connectivity to api.anthropic.com). Logs the specific failure reason so you know *why* it died, not just that it died. If the fix is known (e.g. expired token), fix it before restarting instead of blindly restarting into the same failure.

**Effort**: Low. Extend `self-heal.sh` with pre-restart checks.

## 2. Telegram Dead-Man's Switch

The agent sends itself a heartbeat message every 30 minutes via the Telegram API. A lightweight external monitor (GitHub Actions or a separate cron) checks the timestamp of the last heartbeat. If stale by >1 hour, it SSHs in and restarts. This catches cases where the process is running but wedged (e.g., stuck in an infinite loop, blocked on I/O).

**Effort**: Medium. Needs a heartbeat sender in-process + external monitor logic.

## 3. Credential Health Monitoring with Telegram Alerts

The token refresh timer sends a Telegram notification when refresh fails, giving immediate awareness. Also alert when: refresh token is within 24h of expiry, disk >90%, memory >90%, or SDK version is outdated. Shifts from reactive ("why isn't it working?") to proactive ("fix this before it breaks").

**Effort**: Low-Medium. Add `curl` Telegram API call to `refresh-token.sh` on failure.

## 4. Graceful Degradation Mode

When auth is broken, instead of returning "internal error" on every message, the agent enters a degraded mode: acknowledges messages, queues them, and replies "Auth expired — I'll process this when credentials are refreshed." Once the token refresh timer succeeds, it processes the queued messages automatically.

**Effort**: Medium. Needs auth state tracking in-process, message queue, and drain logic.

## 5. Auto-Reauthentication via Stored Refresh Chain

Store a backup copy of the refresh token encrypted at rest. When the primary refresh fails, attempt with the backup. Also implement refresh token rotation tracking — each time a new refresh token is issued, log the old one's lifetime to detect patterns (e.g., "refresh tokens expire every 12h") and adjust the refresh interval accordingly.

**Effort**: Medium. Needs encrypted storage, rotation tracking, and adaptive scheduling.

---

## Priority Recommendation

1. **#3 (Telegram alerts)** — highest ROI, lowest effort. Know immediately when auth breaks.
2. **#1 (diagnostic restart)** — stop blind restarts, fix root causes automatically.
3. **#4 (graceful degradation)** — better UX during outages.
4. **#2 (dead-man's switch)** — catches wedged processes.
5. **#5 (refresh chain)** — defense in depth for token management.
