import { describe, it, expect, beforeEach } from "vitest";
import { MetricsRegistry } from "./metrics.js";

describe("MetricsRegistry", () => {
  let registry: MetricsRegistry;

  beforeEach(() => {
    registry = new MetricsRegistry();
  });

  describe("histogram()", () => {
    it("records values", () => {
      registry.histogram("request.duration", 100);
      registry.histogram("request.duration", 200);
      registry.histogram("request.duration", 300);

      const p = registry.percentiles("request.duration");
      expect(p.p50).toBeGreaterThan(0);
    });
  });

  describe("percentiles()", () => {
    it("returns p50/p95/p99 for recorded values", () => {
      // Add 100 values: 1, 2, 3, ..., 100
      for (let i = 1; i <= 100; i++) {
        registry.histogram("latency", i);
      }

      const p = registry.percentiles("latency");
      expect(p.p50).toBe(50);
      expect(p.p95).toBe(95);
      expect(p.p99).toBe(99);
    });

    it("returns zeros for empty histogram", () => {
      const p = registry.percentiles("nonexistent");
      expect(p).toEqual({ p50: 0, p95: 0, p99: 0 });
    });

    it("handles single value", () => {
      registry.histogram("single", 42);
      const p = registry.percentiles("single");
      expect(p.p50).toBe(42);
      expect(p.p95).toBe(42);
      expect(p.p99).toBe(42);
    });

    it("handles two values", () => {
      registry.histogram("duo", 10);
      registry.histogram("duo", 20);
      const p = registry.percentiles("duo");
      expect(p.p50).toBe(10);
      expect(p.p95).toBe(20);
      expect(p.p99).toBe(20);
    });
  });

  describe("snapshot()", () => {
    it("includes histograms in output", () => {
      registry.increment("req.count");
      registry.setGauge("active", 5);
      registry.histogram("duration", 100);
      registry.histogram("duration", 200);

      const snap = registry.snapshot();
      expect(snap.counters).toEqual({ "req.count": 1 });
      expect(snap.gauges).toEqual({ active: 5 });
      expect(snap.histograms).toBeDefined();
      expect(snap.histograms["duration"]).toMatchObject({
        p50: expect.any(Number),
        p95: expect.any(Number),
        p99: expect.any(Number),
        count: 2,
      });
    });

    it("returns empty histograms object when none recorded", () => {
      const snap = registry.snapshot();
      expect(snap.histograms).toEqual({});
    });
  });
});
