import { randomUUID } from "node:crypto";
import type { Agent } from "./agent.js";
import { metrics } from "./metrics.js";
import { type JobRecord, SqliteStore } from "./persistence.js";
import { error as logError, info } from "./logger.js";

export interface PromptJobPayload {
  prompt: string;
  sessionId?: string;
  source: "webhook" | "scheduler";
  metadata?: Record<string, unknown>;
}

export interface JobServiceOptions {
  store: SqliteStore;
  agent: Agent;
}

function nowIso(): string {
  return new Date().toISOString();
}

export class JobService {
  private running = false;
  private waiters = new Map<string, Array<(job: JobRecord) => void>>();

  constructor(private readonly opts: JobServiceOptions) {}

  enqueuePromptJob(payload: PromptJobPayload, maxAttempts = 2): JobRecord {
    const job: JobRecord = {
      id: randomUUID(),
      type: "prompt",
      status: "queued",
      payloadJson: JSON.stringify(payload),
      attempts: 0,
      maxAttempts,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      runAfter: nowIso(),
    };
    this.opts.store.insertJob(job);
    this.opts.store.addEvent("job_enqueued", { jobId: job.id, source: payload.source });
    metrics.increment("jobs.enqueued");
    void this.processQueue();
    return job;
  }

  listJobs(limit = 50): JobRecord[] {
    return this.opts.store.listJobs(limit);
  }

  getJob(id: string): JobRecord | undefined {
    return this.opts.store.getJob(id);
  }

  async waitForCompletion(id: string, timeoutMs = 60_000): Promise<JobRecord> {
    const existing = this.opts.store.getJob(id);
    if (existing && isFinal(existing.status)) {
      return existing;
    }

    return new Promise<JobRecord>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Timed out waiting for job ${id}`));
      }, timeoutMs);

      const list = this.waiters.get(id) ?? [];
      list.push((job) => {
        clearTimeout(timeout);
        resolve(job);
      });
      this.waiters.set(id, list);
    });
  }

  private notifyWaiters(job: JobRecord): void {
    const waiters = this.waiters.get(job.id);
    if (!waiters) return;
    this.waiters.delete(job.id);
    for (const waiter of waiters) {
      waiter(job);
    }
  }

  async processQueue(): Promise<void> {
    if (this.running) return;
    this.running = true;
    metrics.setGauge("jobs.running", 1);

    try {
      while (true) {
        const next = this.opts.store.getRunnableJobs(1)[0];
        if (!next) break;
        await this.processJob(next);
      }
    } finally {
      this.running = false;
      metrics.setGauge("jobs.running", 0);
    }
  }

  private async processJob(job: JobRecord): Promise<void> {
    const payload = JSON.parse(job.payloadJson) as PromptJobPayload;
    job.status = "running";
    job.attempts += 1;
    job.startedAt = nowIso();
    job.updatedAt = nowIso();
    this.opts.store.updateJob(job);
    this.opts.store.addEvent("job_started", { jobId: job.id, source: payload.source });

    try {
      const result = await this.opts.agent.run(payload.prompt, {
        sessionId: payload.sessionId,
      });
      job.resultText = result.text;
      job.status = result.isError ? "failed" : "succeeded";
      if (result.isError) {
        job.errorText = result.text;
      }
      job.finishedAt = nowIso();
      job.updatedAt = nowIso();
      this.opts.store.updateJob(job);
      this.opts.store.addEvent("job_finished", {
        jobId: job.id,
        status: job.status,
        source: payload.source,
      });
      metrics.increment(result.isError ? "jobs.failed" : "jobs.succeeded");
      this.notifyWaiters(job);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError("jobs", `Job ${job.id} failed: ${message}`);
      if (job.attempts < job.maxAttempts) {
        job.status = "queued";
        job.errorText = message;
        job.updatedAt = nowIso();
        job.runAfter = new Date(Date.now() + job.attempts * 5_000).toISOString();
        this.opts.store.updateJob(job);
        this.opts.store.addEvent("job_requeued", { jobId: job.id, attempts: job.attempts });
      } else {
        job.status = "failed";
        job.errorText = message;
        job.finishedAt = nowIso();
        job.updatedAt = nowIso();
        this.opts.store.updateJob(job);
        this.opts.store.addEvent("job_finished", { jobId: job.id, status: "failed" });
        metrics.increment("jobs.failed");
        this.notifyWaiters(job);
      }
    }
  }
}

function isFinal(status: string): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}
