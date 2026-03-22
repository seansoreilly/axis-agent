import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ReflectionService, type ReflectionInput, type ReflectionServiceOptions } from "./reflection.js";

vi.mock("node:fs", () => ({
  appendFileSync: vi.fn(),
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn().mockReturnValue(""),
}));

vi.mock("./logger.js", () => ({
  info: vi.fn(),
  error: vi.fn(),
}));

vi.mock("./metrics.js", () => ({
  metrics: {
    increment: vi.fn(),
    setGauge: vi.fn(),
    histogram: vi.fn(),
  },
}));

function makeInput(overrides: Partial<ReflectionInput> = {}): ReflectionInput {
  return {
    taskPrompt: "Search for files matching *.ts",
    taskResponse: "Found 12 TypeScript files in the project.",
    durationMs: 5000,
    costUsd: 0.02,
    isError: false,
    model: "claude-sonnet-4-20250514",
    toolsUsed: ["Glob", "Read"],
    ...overrides,
  };
}

function makeOptions(overrides: Partial<ReflectionServiceOptions> = {}): ReflectionServiceOptions {
  return {
    reflectAgent: vi.fn().mockResolvedValue({
      text: `ASSESSMENT: efficient
INSIGHTS:
- Task completed quickly with appropriate tools
- Glob was the right choice for file search
ACTION: No action needed`,
      isError: false,
    }),
    costThresholdUsd: 0.10,
    durationThresholdMs: 30000,
    cooldownMs: 5 * 60 * 1000,
    ...overrides,
  };
}

describe("ReflectionService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-22T10:00:00.000Z"));
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("parseReflection", () => {
    it("extracts assessment from agent response", () => {
      const response = `ASSESSMENT: needs_improvement
INSIGHTS:
- Could have been faster
ACTION: Use caching`;
      const result = ReflectionService.parseReflection(response);
      expect(result.assessment).toBe("needs_improvement");
    });

    it("extracts insights list", () => {
      const response = `ASSESSMENT: acceptable
INSIGHTS:
- The task used 8 turns when 3 would have sufficed
- File search was inefficient
- Should have used Glob instead of Bash
ACTION: Optimize tool selection`;
      const result = ReflectionService.parseReflection(response);
      expect(result.insights).toEqual([
        "The task used 8 turns when 3 would have sufficed",
        "File search was inefficient",
        "Should have used Glob instead of Bash",
      ]);
    });

    it("extracts suggested action", () => {
      const response = `ASSESSMENT: needs_improvement
INSIGHTS:
- Suboptimal approach
ACTION: Add Glob to preferred tools for file search patterns`;
      const result = ReflectionService.parseReflection(response);
      expect(result.suggestedAction).toBe("Add Glob to preferred tools for file search patterns");
    });

    it("handles missing fields gracefully", () => {
      const response = "The task went fine overall.";
      const result = ReflectionService.parseReflection(response);
      expect(result.assessment).toBe("acceptable");
      expect(result.insights).toEqual([]);
      expect(result.suggestedAction).toBeUndefined();
    });

    it("handles malformed response", () => {
      const response = `ASSESSMENT: something_invalid
INSIGHTS:
not a list`;
      const result = ReflectionService.parseReflection(response);
      expect(result.assessment).toBe("acceptable");
      expect(result.insights).toEqual([]);
    });
  });

  describe("maybeReflect", () => {
    it("skips when below cost threshold", async () => {
      const opts = makeOptions();
      const service = new ReflectionService(opts);
      const input = makeInput({ costUsd: 0.05, durationMs: 5000 });

      const result = await service.maybeReflect(input);

      expect(result.shouldReflect).toBe(false);
      expect(opts.reflectAgent).not.toHaveBeenCalled();
    });

    it("skips when below duration threshold", async () => {
      const opts = makeOptions();
      const service = new ReflectionService(opts);
      const input = makeInput({ costUsd: 0.05, durationMs: 10000 });

      const result = await service.maybeReflect(input);

      expect(result.shouldReflect).toBe(false);
      expect(opts.reflectAgent).not.toHaveBeenCalled();
    });

    it("runs for errors regardless of thresholds", async () => {
      const opts = makeOptions();
      const service = new ReflectionService(opts);
      const input = makeInput({ costUsd: 0.01, durationMs: 1000, isError: true });

      const result = await service.maybeReflect(input);

      expect(result.shouldReflect).toBe(true);
      expect(opts.reflectAgent).toHaveBeenCalled();
    });

    it("respects cooldown", async () => {
      const opts = makeOptions({ cooldownMs: 5 * 60 * 1000 });
      const service = new ReflectionService(opts);
      const input = makeInput({ costUsd: 1.00 });

      // First reflection should run
      const result1 = await service.maybeReflect(input);
      expect(result1.shouldReflect).toBe(true);

      // Second reflection within cooldown should skip
      vi.advanceTimersByTime(60 * 1000); // 1 minute later
      const result2 = await service.maybeReflect(input);
      expect(result2.shouldReflect).toBe(false);

      // After cooldown passes, should run again
      vi.advanceTimersByTime(5 * 60 * 1000); // 5 more minutes
      const result3 = await service.maybeReflect(input);
      expect(result3.shouldReflect).toBe(true);
    });

    it("runs when cost exceeds threshold", async () => {
      const opts = makeOptions({ costThresholdUsd: 0.10 });
      const service = new ReflectionService(opts);
      const input = makeInput({ costUsd: 0.50 });

      const result = await service.maybeReflect(input);

      expect(result.shouldReflect).toBe(true);
      expect(opts.reflectAgent).toHaveBeenCalled();
    });

    it("runs when duration exceeds threshold", async () => {
      const opts = makeOptions({ durationThresholdMs: 30000 });
      const service = new ReflectionService(opts);
      const input = makeInput({ durationMs: 60000 });

      const result = await service.maybeReflect(input);

      expect(result.shouldReflect).toBe(true);
      expect(opts.reflectAgent).toHaveBeenCalled();
    });
  });

  describe("reflect", () => {
    it("always runs regardless of thresholds", async () => {
      const opts = makeOptions();
      const service = new ReflectionService(opts);
      const input = makeInput({ costUsd: 0.01, durationMs: 100 });

      const result = await service.reflect(input);

      expect(result.shouldReflect).toBe(true);
      expect(opts.reflectAgent).toHaveBeenCalled();
    });

    it("calls agent with structured prompt", async () => {
      const reflectAgent = vi.fn().mockResolvedValue({
        text: "ASSESSMENT: efficient\nINSIGHTS:\n- Good\nACTION: None",
        isError: false,
      });
      const service = new ReflectionService(makeOptions({ reflectAgent }));
      const input = makeInput({ taskPrompt: "Find all TODO comments" });

      await service.reflect(input);

      expect(reflectAgent).toHaveBeenCalledOnce();
      const prompt = reflectAgent.mock.calls[0][0] as string;
      expect(prompt).toContain("Find all TODO comments");
      expect(prompt).toContain("ASSESSMENT:");
      expect(prompt).toContain("INSIGHTS:");
      expect(prompt).toContain("ACTION:");
    });

    it("returns parsed result", async () => {
      const reflectAgent = vi.fn().mockResolvedValue({
        text: `ASSESSMENT: needs_improvement
INSIGHTS:
- Used too many turns
- Wrong tool selection
ACTION: Prefer Glob for file search`,
        isError: false,
      });
      const service = new ReflectionService(makeOptions({ reflectAgent }));

      const result = await service.reflect(makeInput());

      expect(result.shouldReflect).toBe(true);
      expect(result.assessment).toBe("needs_improvement");
      expect(result.insights).toEqual([
        "Used too many turns",
        "Wrong tool selection",
      ]);
      expect(result.suggestedAction).toBe("Prefer Glob for file search");
      expect(result.timestamp).toBe("2026-03-22T10:00:00.000Z");
    });

    it("handles agent errors gracefully", async () => {
      const reflectAgent = vi.fn().mockResolvedValue({
        text: "",
        isError: true,
      });
      const service = new ReflectionService(makeOptions({ reflectAgent }));

      const result = await service.reflect(makeInput());

      expect(result.shouldReflect).toBe(true);
      expect(result.assessment).toBe("acceptable");
      expect(result.insights).toEqual([]);
    });
  });

  describe("getRecentReflections", () => {
    it("returns stored reflections", async () => {
      const service = new ReflectionService(makeOptions());

      // Initially empty
      expect(service.getRecentReflections()).toEqual([]);

      // After a reflection, it should be stored
      await service.reflect(makeInput());
      const recent = service.getRecentReflections();
      expect(recent).toHaveLength(1);
      expect(recent[0].assessment).toBe("efficient");
    });

    it("respects count parameter", async () => {
      const service = new ReflectionService(makeOptions());

      await service.reflect(makeInput());
      vi.advanceTimersByTime(6 * 60 * 1000); // past cooldown for maybeReflect, but reflect ignores cooldown
      await service.reflect(makeInput());
      vi.advanceTimersByTime(6 * 60 * 1000);
      await service.reflect(makeInput());

      expect(service.getRecentReflections(2)).toHaveLength(2);
      expect(service.getRecentReflections()).toHaveLength(3);
    });
  });

  describe("storage", () => {
    it("appends reflections to JSONL file", async () => {
      const { appendFileSync } = await import("node:fs");
      const service = new ReflectionService(
        makeOptions({ storePath: "/tmp/reflections.jsonl" })
      );

      await service.reflect(makeInput());

      expect(appendFileSync).toHaveBeenCalledWith(
        "/tmp/reflections.jsonl",
        expect.stringContaining('"assessment":"efficient"')
      );
      // Verify it's a single line ending with newline
      const written = (appendFileSync as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(written.endsWith("\n")).toBe(true);
      expect(written.trim().split("\n")).toHaveLength(1);
    });
  });

  describe("metrics", () => {
    it("tracks metrics correctly", async () => {
      const { metrics } = await import("./metrics.js");
      const service = new ReflectionService(makeOptions());

      // Reflect should increment reflection.runs
      await service.reflect(makeInput());
      expect(metrics.increment).toHaveBeenCalledWith("reflection.runs");
      expect(metrics.increment).toHaveBeenCalledWith("reflection.insights_count", expect.any(Number));

      vi.clearAllMocks();

      // Skipped reflection should increment reflection.skipped
      const input = makeInput({ costUsd: 0.01, durationMs: 100 });
      await service.maybeReflect(input);
      expect(metrics.increment).toHaveBeenCalledWith("reflection.skipped");
    });
  });

  describe("callback", () => {
    it("calls onReflection callback when provided", async () => {
      const onReflection = vi.fn();
      const service = new ReflectionService(makeOptions({ onReflection }));

      await service.reflect(makeInput());

      expect(onReflection).toHaveBeenCalledWith(
        expect.objectContaining({
          shouldReflect: true,
          assessment: "efficient",
        })
      );
    });
  });
});
