/**
 * Contract tests — verify every gateway route returns the expected response shape.
 * Uses real Fastify + real SqliteStore + real JobService, only mocks the Agent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { FastifyInstance } from "fastify";

describe("Contract: gateway response shapes", () => {
  let app: FastifyInstance;
  let tmpDir: string;
  const TOKEN = "contract-test-token";

  function auth() {
    return { authorization: `Bearer ${TOKEN}` };
  }

  function makeAgent() {
    return {
      run: vi.fn().mockResolvedValue({
        text: "agent response",
        sessionId: "sess-contract-1",
        durationMs: 100,
        totalCostUsd: 0.01,
        isError: false,
        isTimeout: false,
      }),
    };
  }

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `contract-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  async function createApp(opts?: { withJobs?: boolean; withOwntracks?: boolean }) {
    const { createGateway } = await import("./gateway.js");
    const { SqliteStore } = await import("./persistence.js");
    const { JobService } = await import("./jobs.js");

    const store = new SqliteStore(tmpDir);
    const agent = makeAgent();
    const scheduler = {
      add: vi.fn(),
      remove: vi.fn().mockReturnValue(true),
      list: vi.fn().mockReturnValue([
        { id: "t1", name: "Task One", schedule: "0 * * * *", prompt: "do it", enabled: true },
      ]),
      runNow: vi.fn().mockReturnValue("job-run-1"),
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const jobs = opts?.withJobs ? new JobService({ store, agent: agent as any }) : undefined;

    app = await createGateway({
      port: 0,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      agent: agent as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      scheduler: scheduler as any,
      jobs,
      store,
      gatewayApiToken: TOKEN,
      owntracksToken: opts?.withOwntracks ? "ot-secret" : undefined,
      workDir: opts?.withOwntracks ? tmpDir : undefined,
    });

    return { app, store, agent, scheduler, jobs };
  }

  // --- GET /health ---

  it("GET /health returns { status, uptime, timestamp }", async () => {
    await createApp();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({
      status: "ok",
      uptime: expect.any(Number),
      timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
  });

  // --- POST /webhook (async mode with JobService) ---

  it("POST /webhook (async) returns 202 { jobId, status }", async () => {
    await createApp({ withJobs: true });
    const res = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: auth(),
      payload: { prompt: "test prompt", sessionId: "s1" },
    });
    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body);
    expect(typeof body.jobId).toBe("string");
    expect(body.status).toBe("queued");
    // No extra unexpected keys
    expect(Object.keys(body).sort()).toEqual(["jobId", "status"]);
  });

  // --- POST /webhook (sync fallback without JobService) ---

  it("POST /webhook (sync) returns 200 { text, sessionId, durationMs, totalCostUsd, isError }", async () => {
    const { createGateway } = await import("./gateway.js");
    const agent = makeAgent();
    app = await createGateway({
      port: 0,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      agent: agent as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      scheduler: { add: vi.fn(), remove: vi.fn(), list: vi.fn().mockReturnValue([]), runNow: vi.fn() } as any,
      // No jobs, no gatewayApiToken — open access
    });
    const res = await app.inject({
      method: "POST",
      url: "/webhook",
      payload: { prompt: "sync test" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(typeof body.text).toBe("string");
    expect(typeof body.sessionId).toBe("string");
    expect(typeof body.durationMs).toBe("number");
    expect(typeof body.totalCostUsd).toBe("number");
    expect(typeof body.isError).toBe("boolean");
  });

  // --- POST /webhook validation ---

  it("POST /webhook returns 400 when prompt is missing", async () => {
    await createApp({ withJobs: true });
    const res = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: auth(),
      payload: { sessionId: "s1" },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBeTruthy();
  });

  // --- GET /tasks ---

  it("GET /tasks returns { tasks: ScheduledTask[] }", async () => {
    await createApp();
    const res = await app.inject({ method: "GET", url: "/tasks", headers: auth() });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.tasks)).toBe(true);
    expect(body.tasks.length).toBe(1);
    const task = body.tasks[0];
    expect(typeof task.id).toBe("string");
    expect(typeof task.name).toBe("string");
    expect(typeof task.schedule).toBe("string");
    expect(typeof task.prompt).toBe("string");
    expect(typeof task.enabled).toBe("boolean");
  });

  // --- POST /tasks ---

  it("POST /tasks returns { ok, task }", async () => {
    await createApp();
    const res = await app.inject({
      method: "POST",
      url: "/tasks",
      headers: auth(),
      payload: { id: "t2", name: "New Task", schedule: "*/5 * * * *", prompt: "run this" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.task.id).toBe("t2");
  });

  it("POST /tasks returns 400 when required fields are missing", async () => {
    await createApp();
    const res = await app.inject({
      method: "POST",
      url: "/tasks",
      headers: auth(),
      payload: { id: "t3" },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBeTruthy();
  });

  // --- DELETE /tasks/:id ---

  it("DELETE /tasks/:id returns { ok: true }", async () => {
    await createApp();
    const res = await app.inject({
      method: "DELETE",
      url: "/tasks/t1",
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);
  });

  // --- POST /tasks/:id/run ---

  it("POST /tasks/:id/run returns { ok, jobId }", async () => {
    await createApp();
    const res = await app.inject({
      method: "POST",
      url: "/tasks/t1/run",
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(typeof body.jobId).toBe("string");
  });

  // --- GET /admin/status ---

  it("GET /admin/status returns { status, uptime, metrics, tasks, recentJobs }", async () => {
    await createApp({ withJobs: true });
    const res = await app.inject({
      method: "GET",
      url: "/admin/status",
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("ok");
    expect(typeof body.uptime).toBe("number");
    expect(typeof body.metrics).toBe("object");
    expect(typeof body.tasks).toBe("number");
    expect(Array.isArray(body.recentJobs)).toBe(true);
  });

  // --- GET /admin/jobs ---

  it("GET /admin/jobs returns { jobs: JobRecord[] }", async () => {
    await createApp({ withJobs: true });
    const res = await app.inject({
      method: "GET",
      url: "/admin/jobs",
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.jobs)).toBe(true);
  });

  // --- GET /admin/events ---

  it("GET /admin/events returns { events: Event[] }", async () => {
    const { store } = await createApp();
    store.addEvent("contract-test", { detail: "value" });

    const res = await app.inject({
      method: "GET",
      url: "/admin/events",
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.events)).toBe(true);
    expect(body.events.length).toBeGreaterThanOrEqual(1);
    const event = body.events[0];
    expect(typeof event.id).toBe("number");
    expect(typeof event.eventType).toBe("string");
    expect(typeof event.details).toBe("object");
    expect(typeof event.createdAt).toBe("string");
  });

  // --- GET /admin/metrics ---

  it("GET /admin/metrics returns a metrics object", async () => {
    await createApp();
    const res = await app.inject({
      method: "GET",
      url: "/admin/metrics",
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(typeof body).toBe("object");
  });

  // --- POST /owntracks ---

  it("POST /owntracks returns [] on valid location", async () => {
    await createApp({ withOwntracks: true });
    const res = await app.inject({
      method: "POST",
      url: "/owntracks",
      headers: { authorization: "Bearer ot-secret" },
      payload: { _type: "location", lat: -37.81, lon: 144.96, tst: Math.floor(Date.now() / 1000) },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual([]);
  });

  it("POST /owntracks returns 401 with wrong token", async () => {
    await createApp({ withOwntracks: true });
    const res = await app.inject({
      method: "POST",
      url: "/owntracks",
      headers: { authorization: "Bearer wrong" },
      payload: { _type: "location", lat: -37.81, lon: 144.96, tst: 1700000000 },
    });
    expect(res.statusCode).toBe(401);
  });

  it("POST /owntracks returns 400 for non-location payloads", async () => {
    await createApp({ withOwntracks: true });
    const res = await app.inject({
      method: "POST",
      url: "/owntracks",
      headers: { authorization: "Bearer ot-secret" },
      payload: { _type: "waypoint", desc: "home" },
    });
    expect(res.statusCode).toBe(400);
  });

  // --- Auth enforcement ---

  it("all protected routes return 401 without auth", async () => {
    await createApp();
    const protectedRoutes = [
      { method: "POST" as const, url: "/webhook", payload: { prompt: "test" } },
      { method: "GET" as const, url: "/tasks" },
      { method: "POST" as const, url: "/tasks", payload: { id: "x", name: "x", schedule: "* * * * *", prompt: "x" } },
      { method: "DELETE" as const, url: "/tasks/x" },
      { method: "POST" as const, url: "/tasks/x/run" },
      { method: "GET" as const, url: "/admin/status" },
      { method: "GET" as const, url: "/admin/jobs" },
      { method: "GET" as const, url: "/admin/events" },
      { method: "GET" as const, url: "/admin/metrics" },
    ];

    for (const route of protectedRoutes) {
      const res = await app.inject({
        method: route.method,
        url: route.url,
        payload: "payload" in route ? route.payload : undefined,
      });
      expect(res.statusCode).toBe(401);
    }
  });

  // --- Security headers ---

  it("all responses include security headers", async () => {
    await createApp();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });
});
