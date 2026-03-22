import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import { HeartbeatService } from "./heartbeat.js";
import type { HeartbeatOptions } from "./heartbeat.js";
import { metrics } from "./metrics.js";

vi.mock("./logger.js", () => ({
  info: vi.fn(),
  error: vi.fn(),
}));

describe("HeartbeatService", () => {
  let readFileSpy: ReturnType<typeof vi.spyOn>;
  let mockRunAgent: ReturnType<typeof vi.fn>;
  let mockOnResult: ReturnType<typeof vi.fn>;

  const defaultOpts = (): HeartbeatOptions => ({
    filePath: "/tmp/test-HEARTBEAT.md",
    intervalMs: 30 * 60 * 1000,
    runAgent: mockRunAgent,
    onResult: mockOnResult,
  });

  beforeEach(() => {
    readFileSpy = vi.spyOn(fs, "readFileSync");
    mockRunAgent = vi.fn();
    mockOnResult = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("parseChecklist", () => {
    it("extracts unchecked items", () => {
      const content = `# Heartbeat Checklist

- [ ] Check urgent emails
- [ ] Review calendar
- [x] Already done
`;
      const items = HeartbeatService.parseChecklist(content);
      expect(items).toEqual(["Check urgent emails", "Review calendar"]);
    });

    it("skips checked items", () => {
      const content = `- [x] Done task 1
- [X] Done task 2
- [ ] Pending task
`;
      const items = HeartbeatService.parseChecklist(content);
      expect(items).toEqual(["Pending task"]);
    });

    it("handles empty content", () => {
      const items = HeartbeatService.parseChecklist("");
      expect(items).toEqual([]);
    });

    it("handles content with no checklist items", () => {
      const content = `# Just a heading

Some paragraph text with no checklist items.
`;
      const items = HeartbeatService.parseChecklist(content);
      expect(items).toEqual([]);
    });
  });

  describe("runOnce", () => {
    it("skips when file is missing", async () => {
      readFileSpy.mockImplementation(() => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });

      const service = new HeartbeatService(defaultOpts());
      const result = await service.runOnce();

      expect(result.skipped).toBe(true);
      expect(result.items).toEqual([]);
      expect(result.isError).toBe(false);
      expect(mockRunAgent).not.toHaveBeenCalled();
    });

    it("skips when all items are checked", async () => {
      readFileSpy.mockReturnValue("- [x] Done\n- [X] Also done\n");

      const service = new HeartbeatService(defaultOpts());
      const result = await service.runOnce();

      expect(result.skipped).toBe(true);
      expect(result.items).toEqual([]);
      expect(mockRunAgent).not.toHaveBeenCalled();
    });

    it("calls agent with checklist prompt when items found", async () => {
      const checklist = "- [ ] Check urgent emails\n- [ ] Review calendar\n";
      readFileSpy.mockReturnValue(checklist);
      mockRunAgent.mockResolvedValue({
        text: "All clear, no urgent items.",
        isError: false,
        durationMs: 5000,
        totalCostUsd: 0.02,
      });

      const service = new HeartbeatService(defaultOpts());
      const result = await service.runOnce();

      expect(result.skipped).toBe(false);
      expect(result.items).toEqual(["Check urgent emails", "Review calendar"]);
      expect(result.response).toBe("All clear, no urgent items.");
      expect(result.isError).toBe(false);
      expect(result.durationMs).toBe(5000);
      expect(result.costUsd).toBe(0.02);
      expect(mockRunAgent).toHaveBeenCalledOnce();

      // Verify prompt contains the checklist items
      const prompt = mockRunAgent.mock.calls[0][0] as string;
      expect(prompt).toContain("Check urgent emails");
      expect(prompt).toContain("Review calendar");
    });

    it("returns error result when agent fails", async () => {
      readFileSpy.mockReturnValue("- [ ] Do something\n");
      mockRunAgent.mockResolvedValue({
        text: "Error occurred",
        isError: true,
        durationMs: 1000,
        totalCostUsd: 0.01,
      });

      const service = new HeartbeatService(defaultOpts());
      const result = await service.runOnce();

      expect(result.isError).toBe(true);
      expect(result.response).toBe("Error occurred");
      expect(result.costUsd).toBe(0.01);
    });

    it("calls onResult callback when provided", async () => {
      readFileSpy.mockReturnValue("- [ ] Check something\n");
      mockRunAgent.mockResolvedValue({
        text: "Done",
        isError: false,
        durationMs: 2000,
        totalCostUsd: 0.01,
      });

      const service = new HeartbeatService(defaultOpts());
      await service.runOnce();

      expect(mockOnResult).toHaveBeenCalledOnce();
      expect(mockOnResult.mock.calls[0][0].response).toBe("Done");
    });
  });

  describe("start/stop", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("start() runs heartbeat on interval", async () => {
      readFileSpy.mockReturnValue("- [ ] Periodic check\n");
      mockRunAgent.mockResolvedValue({
        text: "OK",
        isError: false,
        durationMs: 1000,
        totalCostUsd: 0.005,
      });

      const service = new HeartbeatService(defaultOpts());
      service.start();

      // Advance past one interval
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
      expect(mockRunAgent).toHaveBeenCalledTimes(1);

      // Advance past another interval
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
      expect(mockRunAgent).toHaveBeenCalledTimes(2);

      service.stop();
    });

    it("stop() clears the interval", async () => {
      readFileSpy.mockReturnValue("- [ ] Check\n");
      mockRunAgent.mockResolvedValue({
        text: "OK",
        isError: false,
        durationMs: 1000,
        totalCostUsd: 0.005,
      });

      const service = new HeartbeatService(defaultOpts());
      service.start();
      service.stop();

      await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
      expect(mockRunAgent).not.toHaveBeenCalled();
    });
  });

  describe("getLastResult", () => {
    it("returns null before first run", () => {
      const service = new HeartbeatService(defaultOpts());
      expect(service.getLastResult()).toBeNull();
    });

    it("returns last result after run", async () => {
      readFileSpy.mockReturnValue("- [ ] Check something\n");
      mockRunAgent.mockResolvedValue({
        text: "All good",
        isError: false,
        durationMs: 3000,
        totalCostUsd: 0.015,
      });

      const service = new HeartbeatService(defaultOpts());
      await service.runOnce();

      const last = service.getLastResult();
      expect(last).not.toBeNull();
      expect(last?.response).toBe("All good");
      expect(last?.items).toEqual(["Check something"]);
    });
  });

  describe("metrics", () => {
    it("tracks runs, skipped, and errors correctly", async () => {
      // Get baseline
      const snapshot1 = metrics.snapshot();
      const baseRuns = snapshot1.counters["heartbeat.runs"] ?? 0;
      const baseSkipped = snapshot1.counters["heartbeat.skipped"] ?? 0;
      const baseErrors = snapshot1.counters["heartbeat.errors"] ?? 0;

      // Successful run
      readFileSpy.mockReturnValue("- [ ] Check stuff\n");
      mockRunAgent.mockResolvedValue({
        text: "Done",
        isError: false,
        durationMs: 2000,
        totalCostUsd: 0.01,
      });

      const service = new HeartbeatService(defaultOpts());
      await service.runOnce();

      const snapshot2 = metrics.snapshot();
      expect(snapshot2.counters["heartbeat.runs"]).toBe(baseRuns + 1);

      // Skipped run (file missing)
      readFileSpy.mockImplementation(() => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });

      await service.runOnce();

      const snapshot3 = metrics.snapshot();
      expect(snapshot3.counters["heartbeat.skipped"]).toBe(baseSkipped + 1);

      // Error run
      readFileSpy.mockReturnValue("- [ ] Something\n");
      mockRunAgent.mockResolvedValue({
        text: "Error",
        isError: true,
        durationMs: 500,
        totalCostUsd: 0.005,
      });

      await service.runOnce();

      const snapshot4 = metrics.snapshot();
      expect(snapshot4.counters["heartbeat.errors"]).toBe(baseErrors + 1);
    });
  });
});
