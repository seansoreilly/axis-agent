# Security Review — Full Codebase

**Date:** 2026-03-10
**Reviewer:** Claude Opus 4.6 (automated)
**Scope:** Complete codebase audit (`src/**/*.ts`, configuration, shell scripts)

## Result: No High-Confidence Vulnerabilities Found

After a comprehensive security review of the entire codebase, **no vulnerabilities meeting the reporting threshold (confidence >= 8/10) were identified**.

## Analysis Summary

| Area | Files Reviewed | Finding |
|------|---------------|---------|
| **SQL Injection** | `src/persistence.ts` | All queries use parameterized statements (`?` placeholders) — **safe** |
| **Command Injection** | `src/scheduler.ts` (`runCheckCommand`) | Uses `exec()`, but `checkCommand` is not settable via any public API (Telegram or Gateway) — **no attack surface** |
| **Path Traversal** | `src/telegram-media.ts`, `src/telegram.ts` | File paths derived from Telegram API responses (trusted), temp files use `Date.now()` naming — **safe** |
| **Authentication** | `src/gateway.ts` | Bearer token auth on protected routes, OwnTracks supports both Bearer and Basic auth with correct parsing — **safe** |
| **Authorization** | `src/telegram.ts` | Fail-closed allowlist (`TELEGRAM_ALLOWED_USERS`), crashes on empty list — **safe** |
| **Input Validation** | `src/gateway.ts`, `src/scheduler.ts` | Cron expressions validated, body size limited (10KB), rate limiting applied — **safe** |
| **Data Exposure** | All source files | No hardcoded secrets in source; credentials loaded from env vars and external files — **safe** |
| **XSS** | `src/gateway.ts` | API-only server (no HTML rendering), Helmet security headers enabled — **N/A** |

## Investigated and Dismissed Findings

### Scheduler `checkCommand` (Command Injection) — Confidence: 2/10

- `runCheckCommand()` uses `exec()` which spawns `/bin/sh -c`
- However, `checkCommand` cannot be set through any public interface (not in Telegram `/schedule` handler, not in Gateway `POST /tasks` body schema)
- Only settable via direct database manipulation (admin access required)
- **Verdict: False positive** — no user-controlled input reaches `exec()`

## Positive Security Observations

- All SQLite queries are parameterized
- Gateway uses `@fastify/helmet` and `@fastify/rate-limit`
- Telegram auth is fail-closed (empty allowlist = crash)
- Systemd hardening with `ProtectHome=read-only`, `NoNewPrivileges=true`
- Secrets managed via Bitwarden, not committed to source
