/**
 * Smoke tests — verify the app boots and core components initialize without crashing.
 * Uses real implementations for everything except the Claude SDK.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock child_process to avoid spawning real claude CLI
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

// Mock auth to avoid hitting real OAuth
vi.mock("./auth.js", () => ({
  ensureValidToken: vi.fn().mockResolvedValue(true),
  tokenNeedsRefresh: vi.fn().mockReturnValue(false),
  startTokenRefreshTimer: vi.fn().mockReturnValue(setInterval(() => {}, 999999)),
}));

describe("Smoke: component initialization", () => {
  let tmpDir: string;
  let memoryDir: string;
  let workDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `smoke-test-${Date.now()}`);
    memoryDir = join(tmpDir, "memory");
    workDir = join(tmpDir, "workspace");
    mkdirSync(memoryDir, { recursive: true });
    mkdirSync(workDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function makeConfig() {
    return {
      telegram: { botToken: "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11", allowedUsers: [12345] },
      server: { port: 0 },
      claude: { model: "claude-sonnet-4-6", maxTurns: 5, maxBudgetUsd: 1, workDir, agentTimeoutMs: 60000 },
      memoryDir,
    };
  }

  it("SqliteStore initializes, creates tables, and supports CRUD", async () => {
    const { SqliteStore } = await import("./persistence.js");
    const store = new SqliteStore(memoryDir);

    // Sessions
    store.recordSession("sess-1", 12345, "hello");
    const sessions = store.listSessions();
    expect(sessions.length).toBe(1);
    expect(sessions[0].sessionId).toBe("sess-1");

    // Events
    store.addEvent("test-event", { foo: "bar" });
    const events = store.listEvents(10);
    expect(events.length).toBe(1);
    expect(events[0].eventType).toBe("test-event");
  });

  it("Agent constructs with real SqliteStore", async () => {
    const { Agent } = await import("./agent.js");
    const { SqliteStore } = await import("./persistence.js");
    const store = new SqliteStore(memoryDir);
    const agent = new Agent(makeConfig(), store);
    expect(agent).toBeDefined();
  });

  it("Scheduler constructs and starts/stops without error", async () => {
    const { Agent } = await import("./agent.js");
    const { SqliteStore } = await import("./persistence.js");
    const { Scheduler } = await import("./scheduler.js");
    const { JobService } = await import("./jobs.js");

    const store = new SqliteStore(memoryDir);
    const agent = new Agent(makeConfig(), store);
    const jobs = new JobService({ store, agent });
    const notifications: string[] = [];

    const scheduler = new Scheduler(
      agent,
      (_taskId, result) => { notifications.push(result); },
      memoryDir,
      jobs,
    );

    expect(scheduler.list()).toEqual([]);
    scheduler.stopAll();
  });

  it("Gateway boots, serves /health, and shuts down cleanly", async () => {
    const { Agent } = await import("./agent.js");
    const { SqliteStore } = await import("./persistence.js");
    const { Scheduler } = await import("./scheduler.js");
    const { JobService } = await import("./jobs.js");
    const { createGateway } = await import("./gateway.js");

    const store = new SqliteStore(memoryDir);
    const agent = new Agent(makeConfig(), store);
    const jobs = new JobService({ store, agent });
    const scheduler = new Scheduler(
      agent,
      () => {},
      memoryDir,
      jobs,
    );

    const app = await createGateway({
      port: 0,
      agent,
      scheduler,
      jobs,
      store,
      gatewayApiToken: "smoke-test-token",
    });

    try {
      const health = await app.inject({ method: "GET", url: "/health" });
      expect(health.statusCode).toBe(200);
      const body = JSON.parse(health.body);
      expect(body.status).toBe("ok");
      expect(typeof body.uptime).toBe("number");
      expect(typeof body.timestamp).toBe("string");
    } finally {
      scheduler.stopAll();
      await app.close();
    }
  });

  it("Full component chain: store → agent → scheduler → gateway → job service", async () => {
    const { Agent } = await import("./agent.js");
    const { SqliteStore } = await import("./persistence.js");
    const { Scheduler } = await import("./scheduler.js");
    const { JobService } = await import("./jobs.js");
    const { createGateway } = await import("./gateway.js");

    const store = new SqliteStore(memoryDir);
    const agent = new Agent(makeConfig(), store);
    const jobs = new JobService({ store, agent });
    const scheduler = new Scheduler(agent, () => {}, memoryDir, jobs);

    // Add a scheduled task
    scheduler.add({
      id: "smoke-test-task",
      name: "Smoke Test",
      schedule: "0 0 * * *",
      prompt: "test prompt",
      enabled: true,
    });

    expect(scheduler.list().length).toBe(1);

    // Boot gateway
    const app = await createGateway({
      port: 0,
      agent,
      scheduler,
      jobs,
      store,
      gatewayApiToken: "smoke-token",
    });

    try {
      // Enqueue a job via webhook
      const webhook = await app.inject({
        method: "POST",
        url: "/webhook",
        headers: { authorization: "Bearer smoke-token" },
        payload: { prompt: "smoke test prompt" },
      });
      expect(webhook.statusCode).toBe(202);
      const webhookBody = JSON.parse(webhook.body);
      expect(webhookBody.jobId).toBeTruthy();

      // Verify job is in the store (may already be running/failed since JobService processes async)
      const job = store.getJob(webhookBody.jobId);
      expect(job).toBeDefined();
      expect(["queued", "running", "failed"]).toContain(job!.status);

      // Verify tasks are visible
      const tasks = await app.inject({
        method: "GET",
        url: "/tasks",
        headers: { authorization: "Bearer smoke-token" },
      });
      expect(tasks.statusCode).toBe(200);
      const taskList = JSON.parse(tasks.body).tasks;
      expect(taskList.length).toBe(1);
      expect(taskList[0].id).toBe("smoke-test-task");
    } finally {
      scheduler.remove("smoke-test-task");
      scheduler.stopAll();
      await app.close();
    }
  });
});
