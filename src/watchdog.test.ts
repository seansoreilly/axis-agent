import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { HealthCheck, HealthCheckResult, WatchdogOptions } from "./watchdog.js";

describe("HealthWatchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function passingCheck(name: string, severity: "warning" | "critical" = "warning"): HealthCheck {
    return {
      name,
      severity,
      check: () => ({ healthy: true, detail: "ok" }),
    };
  }

  function failingCheck(name: string, severity: "warning" | "critical" = "warning"): HealthCheck {
    return {
      name,
      severity,
      check: () => ({ healthy: false, detail: `${name} is broken` }),
    };
  }

  it("getStatus() returns 'ok' when all checks pass", async () => {
    const { HealthWatchdog } = await import("./watchdog.js");
    const watchdog = new HealthWatchdog({
      checks: [passingCheck("mem"), passingCheck("jobs")],
    });
    watchdog.runChecks();
    const status = watchdog.getStatus();
    expect(status.status).toBe("ok");
    expect(status.checks.every((c) => c.healthy)).toBe(true);
  });

  it("getStatus() returns 'degraded' when a warning check fails", async () => {
    const { HealthWatchdog } = await import("./watchdog.js");
    const watchdog = new HealthWatchdog({
      checks: [passingCheck("mem"), failingCheck("errors", "warning")],
    });
    watchdog.runChecks();
    const status = watchdog.getStatus();
    expect(status.status).toBe("degraded");
  });

  it("getStatus() returns 'critical' when a critical check fails", async () => {
    const { HealthWatchdog } = await import("./watchdog.js");
    const watchdog = new HealthWatchdog({
      checks: [passingCheck("mem"), failingCheck("jobs", "critical")],
    });
    watchdog.runChecks();
    const status = watchdog.getStatus();
    expect(status.status).toBe("critical");
  });

  it("alert callback fires after N consecutive failures (default 3)", async () => {
    const { HealthWatchdog } = await import("./watchdog.js");
    const onAlert = vi.fn();
    const watchdog = new HealthWatchdog({
      checks: [failingCheck("db", "critical")],
      onAlert,
    });

    watchdog.runChecks(); // failure 1
    expect(onAlert).not.toHaveBeenCalled();
    watchdog.runChecks(); // failure 2
    expect(onAlert).not.toHaveBeenCalled();
    watchdog.runChecks(); // failure 3 — alert fires
    expect(onAlert).toHaveBeenCalledWith("db", "db is broken");
  });

  it("alert does NOT fire if check recovers before threshold", async () => {
    const { HealthWatchdog } = await import("./watchdog.js");
    const onAlert = vi.fn();
    let healthy = false;
    const toggleCheck: HealthCheck = {
      name: "flaky",
      severity: "critical",
      check: () => ({ healthy, detail: healthy ? "ok" : "down" }),
    };
    const watchdog = new HealthWatchdog({
      checks: [toggleCheck],
      onAlert,
    });

    watchdog.runChecks(); // failure 1
    watchdog.runChecks(); // failure 2
    healthy = true;
    watchdog.runChecks(); // recovered — counter resets
    healthy = false;
    watchdog.runChecks(); // failure 1 again
    watchdog.runChecks(); // failure 2
    expect(onAlert).not.toHaveBeenCalled();
  });

  it("start() runs checks on interval, stop() clears the interval", async () => {
    const { HealthWatchdog } = await import("./watchdog.js");
    const checkFn = vi.fn<() => HealthCheckResult>().mockReturnValue({ healthy: true, detail: "ok" });
    const watchdog = new HealthWatchdog({
      checks: [{ name: "test", severity: "warning", check: checkFn }],
      intervalMs: 1000,
    });

    watchdog.start();
    // Initial call on start
    expect(checkFn).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000);
    expect(checkFn).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(1000);
    expect(checkFn).toHaveBeenCalledTimes(3);

    watchdog.stop();
    vi.advanceTimersByTime(5000);
    expect(checkFn).toHaveBeenCalledTimes(3); // no more calls after stop
  });

  it("lastCheckAt updates after each check cycle", async () => {
    const { HealthWatchdog } = await import("./watchdog.js");
    const watchdog = new HealthWatchdog({
      checks: [passingCheck("mem")],
    });

    expect(watchdog.getStatus().lastCheckAt).toBeNull();

    vi.setSystemTime(new Date("2026-03-22T10:00:00Z"));
    watchdog.runChecks();
    expect(watchdog.getStatus().lastCheckAt).toBe("2026-03-22T10:00:00.000Z");

    vi.setSystemTime(new Date("2026-03-22T10:01:00Z"));
    watchdog.runChecks();
    expect(watchdog.getStatus().lastCheckAt).toBe("2026-03-22T10:01:00.000Z");
  });

  it("multiple checks: overall status is the worst severity", async () => {
    const { HealthWatchdog } = await import("./watchdog.js");
    const watchdog = new HealthWatchdog({
      checks: [
        passingCheck("mem"),
        failingCheck("errors", "warning"),
        failingCheck("db", "critical"),
      ],
    });
    watchdog.runChecks();
    const status = watchdog.getStatus();
    expect(status.status).toBe("critical");
  });

  it("tracks consecutive failures per check independently", async () => {
    const { HealthWatchdog } = await import("./watchdog.js");
    const onAlert = vi.fn();
    const watchdog = new HealthWatchdog({
      checks: [
        failingCheck("a", "critical"),
        passingCheck("b", "critical"),
      ],
      onAlert,
      alertThreshold: 2,
    });

    watchdog.runChecks();
    watchdog.runChecks();

    // Only "a" should have triggered the alert
    expect(onAlert).toHaveBeenCalledTimes(1);
    expect(onAlert).toHaveBeenCalledWith("a", "a is broken");

    const status = watchdog.getStatus();
    const checkA = status.checks.find((c) => c.name === "a");
    const checkB = status.checks.find((c) => c.name === "b");
    expect(checkA?.consecutiveFailures).toBe(2);
    expect(checkB?.consecutiveFailures).toBe(0);
  });
});

