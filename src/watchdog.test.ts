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

describe("Health check factories", () => {
  it("memoryCheck() returns healthy when heap under limit", async () => {
    const { memoryCheck } = await import("./watchdog.js");
    // Current heap should be well under 4096 MB
    const check = memoryCheck(4096);
    const result = check.check();
    expect(result.healthy).toBe(true);
    expect(result.detail).toContain("MB");
  });

  it("memoryCheck() returns unhealthy when heap over limit", async () => {
    const { memoryCheck } = await import("./watchdog.js");
    // 0 MB limit — always over
    const check = memoryCheck(0);
    const result = check.check();
    expect(result.healthy).toBe(false);
  });

  it("jobQueueCheck() returns unhealthy when stuck jobs exist", async () => {
    const { jobQueueCheck } = await import("./watchdog.js");
    const mockStore = {
      getStuckJobs: vi.fn().mockReturnValue([
        { id: "j1", status: "running", startedAt: "2026-03-22T09:00:00Z" },
      ]),
    };
    const check = jobQueueCheck(mockStore as unknown as import("./persistence.js").SqliteStore);
    const result = check.check();
    expect(result.healthy).toBe(false);
    expect(result.detail).toContain("1");
  });

  it("jobQueueCheck() returns healthy when no stuck jobs", async () => {
    const { jobQueueCheck } = await import("./watchdog.js");
    const mockStore = {
      getStuckJobs: vi.fn().mockReturnValue([]),
    };
    const check = jobQueueCheck(mockStore as unknown as import("./persistence.js").SqliteStore);
    const result = check.check();
    expect(result.healthy).toBe(true);
  });

  it("errorRateCheck() returns unhealthy when error rate exceeds threshold", async () => {
    const { errorRateCheck } = await import("./watchdog.js");
    const { MetricsRegistry } = await import("./metrics.js");
    const reg = new MetricsRegistry();
    reg.increment("agent.errors", 10);
    reg.increment("agent.requests", 20);
    // Error rate = 10/20 = 0.5, threshold 0.3
    const check = errorRateCheck(reg, 0.3);
    const result = check.check();
    expect(result.healthy).toBe(false);
    expect(result.detail).toContain("50");
  });

  it("errorRateCheck() returns healthy when error rate is below threshold", async () => {
    const { errorRateCheck } = await import("./watchdog.js");
    const { MetricsRegistry } = await import("./metrics.js");
    const reg = new MetricsRegistry();
    reg.increment("agent.errors", 1);
    reg.increment("agent.requests", 100);
    // Error rate = 0.01, threshold 0.3
    const check = errorRateCheck(reg, 0.3);
    const result = check.check();
    expect(result.healthy).toBe(true);
  });

  it("errorRateCheck() returns healthy when no requests yet", async () => {
    const { errorRateCheck } = await import("./watchdog.js");
    const { MetricsRegistry } = await import("./metrics.js");
    const reg = new MetricsRegistry();
    const check = errorRateCheck(reg, 0.3);
    const result = check.check();
    expect(result.healthy).toBe(true);
  });
});
