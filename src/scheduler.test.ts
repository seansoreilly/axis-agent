import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCheckCommand } from "./scheduler.js";

// Mock node-cron to avoid real scheduling
const mockSchedule = vi.fn();
const mockValidate = vi.fn().mockReturnValue(true);
vi.mock("node-cron", () => ({
  default: {
    schedule: (...args: unknown[]) => {
      mockSchedule(...args);
      return { stop: vi.fn() };
    },
    validate: (...args: unknown[]) => mockValidate(...args),
  },
}));

// Mock cron-parser
vi.mock("cron-parser", () => ({
  CronExpressionParser: {
    parse: vi.fn().mockReturnValue({
      next: vi.fn()
        .mockReturnValueOnce({ toDate: () => new Date("2026-01-01T00:00:00Z") })
        .mockReturnValueOnce({ toDate: () => new Date("2026-01-01T01:00:00Z") }),
    }),
  },
}));

// Mock agent
function makeAgent() {
  return {
    run: vi.fn().mockResolvedValue({
      text: "done",
      sessionId: "s1",
      durationMs: 100,
      totalCostUsd: 0.01,
      isError: false,
    }),
    generateSummary: vi.fn().mockResolvedValue(null),
    shouldSummarize: vi.fn().mockReturnValue(false),
  };
}

// Mock JobService
function makeJobs() {
  return {
    enqueuePromptJob: vi.fn().mockReturnValue({ id: "job-1" }),
    waitForCompletion: vi.fn().mockResolvedValue({
      id: "job-1",
      status: "succeeded",
      resultText: "done",
    }),
    listJobs: vi.fn().mockReturnValue([]),
    getJob: vi.fn(),
    recoverStuckJobs: vi.fn().mockReturnValue(0),
    processQueue: vi.fn().mockResolvedValue(undefined),
  };
}

describe("runCheckCommand", () => {
  it("returns stdout from a successful command", async () => {
    const result = await runCheckCommand("echo hello world");
    expect(result).toBe("hello world");
  });

  it("trims whitespace from stdout", async () => {
    const result = await runCheckCommand("echo '  spaced  '");
    expect(result).toBe("spaced");
  });

  it("returns empty string for a failing command", async () => {
    const result = await runCheckCommand("exit 1");
    expect(result).toBe("");
  });

  it("returns empty string for a command that produces no output", async () => {
    const result = await runCheckCommand("true");
    expect(result).toBe("");
  });

  it("returns empty string for a nonexistent command", async () => {
    const result = await runCheckCommand("nonexistent_command_xyz_123");
    expect(result).toBe("");
  });
});

describe("Scheduler with monitor tasks", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `scheduler-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    mockSchedule.mockClear();
    mockValidate.mockReturnValue(true);
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("adds a monitor task with checkCommand", async () => {
    const { Scheduler } = await import("./scheduler.js");
    const agent = makeAgent();
    const jobs = makeJobs();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scheduler = new Scheduler(agent as any, undefined, tmpDir, jobs as any);

    scheduler.add({
      id: "monitor-1",
      name: "Email Monitor",
      schedule: "0 * * * *",
      prompt: "Process these new emails",
      enabled: true,
      checkCommand: "echo 'new email from alice'",
    });

    const tasks = scheduler.list();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].checkCommand).toBe("echo 'new email from alice'");
    expect(tasks[0].id).toBe("monitor-1");
  });

  it("persists checkCommand in storage", async () => {
    const { Scheduler } = await import("./scheduler.js");
    const agent = makeAgent();
    const jobs = makeJobs();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scheduler = new Scheduler(agent as any, undefined, tmpDir, jobs as any);

    scheduler.add({
      id: "monitor-2",
      name: "RSS Monitor",
      schedule: "*/30 * * * *",
      prompt: "Summarize new RSS items",
      enabled: true,
      checkCommand: "cat /tmp/rss-new.txt",
    });

    const saved = scheduler.list();
    expect(saved[0].checkCommand).toBe("cat /tmp/rss-new.txt");
  });

  it("registers cron job for monitor task", async () => {
    const { Scheduler } = await import("./scheduler.js");
    const agent = makeAgent();
    const jobs = makeJobs();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scheduler = new Scheduler(agent as any, undefined, tmpDir, jobs as any);

    scheduler.add({
      id: "monitor-3",
      name: "Check Task",
      schedule: "0 */2 * * *",
      prompt: "Handle check output",
      enabled: true,
      checkCommand: "echo data",
    });

    // Cron schedule should have been called
    expect(mockSchedule).toHaveBeenCalled();
    const [cronExpr] = mockSchedule.mock.calls[0];
    expect(cronExpr).toBe("0 */2 * * *");
  });

  it("monitor task cron handler skips agent when check returns empty", async () => {
    const { Scheduler } = await import("./scheduler.js");
    const agent = makeAgent();
    const jobs = makeJobs();
    const onResult = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scheduler = new Scheduler(agent as any, onResult, tmpDir, jobs as any);

    scheduler.add({
      id: "monitor-4",
      name: "Empty Check",
      schedule: "0 * * * *",
      prompt: "Should not run",
      enabled: true,
      checkCommand: "true", // produces no output
    });

    // Extract and invoke the cron handler
    const handler = mockSchedule.mock.calls[0][1] as () => Promise<void>;
    await handler();

    // Agent should NOT have been called
    expect(jobs.enqueuePromptJob).not.toHaveBeenCalled();
    expect(onResult).not.toHaveBeenCalled();
  });

  it("monitor task cron handler runs agent with check output prepended", async () => {
    const { Scheduler } = await import("./scheduler.js");
    const agent = makeAgent();
    const jobs = makeJobs();
    const onResult = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scheduler = new Scheduler(agent as any, onResult, tmpDir, jobs as any);

    scheduler.add({
      id: "monitor-5",
      name: "Data Check",
      schedule: "0 * * * *",
      prompt: "Process the data above",
      enabled: true,
      checkCommand: "echo 'found 3 new items'",
    });

    const handler = mockSchedule.mock.calls[0][1] as () => Promise<void>;
    await handler();

    // Job should have been enqueued with check output prepended
    expect(jobs.enqueuePromptJob).toHaveBeenCalledOnce();
    const promptArg = jobs.enqueuePromptJob.mock.calls[0][0].prompt as string;
    expect(promptArg).toContain("found 3 new items");
    expect(promptArg).toContain("Process the data above");
    expect(promptArg).toContain("Monitor Check Output");
    expect(onResult).toHaveBeenCalledWith("monitor-5", "done");
  });

  it("regular task (no checkCommand) still works normally", async () => {
    const { Scheduler } = await import("./scheduler.js");
    const agent = makeAgent();
    const jobs = makeJobs();
    const onResult = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scheduler = new Scheduler(agent as any, onResult, tmpDir, jobs as any);

    scheduler.add({
      id: "regular-1",
      name: "Regular Task",
      schedule: "0 * * * *",
      prompt: "Do something",
      enabled: true,
    });

    const handler = mockSchedule.mock.calls[0][1] as () => Promise<void>;
    await handler();

    expect(jobs.enqueuePromptJob).toHaveBeenCalledWith({
      prompt: "Do something",
      source: "scheduler",
      metadata: { taskId: "regular-1", taskName: "Regular Task" },
    });
    expect(onResult).toHaveBeenCalledWith("regular-1", "done");
  });

  it("monitor task skips when check command fails", async () => {
    const { Scheduler } = await import("./scheduler.js");
    const agent = makeAgent();
    const jobs = makeJobs();
    const onResult = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scheduler = new Scheduler(agent as any, onResult, tmpDir, jobs as any);

    scheduler.add({
      id: "monitor-6",
      name: "Failing Check",
      schedule: "0 * * * *",
      prompt: "Should not run",
      enabled: true,
      checkCommand: "exit 1",
    });

    const handler = mockSchedule.mock.calls[0][1] as () => Promise<void>;
    await handler();

    expect(jobs.enqueuePromptJob).not.toHaveBeenCalled();
    expect(onResult).not.toHaveBeenCalled();
  });
});
