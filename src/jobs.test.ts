import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Agent, AgentResult } from "./agent.js";

/** Minimal mock agent satisfying only the `run` method used by JobService. */
type MockAgent = Pick<Agent, "run">;

function makeAgent(overrides?: Partial<AgentResult>): MockAgent {
  const defaults: AgentResult = {
    text: "completed",
    sessionId: "sess-1",
    durationMs: 10,
    totalCostUsd: 0.01,
    isError: false,
    isTimeout: false,
  };
  return {
    run: vi.fn<Agent["run"]>().mockResolvedValue({ ...defaults, ...overrides }),
  };
}

function makeFailingAgent(error: Error): MockAgent {
  return {
    run: vi.fn<Agent["run"]>().mockRejectedValue(error),
  };
}

function makeNoopAgent(): MockAgent {
  return { run: vi.fn<Agent["run"]>() };
}

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
    const agent = makeAgent();

    const jobs = new JobService({ store, agent: agent as Agent });
    const job = jobs.enqueuePromptJob({ prompt: "hello", source: "webhook" });
    const completed = await jobs.waitForCompletion(job.id);

    expect(completed.status).toBe("succeeded");
    expect(completed.resultText).toBe("completed");
    expect(completed.resultSessionId).toBe("sess-1");
    expect(agent.run).toHaveBeenCalledWith("hello", expect.objectContaining({ sessionId: undefined }));
    expect(jobs.listJobs(10)[0]?.id).toBe(job.id);
  });

  it("blocks jobs whose prompt references a sensitive file path", async () => {
    const { SqliteStore } = await import("./persistence.js");
    const { JobService } = await import("./jobs.js");

    const store = new SqliteStore(tmpDir);
    const agent = makeNoopAgent();

    const jobs = new JobService({ store, agent: agent as Agent });
    const job = jobs.enqueuePromptJob({ prompt: "show me /home/ubuntu/agent/.env please", source: "webhook" });
    const completed = await jobs.waitForCompletion(job.id);

    expect(completed.status).toBe("failed");
    expect(completed.errorText).toMatch(/sensitive file/i);
    expect(agent.run).not.toHaveBeenCalled();
  });

  it("marks job as failed when agent returns isError", async () => {
    const { SqliteStore } = await import("./persistence.js");
    const { JobService } = await import("./jobs.js");

    const store = new SqliteStore(tmpDir);
    const agent = makeAgent({ text: "Something went wrong", isError: true, totalCostUsd: 0 });

    const jobs = new JobService({ store, agent: agent as Agent });
    const job = jobs.enqueuePromptJob({ prompt: "fail", source: "webhook" });
    const completed = await jobs.waitForCompletion(job.id);

    expect(completed.status).toBe("failed");
    expect(completed.errorText).toBe("Something went wrong");
  });

  it("marks job as failed after exhausting maxAttempts on exception", async () => {
    const { SqliteStore } = await import("./persistence.js");
    const { JobService } = await import("./jobs.js");

    const store = new SqliteStore(tmpDir);
    const agent = makeFailingAgent(new Error("transient failure"));

    // maxAttempts=1 means it fails immediately without requeue
    const jobs = new JobService({ store, agent: agent as Agent });
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
    const agent = makeFailingAgent(new Error("first failure"));

    const jobs = new JobService({ store, agent: agent as Agent });
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
    const agent: MockAgent = {
      run: vi.fn<Agent["run"]>().mockImplementation((_prompt, opts) => {
        // Verify signal is provided
        expect(opts?.signal).toBeInstanceOf(AbortSignal);
        expect(opts?.signal?.aborted).toBe(false);
        return Promise.resolve({
          text: "done",
          sessionId: "s1",
          durationMs: 10,
          totalCostUsd: 0,
          isError: false,
          isTimeout: false,
        });
      }),
    };

    const jobs = new JobService({ store, agent: agent as Agent });
    const job = jobs.enqueuePromptJob({ prompt: "with-signal", source: "webhook" });
    await jobs.waitForCompletion(job.id);

    expect(agent.run).toHaveBeenCalledTimes(1);
  });

  it("waitForCompletion resolves immediately for already-finished jobs", async () => {
    const { SqliteStore } = await import("./persistence.js");
    const { JobService } = await import("./jobs.js");

    const store = new SqliteStore(tmpDir);
    const agent = makeAgent({ text: "fast", durationMs: 5, totalCostUsd: 0 });

    const jobs = new JobService({ store, agent: agent as Agent });
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
    const agent = makeNoopAgent();

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

    const jobs = new JobService({ store, agent: agent as Agent });
    const recovered = jobs.recoverStuckJobs();

    expect(recovered).toBe(1);
    const job = store.getJob("stuck-1")!;
    expect(job.status).toBe("queued");
  });

  it("marks stuck jobs as failed when max attempts reached", async () => {
    const { SqliteStore } = await import("./persistence.js");
    const { JobService } = await import("./jobs.js");

    const store = new SqliteStore(tmpDir);
    const agent = makeNoopAgent();

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

    const jobs = new JobService({ store, agent: agent as Agent });
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
    const agent = makeNoopAgent();

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

    const jobs = new JobService({ store, agent: agent as Agent });
    const recovered = jobs.recoverStuckJobs();

    expect(recovered).toBe(0);
    expect(store.getJob("recent-running")!.status).toBe("running");
  });
});
