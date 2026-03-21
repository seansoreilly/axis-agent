import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_TOKEN = "test-gateway-token";

function makeAgent() {
  return {
    run: vi.fn().mockResolvedValue({
      text: "done",
      sessionId: "sess-1",
      durationMs: 42,
      totalCostUsd: 0.02,
      isError: false,
    }),
  };
}

function makeScheduler() {
  return {
    add: vi.fn(),
    remove: vi.fn().mockReturnValue(true),
    list: vi.fn().mockReturnValue([]),
    runNow: vi.fn().mockReturnValue("job-manual-1"),
  };
}

let capturedWritePath: string | null = null;
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeFileSync: vi.fn().mockImplementation((path: string) => {
      capturedWritePath = path;
    }),
  };
});

function authHeader() {
  return { authorization: `Bearer ${TEST_TOKEN}` };
}

describe("Gateway", () => {
  let app: Awaited<ReturnType<typeof import("./gateway.js")["createGateway"]>> | undefined;
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = join(tmpdir(), `gateway-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("exposes health and webhook endpoints", async () => {
    const { createGateway } = await import("./gateway.js");
    const agent = makeAgent();
    const scheduler = makeScheduler();

    app = await createGateway({
      port: 0,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      agent: agent as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      scheduler: scheduler as any,
      gatewayApiToken: TEST_TOKEN,
    });

    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);

    const webhook = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: authHeader(),
      payload: { prompt: "hello", sessionId: "sess-old" },
    });

    expect(webhook.statusCode).toBe(200);
    expect(agent.run).toHaveBeenCalledWith("hello", { sessionId: "sess-old" });
  });

  it("manages scheduled tasks through HTTP", async () => {
    const { createGateway } = await import("./gateway.js");
    const agent = makeAgent();
    const scheduler = makeScheduler();

    app = await createGateway({
      port: 0,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      agent: agent as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      scheduler: scheduler as any,
      gatewayApiToken: TEST_TOKEN,
    });

    const create = await app.inject({
      method: "POST",
      url: "/tasks",
      headers: authHeader(),
      payload: { id: "t1", name: "Test", schedule: "0 * * * *", prompt: "run" },
    });
    expect(create.statusCode).toBe(200);
    expect(scheduler.add).toHaveBeenCalled();

    const remove = await app.inject({
      method: "DELETE",
      url: "/tasks/t1",
      headers: authHeader(),
    });
    expect(remove.statusCode).toBe(200);
    expect(scheduler.remove).toHaveBeenCalledWith("t1");
  });

  it("accepts owntracks updates with bearer auth", async () => {
    capturedWritePath = null;
    const { createGateway } = await import("./gateway.js");
    const agent = makeAgent();
    const scheduler = makeScheduler();

    app = await createGateway({
      port: 0,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      agent: agent as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      scheduler: scheduler as any,
      workDir: tmpDir,
      owntracksToken: "secret",
      gatewayApiToken: TEST_TOKEN,
    });

    const response = await app.inject({
      method: "POST",
      url: "/owntracks",
      headers: { authorization: "Bearer secret" },
      payload: { _type: "location", lat: -33.86, lon: 151.2, tst: 1760000000 },
    });

    expect(response.statusCode).toBe(200);
    expect(capturedWritePath).toContain("current-location.json");
  });

  it("exposes admin endpoints", async () => {
    const { createGateway } = await import("./gateway.js");
    const { SqliteStore } = await import("./persistence.js");
    const agent = makeAgent();
    const scheduler = makeScheduler();
    const store = new SqliteStore(tmpDir);

    app = await createGateway({
      port: 0,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      agent: agent as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      scheduler: scheduler as any,
      store,
      gatewayApiToken: TEST_TOKEN,
    });

    const status = await app.inject({
      method: "GET",
      url: "/admin/status",
      headers: authHeader(),
    });
    const metricsResp = await app.inject({
      method: "GET",
      url: "/admin/metrics",
      headers: authHeader(),
    });

    expect(status.statusCode).toBe(200);
    expect(metricsResp.statusCode).toBe(200);
  });

  it("returns 401 for protected endpoints without auth token", async () => {
    const { createGateway } = await import("./gateway.js");
    const agent = makeAgent();
    const scheduler = makeScheduler();

    app = await createGateway({
      port: 0,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      agent: agent as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      scheduler: scheduler as any,
      gatewayApiToken: TEST_TOKEN,
    });

    const webhook = await app.inject({
      method: "POST",
      url: "/webhook",
      payload: { prompt: "hello" },
    });
    expect(webhook.statusCode).toBe(401);

    const tasks = await app.inject({ method: "GET", url: "/tasks" });
    expect(tasks.statusCode).toBe(401);

    const admin = await app.inject({ method: "GET", url: "/admin/status" });
    expect(admin.statusCode).toBe(401);

    // Health should still be accessible without auth
    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
  });

  it("returns 401 for wrong auth token", async () => {
    const { createGateway } = await import("./gateway.js");
    const agent = makeAgent();
    const scheduler = makeScheduler();

    app = await createGateway({
      port: 0,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      agent: agent as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      scheduler: scheduler as any,
      gatewayApiToken: TEST_TOKEN,
    });

    const webhook = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: { authorization: "Bearer wrong-token" },
      payload: { prompt: "hello" },
    });
    expect(webhook.statusCode).toBe(401);
    expect(agent.run).not.toHaveBeenCalled();
  });

  it("allows access without auth when GATEWAY_API_TOKEN is not set", async () => {
    const { createGateway } = await import("./gateway.js");
    const agent = makeAgent();
    const scheduler = makeScheduler();

    app = await createGateway({
      port: 0,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      agent: agent as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      scheduler: scheduler as any,
      // no gatewayApiToken — backward compatible open access
    });

    const webhook = await app.inject({
      method: "POST",
      url: "/webhook",
      payload: { prompt: "hello" },
    });
    expect(webhook.statusCode).toBe(200);
    expect(agent.run).toHaveBeenCalled();
  });

  it("returns 202 with jobId when JobService is configured (async webhook)", async () => {
    const { createGateway } = await import("./gateway.js");
    const { SqliteStore } = await import("./persistence.js");
    const { JobService } = await import("./jobs.js");
    const agent = makeAgent();
    const scheduler = makeScheduler();
    const store = new SqliteStore(tmpDir);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const jobs = new JobService({ store, agent: agent as any });

    app = await createGateway({
      port: 0,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      agent: agent as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      scheduler: scheduler as any,
      jobs,
      store,
      gatewayApiToken: TEST_TOKEN,
    });

    const webhook = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: authHeader(),
      payload: { prompt: "async job", sessionId: "s1" },
    });

    expect(webhook.statusCode).toBe(202);
    const body = JSON.parse(webhook.body);
    expect(body.jobId).toBeTruthy();
    expect(body.status).toBe("queued");

    // Job should be retrievable via admin endpoint
    const jobsResp = await app.inject({
      method: "GET",
      url: "/admin/jobs",
      headers: authHeader(),
    });
    const jobsList = JSON.parse(jobsResp.body).jobs;
    expect(jobsList.some((j: { id: string }) => j.id === body.jobId)).toBe(true);
  });

  it("returns 200 with direct result when no JobService (fallback)", async () => {
    const { createGateway } = await import("./gateway.js");
    const agent = makeAgent();
    const scheduler = makeScheduler();

    app = await createGateway({
      port: 0,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      agent: agent as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      scheduler: scheduler as any,
      // No jobs or gatewayApiToken — open access, direct execution
    });

    const webhook = await app.inject({
      method: "POST",
      url: "/webhook",
      payload: { prompt: "direct" },
    });

    expect(webhook.statusCode).toBe(200);
    const body = JSON.parse(webhook.body);
    expect(body.text).toBe("done");
    expect(body.isError).toBe(false);
    expect(agent.run).toHaveBeenCalledWith("direct", { sessionId: undefined });
  });

  it("triggers a task run on demand via POST /tasks/:id/run", async () => {
    const { createGateway } = await import("./gateway.js");
    const agent = makeAgent();
    const scheduler = makeScheduler();

    app = await createGateway({
      port: 0,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      agent: agent as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      scheduler: scheduler as any,
      gatewayApiToken: TEST_TOKEN,
    });

    const response = await app.inject({
      method: "POST",
      url: "/tasks/email-triage-hourly/run",
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.ok).toBe(true);
    expect(body.jobId).toBe("job-manual-1");
    expect(scheduler.runNow).toHaveBeenCalledWith("email-triage-hourly");
  });

  it("returns 404 when triggering nonexistent task", async () => {
    const { createGateway } = await import("./gateway.js");
    const agent = makeAgent();
    const scheduler = makeScheduler();
    scheduler.runNow.mockImplementation(() => {
      throw new Error("Task not found: nope");
    });

    app = await createGateway({
      port: 0,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      agent: agent as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      scheduler: scheduler as any,
      gatewayApiToken: TEST_TOKEN,
    });

    const response = await app.inject({
      method: "POST",
      url: "/tasks/nope/run",
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(404);
  });

  it("webhook sync response includes sessionId from agent result", async () => {
    const { createGateway } = await import("./gateway.js");
    const agent = makeAgent();
    const scheduler = makeScheduler();

    app = await createGateway({
      port: 0,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      agent: agent as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      scheduler: scheduler as any,
      gatewayApiToken: TEST_TOKEN,
    });

    const res = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: authHeader(),
      payload: { prompt: "hello" },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.sessionId).toBe("sess-1");
  });

  it("webhook without sessionId passes undefined to agent.run", async () => {
    const { createGateway } = await import("./gateway.js");
    const agent = makeAgent();
    const scheduler = makeScheduler();

    app = await createGateway({
      port: 0,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      agent: agent as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      scheduler: scheduler as any,
      gatewayApiToken: TEST_TOKEN,
    });

    await app.inject({
      method: "POST",
      url: "/webhook",
      headers: authHeader(),
      payload: { prompt: "no session here" },
    });

    expect(agent.run).toHaveBeenCalledWith("no session here", { sessionId: undefined });
  });

  it("includes security headers from helmet", async () => {
    const { createGateway } = await import("./gateway.js");
    const agent = makeAgent();
    const scheduler = makeScheduler();

    app = await createGateway({
      port: 0,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      agent: agent as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      scheduler: scheduler as any,
    });

    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.headers["x-content-type-options"]).toBe("nosniff");
    expect(health.headers["x-frame-options"]).toBe("SAMEORIGIN");
  });
});
