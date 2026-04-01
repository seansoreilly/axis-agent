import { existsSync, accessSync, constants } from "node:fs";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { info, error as logError } from "./logger.js";
import { errorMessage } from "./utils.js";
import { tokenNeedsRefresh } from "./auth.js";

interface PreflightResult {
  ok: boolean;
  checks: Array<{ name: string; passed: boolean; message?: string }>;
}

/**
 * Run preflight health checks before starting the agent.
 * Returns a result object with pass/fail for each check.
 * Does not throw — callers decide whether to abort on failures.
 */
export async function preflight(opts: {
  memoryDir: string;
  workDir: string;
  telegramBotToken: string;
}): Promise<PreflightResult> {
  const checks: PreflightResult["checks"] = [];

  // 1. Check work directory is writable
  try {
    accessSync(opts.workDir, constants.W_OK);
    checks.push({ name: "work-dir-writable", passed: true });
  } catch {
    checks.push({
      name: "work-dir-writable",
      passed: false,
      message: `Work directory not writable: ${opts.workDir}. Check ReadWritePaths in systemd unit.`,
    });
  }

  // 2. Check memory directory is writable
  try {
    accessSync(opts.memoryDir, constants.W_OK);
    checks.push({ name: "memory-dir-writable", passed: true });
  } catch {
    checks.push({
      name: "memory-dir-writable",
      passed: false,
      message: `Memory directory not writable: ${opts.memoryDir}. Check ReadWritePaths in systemd unit.`,
    });
  }

  // 3. Check OAuth credentials exist and token is not expired
  const credentialsPath = join(homedir(), ".claude", ".credentials.json");
  if (!existsSync(credentialsPath)) {
    checks.push({
      name: "oauth-credentials",
      passed: false,
      message: `OAuth credentials not found at ${credentialsPath}. Run sync-secrets.sh or authenticate manually.`,
    });
  } else if (tokenNeedsRefresh()) {
    checks.push({
      name: "oauth-credentials",
      passed: true,
      message: "OAuth token needs refresh (will be attempted automatically).",
    });
  } else {
    checks.push({ name: "oauth-credentials", passed: true });
  }

  // 4. Check .claude directory is writable (SDK writes here)
  const claudeDir = join(homedir(), ".claude");
  try {
    accessSync(claudeDir, constants.W_OK);
    checks.push({ name: "claude-dir-writable", passed: true });
  } catch {
    checks.push({
      name: "claude-dir-writable",
      passed: false,
      message: `~/.claude not writable. The SDK needs write access. Add to ReadWritePaths in systemd unit.`,
    });
  }

  // 5. Check Telegram bot token looks valid (basic format check)
  if (/^\d+:[A-Za-z0-9_-]{35,}$/.test(opts.telegramBotToken)) {
    checks.push({ name: "telegram-token-format", passed: true });
  } else {
    checks.push({
      name: "telegram-token-format",
      passed: false,
      message: "TELEGRAM_BOT_TOKEN does not match expected format (number:alphanumeric).",
    });
  }

  // 6. Check Telegram API is reachable
  try {
    const resp = await fetch(
      `https://api.telegram.org/bot${opts.telegramBotToken}/getMe`,
      { signal: AbortSignal.timeout(10_000) }
    );
    if (resp.ok) {
      checks.push({ name: "telegram-api-reachable", passed: true });
    } else {
      checks.push({
        name: "telegram-api-reachable",
        passed: false,
        message: `Telegram API returned ${resp.status}. Check TELEGRAM_BOT_TOKEN.`,
      });
    }
  } catch (err) {
    checks.push({
      name: "telegram-api-reachable",
      passed: false,
      message: `Cannot reach Telegram API: ${errorMessage(err)}`,
    });
  }

  // 7. Check gws People API is working
  try {
    const gwsResult = await new Promise<string>((resolve, reject) => {
      execFile(
        "gws",
        ["people", "people", "searchContacts", "--params", '{"query":"test","readMask":"names"}'],
        { timeout: 10_000 },
        (err, stdout, stderr) => {
          if (err) reject(new Error(stderr || err.message));
          else resolve(stdout);
        },
      );
    });
    // A valid response is JSON (even if empty `{}`). An auth error returns {"error":...}
    const parsed = JSON.parse(gwsResult);
    if (parsed.error) {
      checks.push({
        name: "gws-contacts",
        passed: false,
        message: `gws People API auth failed: ${parsed.error.message ?? "unknown error"}. Check gws OAuth credentials.`,
      });
    } else {
      checks.push({ name: "gws-contacts", passed: true });
    }
  } catch (err) {
    checks.push({
      name: "gws-contacts",
      passed: false,
      message: `gws CLI not reachable: ${errorMessage(err)}`,
    });
  }

  // Log results
  const failed = checks.filter((c) => !c.passed);
  const ok = failed.length === 0;

  for (const check of checks) {
    if (check.passed) {
      info("preflight", `[PASS] ${check.name}${check.message ? ` — ${check.message}` : ""}`);
    } else {
      logError("preflight", `[FAIL] ${check.name} — ${check.message}`);
    }
  }

  if (ok) {
    info("preflight", "All checks passed.");
  } else {
    logError("preflight", `${failed.length} check(s) failed. Agent may not function correctly.`);
  }

  return { ok, checks };
}
