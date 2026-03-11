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
});
