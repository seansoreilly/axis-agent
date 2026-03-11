import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("JobService", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `jobs-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("queues, executes, and persists prompt jobs", async () => {
    const { SqliteStore } = await import("./persistence.js");
    const { JobService } = await import("./jobs.js");

    const store = new SqliteStore(tmpDir);
    const agent = {
      run: vi.fn().mockResolvedValue({
        text: "completed",
        sessionId: "sess-1",
        durationMs: 10,
        totalCostUsd: 0.01,
        isError: false,
      }),
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const jobs = new JobService({ store, agent: agent as any });
    const job = jobs.enqueuePromptJob({ prompt: "hello", source: "webhook" });
    const completed = await jobs.waitForCompletion(job.id);

    expect(completed.status).toBe("succeeded");
    expect(completed.resultText).toBe("completed");
    expect(agent.run).toHaveBeenCalledWith("hello", expect.objectContaining({ sessionId: undefined }));
    expect(jobs.listJobs(10)[0]?.id).toBe(job.id);
  });

  it("marks job as failed when agent returns isError", async () => {
    const { SqliteStore } = await import("./persistence.js");
    const { JobService } = await import("./jobs.js");

    const store = new SqliteStore(tmpDir);
    const agent = {
      run: vi.fn().mockResolvedValue({
        text: "Something went wrong",
        sessionId: "sess-1",
        durationMs: 10,
        totalCostUsd: 0,
        isError: true,
      }),
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const jobs = new JobService({ store, agent: agent as any });
    const job = jobs.enqueuePromptJob({ prompt: "fail", source: "webhook" });
    const completed = await jobs.waitForCompletion(job.id);

    expect(completed.status).toBe("failed");
    expect(completed.errorText).toBe("Something went wrong");
  });

  it("marks job as failed after exhausting maxAttempts on exception", async () => {
    const { SqliteStore } = await import("./persistence.js");
    const { JobService } = await import("./jobs.js");

    const store = new SqliteStore(tmpDir);
    const agent = {
      run: vi.fn().mockRejectedValue(new Error("transient failure")),
    };

    // maxAttempts=1 means it fails immediately without requeue
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const jobs = new JobService({ store, agent: agent as any });
    const job = jobs.enqueuePromptJob({ prompt: "fail-once", source: "webhook" }, 1);
    const completed = await jobs.waitForCompletion(job.id);

    expect(completed.status).toBe("failed");
    expect(completed.errorText).toBe("transient failure");
    expect(completed.attempts).toBe(1);
    expect(agent.run).toHaveBeenCalledTimes(1);
  });

  it("requeues job with future runAfter on first failure when maxAttempts > 1", async () => {
    const { SqliteStore } = await import("./persistence.js");
    const { JobService } = await import("./jobs.js");

    const store = new SqliteStore(tmpDir);
    const agent = {
      run: vi.fn().mockRejectedValue(new Error("first failure")),
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const jobs = new JobService({ store, agent: agent as any });
    const job = jobs.enqueuePromptJob({ prompt: "retry-me", source: "webhook" }, 3);

    // Wait for the first attempt to process
    await new Promise((r) => setTimeout(r, 100));

    // Job should be requeued (not failed) with a future runAfter
    const updated = store.getJob(job.id)!;
    expect(updated.status).toBe("queued");
    expect(updated.attempts).toBe(1);
    expect(updated.errorText).toBe("first failure");
    // runAfter should be in the future (backoff delay)
    expect(new Date(updated.runAfter).getTime()).toBeGreaterThan(Date.now() - 1000);
  });

  it("passes AbortSignal to agent.run for per-job timeout", async () => {
    const { SqliteStore } = await import("./persistence.js");
    const { JobService } = await import("./jobs.js");

    const store = new SqliteStore(tmpDir);
    const agent = {
      run: vi.fn().mockImplementation((_prompt: string, opts: { signal?: AbortSignal }) => {
        // Verify signal is provided
        expect(opts.signal).toBeInstanceOf(AbortSignal);
        expect(opts.signal!.aborted).toBe(false);
        return Promise.resolve({
          text: "done",
          sessionId: "s1",
          durationMs: 10,
          totalCostUsd: 0,
          isError: false,
        });
      }),
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const jobs = new JobService({ store, agent: agent as any });
    const job = jobs.enqueuePromptJob({ prompt: "with-signal", source: "webhook" });
    await jobs.waitForCompletion(job.id);

    expect(agent.run).toHaveBeenCalledTimes(1);
  });

  it("waitForCompletion resolves immediately for already-finished jobs", async () => {
    const { SqliteStore } = await import("./persistence.js");
    const { JobService } = await import("./jobs.js");

    const store = new SqliteStore(tmpDir);
    const agent = {
      run: vi.fn().mockResolvedValue({
        text: "fast",
        sessionId: "s1",
        durationMs: 5,
        totalCostUsd: 0,
        isError: false,
      }),
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const jobs = new JobService({ store, agent: agent as any });
    const job = jobs.enqueuePromptJob({ prompt: "fast", source: "webhook" });

    // Wait for it to actually finish processing
    await new Promise((r) => setTimeout(r, 50));

    // Now waitForCompletion should resolve immediately
    const completed = await jobs.waitForCompletion(job.id);
    expect(completed.status).toBe("succeeded");
  });
});

describe("JobService stuck job recovery", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `jobs-stuck-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("requeues stuck jobs that have remaining attempts", async () => {
    const { SqliteStore } = await import("./persistence.js");
    const { JobService } = await import("./jobs.js");

    const store = new SqliteStore(tmpDir);
    const agent = { run: vi.fn() };

    // Manually insert a stuck job (running for > 15 minutes)
    const stuckTime = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    store.insertJob({
      id: "stuck-1",
      type: "prompt",
      status: "running",
      payloadJson: JSON.stringify({ prompt: "stuck", source: "webhook" }),
      attempts: 1,
      maxAttempts: 3,
      createdAt: stuckTime,
      updatedAt: stuckTime,
      runAfter: stuckTime,
      startedAt: stuckTime,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const jobs = new JobService({ store, agent: agent as any });
    const recovered = jobs.recoverStuckJobs();

    expect(recovered).toBe(1);
    const job = store.getJob("stuck-1")!;
    expect(job.status).toBe("queued");
  });

  it("marks stuck jobs as failed when max attempts reached", async () => {
    const { SqliteStore } = await import("./persistence.js");
    const { JobService } = await import("./jobs.js");

    const store = new SqliteStore(tmpDir);
    const agent = { run: vi.fn() };

    const stuckTime = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    store.insertJob({
      id: "stuck-maxed",
      type: "prompt",
      status: "running",
      payloadJson: JSON.stringify({ prompt: "stuck", source: "scheduler" }),
      attempts: 2,
      maxAttempts: 2,
      createdAt: stuckTime,
      updatedAt: stuckTime,
      runAfter: stuckTime,
      startedAt: stuckTime,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const jobs = new JobService({ store, agent: agent as any });
    const recovered = jobs.recoverStuckJobs();

    expect(recovered).toBe(1);
    const job = store.getJob("stuck-maxed")!;
    expect(job.status).toBe("failed");
    expect(job.errorText).toBe("Job timed out while running");
    expect(job.finishedAt).toBeTruthy();
  });

  it("does not recover jobs that are not stuck (started recently)", async () => {
    const { SqliteStore } = await import("./persistence.js");
    const { JobService } = await import("./jobs.js");

    const store = new SqliteStore(tmpDir);
    const agent = { run: vi.fn() };

    // Job started 5 minutes ago (under 15-minute threshold)
    const recentTime = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    store.insertJob({
      id: "recent-running",
      type: "prompt",
      status: "running",
      payloadJson: JSON.stringify({ prompt: "active", source: "webhook" }),
      attempts: 1,
      maxAttempts: 2,
      createdAt: recentTime,
      updatedAt: recentTime,
      runAfter: recentTime,
      startedAt: recentTime,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const jobs = new JobService({ store, agent: agent as any });
    const recovered = jobs.recoverStuckJobs();

    expect(recovered).toBe(0);
    expect(store.getJob("recent-running")!.status).toBe("running");
  });
});
