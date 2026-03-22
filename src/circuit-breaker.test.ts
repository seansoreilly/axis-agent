import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("./logger.js", () => ({
  info: vi.fn(),
  error: vi.fn(),
}));

vi.mock("./metrics.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./metrics.js")>();
  return { ...orig, metrics: new orig.MetricsRegistry() };
});

describe("CircuitBreaker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("closed state passes through successful calls", async () => {
    const { CircuitBreaker } = await import("./circuit-breaker.js");
    const breaker = new CircuitBreaker({ name: "test", failureThreshold: 3, resetTimeoutMs: 5000 });

    const result = await breaker.execute(() => Promise.resolve("ok"));
    expect(result).toBe("ok");
    expect(breaker.state).toBe("closed");
  });

  it("closed state passes through and records failures", async () => {
    const { CircuitBreaker } = await import("./circuit-breaker.js");
    const breaker = new CircuitBreaker({ name: "test", failureThreshold: 3, resetTimeoutMs: 5000 });

    await expect(breaker.execute(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(breaker.state).toBe("closed");
    expect(breaker.getStatus().failures).toBe(1);
  });

  it("opens after failureThreshold consecutive failures", async () => {
    const { CircuitBreaker } = await import("./circuit-breaker.js");
    const breaker = new CircuitBreaker({ name: "test", failureThreshold: 3, resetTimeoutMs: 5000 });

    for (let i = 0; i < 3; i++) {
      await expect(breaker.execute(() => Promise.reject(new Error("fail")))).rejects.toThrow("fail");
    }
    expect(breaker.state).toBe("open");
  });

  it("open state rejects immediately with CircuitOpenError", async () => {
    const { CircuitBreaker, CircuitOpenError } = await import("./circuit-breaker.js");
    const breaker = new CircuitBreaker({ name: "test", failureThreshold: 2, resetTimeoutMs: 5000 });

    // Trip the breaker
    for (let i = 0; i < 2; i++) {
      await expect(breaker.execute(() => Promise.reject(new Error("fail")))).rejects.toThrow();
    }
    expect(breaker.state).toBe("open");

    // Should reject immediately without calling fn
    const fn = vi.fn<() => Promise<string>>().mockResolvedValue("should not run");
    await expect(breaker.execute(fn)).rejects.toThrow(CircuitOpenError);
    expect(fn).not.toHaveBeenCalled();
  });

  it("transitions to half-open after resetTimeoutMs", async () => {
    const { CircuitBreaker } = await import("./circuit-breaker.js");
    const breaker = new CircuitBreaker({ name: "test", failureThreshold: 2, resetTimeoutMs: 5000 });

    // Trip the breaker
    for (let i = 0; i < 2; i++) {
      await expect(breaker.execute(() => Promise.reject(new Error("fail")))).rejects.toThrow();
    }
    expect(breaker.state).toBe("open");

    // Advance past resetTimeoutMs
    vi.advanceTimersByTime(5001);
    expect(breaker.state).toBe("half-open");
  });

  it("half-open: success transitions to closed", async () => {
    const { CircuitBreaker } = await import("./circuit-breaker.js");
    const breaker = new CircuitBreaker({ name: "test", failureThreshold: 2, resetTimeoutMs: 5000 });

    // Trip the breaker
    for (let i = 0; i < 2; i++) {
      await expect(breaker.execute(() => Promise.reject(new Error("fail")))).rejects.toThrow();
    }

    // Move to half-open
    vi.advanceTimersByTime(5001);
    expect(breaker.state).toBe("half-open");

    // Successful call should close
    const result = await breaker.execute(() => Promise.resolve("recovered"));
    expect(result).toBe("recovered");
    expect(breaker.state).toBe("closed");
  });

  it("half-open: failure transitions back to open", async () => {
    const { CircuitBreaker } = await import("./circuit-breaker.js");
    const breaker = new CircuitBreaker({ name: "test", failureThreshold: 2, resetTimeoutMs: 5000 });

    // Trip the breaker
    for (let i = 0; i < 2; i++) {
      await expect(breaker.execute(() => Promise.reject(new Error("fail")))).rejects.toThrow();
    }

    // Move to half-open
    vi.advanceTimersByTime(5001);
    expect(breaker.state).toBe("half-open");

    // Failed call should re-open
    await expect(breaker.execute(() => Promise.reject(new Error("still broken")))).rejects.toThrow("still broken");
    expect(breaker.state).toBe("open");
  });

  it("successful call resets failure count", async () => {
    const { CircuitBreaker } = await import("./circuit-breaker.js");
    const breaker = new CircuitBreaker({ name: "test", failureThreshold: 3, resetTimeoutMs: 5000 });

    // 2 failures (below threshold)
    await expect(breaker.execute(() => Promise.reject(new Error("fail")))).rejects.toThrow();
    await expect(breaker.execute(() => Promise.reject(new Error("fail")))).rejects.toThrow();
    expect(breaker.getStatus().failures).toBe(2);

    // 1 success resets
    await breaker.execute(() => Promise.resolve("ok"));
    expect(breaker.getStatus().failures).toBe(0);

    // 2 more failures — still below threshold, still closed
    await expect(breaker.execute(() => Promise.reject(new Error("fail")))).rejects.toThrow();
    await expect(breaker.execute(() => Promise.reject(new Error("fail")))).rejects.toThrow();
    expect(breaker.state).toBe("closed");
  });

  it("onStateChange callback fires on transitions", async () => {
    const { CircuitBreaker } = await import("./circuit-breaker.js");
    const onChange = vi.fn();
    const breaker = new CircuitBreaker({
      name: "test",
      failureThreshold: 2,
      resetTimeoutMs: 5000,
      onStateChange: onChange,
    });

    // Trip: closed → open
    for (let i = 0; i < 2; i++) {
      await expect(breaker.execute(() => Promise.reject(new Error("fail")))).rejects.toThrow();
    }
    expect(onChange).toHaveBeenCalledWith("test", "closed", "open");

    // Wait: open → half-open
    vi.advanceTimersByTime(5001);
    // State getter triggers lazy transition
    expect(breaker.state).toBe("half-open");
    expect(onChange).toHaveBeenCalledWith("test", "open", "half-open");

    // Succeed: half-open → closed
    await breaker.execute(() => Promise.resolve("ok"));
    expect(onChange).toHaveBeenCalledWith("test", "half-open", "closed");

    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it("reset() returns to closed state", async () => {
    const { CircuitBreaker } = await import("./circuit-breaker.js");
    const breaker = new CircuitBreaker({ name: "test", failureThreshold: 2, resetTimeoutMs: 5000 });

    // Trip
    for (let i = 0; i < 2; i++) {
      await expect(breaker.execute(() => Promise.reject(new Error("fail")))).rejects.toThrow();
    }
    expect(breaker.state).toBe("open");

    breaker.reset();
    expect(breaker.state).toBe("closed");
    expect(breaker.getStatus().failures).toBe(0);

    // Should work again
    const result = await breaker.execute(() => Promise.resolve("back"));
    expect(result).toBe("back");
  });

  it("getStatus() returns current state info", async () => {
    const { CircuitBreaker } = await import("./circuit-breaker.js");
    vi.setSystemTime(new Date("2026-03-22T10:00:00Z"));
    const breaker = new CircuitBreaker({ name: "myservice", failureThreshold: 3, resetTimeoutMs: 5000 });

    // Initial status
    let status = breaker.getStatus();
    expect(status.name).toBe("myservice");
    expect(status.state).toBe("closed");
    expect(status.failures).toBe(0);
    expect(status.lastFailureAt).toBeNull();

    // After a failure
    await expect(breaker.execute(() => Promise.reject(new Error("oops")))).rejects.toThrow();
    status = breaker.getStatus();
    expect(status.failures).toBe(1);
    expect(status.lastFailureAt).toBe("2026-03-22T10:00:00.000Z");
  });

  it("metrics are incremented correctly", async () => {
    const { metrics } = await import("./metrics.js");
    const { CircuitBreaker } = await import("./circuit-breaker.js");
    const breaker = new CircuitBreaker({ name: "svc", failureThreshold: 2, resetTimeoutMs: 5000 });

    // Successful execution
    await breaker.execute(() => Promise.resolve("ok"));
    let snap = metrics.snapshot();
    expect(snap.counters["circuit_breaker.svc.executions"]).toBe(1);

    // Failed execution
    await expect(breaker.execute(() => Promise.reject(new Error("fail")))).rejects.toThrow();
    snap = metrics.snapshot();
    expect(snap.counters["circuit_breaker.svc.executions"]).toBe(2);
    expect(snap.counters["circuit_breaker.svc.failures"]).toBe(1);

    // Trip it
    await expect(breaker.execute(() => Promise.reject(new Error("fail")))).rejects.toThrow();
    snap = metrics.snapshot();
    expect(snap.gauges["circuit_breaker.svc.state"]).toBe(1); // open

    // Rejected execution
    await expect(breaker.execute(() => Promise.resolve("nope"))).rejects.toThrow();
    snap = metrics.snapshot();
    expect(snap.counters["circuit_breaker.svc.rejected"]).toBe(1);
  });
});
