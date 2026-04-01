import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Agent, AgentResult } from "./agent.js";
import type { Scheduler, ScheduledTask } from "./scheduler.js";

const TEST_TOKEN = "test-gateway-token";

// ---------------------------------------------------------------------------
// Typed mock factories
// ---------------------------------------------------------------------------

type MockAgent = Pick<Agent, "run"> & { run: ReturnType<typeof vi.fn> };
type MockScheduler = Pick<Scheduler, "add" | "remove" | "list" | "runNow"> & {
  add: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  runNow: ReturnType<typeof vi.fn>;
};

function makeAgent(): MockAgent {
  return {
    run: vi.fn<Parameters<Agent["run"]>, Promise<AgentResult>>().mockResolvedValue({
      text: "done",
      sessionId: "sess-1",
      durationMs: 42,
      totalCostUsd: 0.02,
      isError: false,
      isTimeout: false,
    }),
  };
}

function makeScheduler(): MockScheduler {
  return {
    add: vi.fn<[ScheduledTask], void>(),
    remove: vi.fn<[string], boolean>().mockReturnValue(true),
    list: vi.fn<[], ScheduledTask[]>().mockReturnValue([]),
    runNow: vi.fn<[string], string>().mockReturnValue("job-manual-1"),
  };
}

// ---------------------------------------------------------------------------
// Mock fs to capture file writes without touching disk
// ---------------------------------------------------------------------------

let capturedWritePath: string | null = null;
let capturedWriteData: string | null = null;
let capturedRenamePaths: { from: string; to: string } | null = null;
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeFileSync: vi.fn().mockImplementation((path: string, data: string) => {
      capturedWritePath = path;
      capturedWriteData = data;
    }),
    renameSync: vi.fn().mockImplementation((from: string, to: string) => {
      capturedRenamePaths = { from, to };
    }),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function authHeader(): { authorization: string } {
  return { authorization: `Bearer ${TEST_TOKEN}` };
}

/** Create gateway with sensible defaults — avoids repeating agent/scheduler casts in every test. */
async function createTestGateway(overrides: {
  agent?: MockAgent;
  scheduler?: MockScheduler;
  gatewayApiToken?: string;
  workDir?: string;
  owntracksToken?: string;
  store?: import("./persistence.js").SqliteStore;
  jobs?: import("./jobs.js").JobService;
} = {}): Promise<{
  app: Awaited<ReturnType<typeof import("./gateway.js")["createGateway"]>>;
  agent: MockAgent;
  scheduler: MockScheduler;
}> {
  const { createGateway } = await import("./gateway.js");
  const agent = overrides.agent ?? makeAgent();
  const scheduler = overrides.scheduler ?? makeScheduler();

  const app = await createGateway({
    port: 0,
    agent: agent as unknown as Agent,
    scheduler: scheduler as unknown as Scheduler,
    gatewayApiToken: overrides.gatewayApiToken,
    workDir: overrides.workDir,
    owntracksToken: overrides.owntracksToken,
    store: overrides.store,
    jobs: overrides.jobs,
  });

  return { app, agent, scheduler };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Gateway", () => {
  let app: Awaited<ReturnType<typeof import("./gateway.js")["createGateway"]>> | undefined;
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedWritePath = null;
    capturedWriteData = null;
    capturedRenamePaths = null;
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
    const { app: a, agent } = await createTestGateway({ gatewayApiToken: TEST_TOKEN });
    app = a;

    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);

    const webhook = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: authHeader(),
      payload: { prompt: "hello", sessionId: "sess-old" },
    });

    expect(webhook.statusCode).toBe(200);
    expect(agent.run).toHaveBeenCalledWith("hello", expect.objectContaining({ sessionId: "sess-old", correlationId: expect.any(String) }));
  });

  it("manages scheduled tasks through HTTP", async () => {
    const { app: a, scheduler } = await createTestGateway({ gatewayApiToken: TEST_TOKEN });
    app = a;

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
    const { app: a } = await createTestGateway({
      workDir: tmpDir,
      owntracksToken: "secret",
      gatewayApiToken: TEST_TOKEN,
    });
    app = a;

    const response = await app.inject({
      method: "POST",
      url: "/owntracks",
      headers: { authorization: "Bearer secret" },
      payload: { _type: "location", lat: -33.86, lon: 151.2, tst: Math.floor(Date.now() / 1000) },
    });

    expect(response.statusCode).toBe(200);
    expect(capturedWritePath).toContain("current-location.json");
  });

  it("exposes admin endpoints", async () => {
    const { SqliteStore } = await import("./persistence.js");
    const store = new SqliteStore(tmpDir);

    const { app: a } = await createTestGateway({ store, gatewayApiToken: TEST_TOKEN });
    app = a;

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
    const { app: a, agent } = await createTestGateway({ gatewayApiToken: TEST_TOKEN });
    app = a;

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
    const { app: a, agent } = await createTestGateway({ gatewayApiToken: TEST_TOKEN });
    app = a;

    const webhook = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: { authorization: "Bearer wrong-token" },
      payload: { prompt: "hello" },
    });
    expect(webhook.statusCode).toBe(401);
    expect(agent.run).not.toHaveBeenCalled();
  });

  it("rejects access with 403 when GATEWAY_API_TOKEN is not set", async () => {
    const { app: a, agent } = await createTestGateway();
    app = a;

    const webhook = await app.inject({
      method: "POST",
      url: "/webhook",
      payload: { prompt: "hello" },
    });
    expect(webhook.statusCode).toBe(403);
    expect(agent.run).not.toHaveBeenCalled();
  });

  it("returns 202 with jobId when JobService is configured (async webhook)", async () => {
    const { SqliteStore } = await import("./persistence.js");
    const { JobService } = await import("./jobs.js");
    const agent = makeAgent();
    const store = new SqliteStore(tmpDir);
    const jobs = new JobService({ store, agent: agent as unknown as Agent });

    const { app: a } = await createTestGateway({
      agent,
      store,
      jobs,
      gatewayApiToken: TEST_TOKEN,
    });
    app = a;

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
    const { app: a, agent } = await createTestGateway({ gatewayApiToken: TEST_TOKEN });
    app = a;

    const webhook = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: authHeader(),
      payload: { prompt: "direct" },
    });

    expect(webhook.statusCode).toBe(200);
    const body = JSON.parse(webhook.body);
    expect(body.text).toBe("done");
    expect(body.isError).toBe(false);
    expect(agent.run).toHaveBeenCalledWith("direct", expect.objectContaining({ sessionId: undefined, correlationId: expect.any(String) }));
  });

  it("triggers a task run on demand via POST /tasks/:id/run", async () => {
    const { app: a, scheduler } = await createTestGateway({ gatewayApiToken: TEST_TOKEN });
    app = a;

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
    const scheduler = makeScheduler();
    scheduler.runNow.mockImplementation(() => {
      throw new Error("Task not found: nope");
    });

    const { app: a } = await createTestGateway({ scheduler, gatewayApiToken: TEST_TOKEN });
    app = a;

    const response = await app.inject({
      method: "POST",
      url: "/tasks/nope/run",
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(404);
  });

  it("webhook sync response includes sessionId from agent result", async () => {
    const { app: a } = await createTestGateway({ gatewayApiToken: TEST_TOKEN });
    app = a;

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
    const { app: a, agent } = await createTestGateway({ gatewayApiToken: TEST_TOKEN });
    app = a;

    await app.inject({
      method: "POST",
      url: "/webhook",
      headers: authHeader(),
      payload: { prompt: "no session here" },
    });

    expect(agent.run).toHaveBeenCalledWith("no session here", expect.objectContaining({ sessionId: undefined, correlationId: expect.any(String) }));
  });

  it("includes security headers from helmet", async () => {
    const { app: a } = await createTestGateway();
    app = a;

    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.headers["x-content-type-options"]).toBe("nosniff");
    expect(health.headers["x-frame-options"]).toBe("SAMEORIGIN");
  });

  it("GET /admin/events returns events array with correct shape", async () => {
    const { SqliteStore } = await import("./persistence.js");
    const store = new SqliteStore(tmpDir);
    store.addEvent("test-event", { detail: "value" });

    const { app: a } = await createTestGateway({ store, gatewayApiToken: TEST_TOKEN });
    app = a;

    const res = await app.inject({ method: "GET", url: "/admin/events", headers: authHeader() });
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

  it("POST /tasks returns 400 when required fields are missing", async () => {
    const { app: a } = await createTestGateway({ gatewayApiToken: TEST_TOKEN });
    app = a;

    const res = await app.inject({
      method: "POST",
      url: "/tasks",
      headers: authHeader(),
      payload: { id: "t3" },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBeTruthy();
  });

  it("POST /owntracks returns 400 for non-location payloads", async () => {
    const { app: a } = await createTestGateway({
      workDir: tmpDir,
      owntracksToken: "secret",
      gatewayApiToken: TEST_TOKEN,
    });
    app = a;

    const res = await app.inject({
      method: "POST",
      url: "/owntracks",
      headers: { authorization: "Bearer secret" },
      payload: { _type: "waypoint", desc: "home" },
    });
    expect(res.statusCode).toBe(400);
  });

  // --- OwnTracks: Basic auth coverage ---

  it("accepts owntracks updates with HTTP Basic auth (iOS)", async () => {
    const { app: a } = await createTestGateway({
      workDir: tmpDir,
      owntracksToken: "secret",
      gatewayApiToken: TEST_TOKEN,
    });
    app = a;

    const basicAuth = Buffer.from("iosuser:secret").toString("base64");
    const response = await app.inject({
      method: "POST",
      url: "/owntracks",
      headers: { authorization: `Basic ${basicAuth}` },
      payload: { _type: "location", lat: -33.86, lon: 151.2, tst: Math.floor(Date.now() / 1000) },
    });

    expect(response.statusCode).toBe(200);
    expect(capturedWritePath).toContain("current-location.json");
  });

  it("rejects owntracks with wrong Basic auth password", async () => {
    const { app: a } = await createTestGateway({
      workDir: tmpDir,
      owntracksToken: "secret",
      gatewayApiToken: TEST_TOKEN,
    });
    app = a;

    const basicAuth = Buffer.from("user:wrong-password").toString("base64");
    const response = await app.inject({
      method: "POST",
      url: "/owntracks",
      headers: { authorization: `Basic ${basicAuth}` },
      payload: { _type: "location", lat: -33.86, lon: 151.2, tst: Math.floor(Date.now() / 1000) },
    });

    expect(response.statusCode).toBe(401);
  });

  it("handles Basic auth with colons in password", async () => {
    const { app: a } = await createTestGateway({
      workDir: tmpDir,
      owntracksToken: "pass:with:colons",
      gatewayApiToken: TEST_TOKEN,
    });
    app = a;

    const basicAuth = Buffer.from("user:pass:with:colons").toString("base64");
    const response = await app.inject({
      method: "POST",
      url: "/owntracks",
      headers: { authorization: `Basic ${basicAuth}` },
      payload: { _type: "location", lat: -33.86, lon: 151.2, tst: Math.floor(Date.now() / 1000) },
    });

    expect(response.statusCode).toBe(200);
    expect(capturedWritePath).toContain("current-location.json");
  });

  it("rejects owntracks with no auth header", async () => {
    const { app: a } = await createTestGateway({
      workDir: tmpDir,
      owntracksToken: "secret",
      gatewayApiToken: TEST_TOKEN,
    });
    app = a;

    const response = await app.inject({
      method: "POST",
      url: "/owntracks",
      payload: { _type: "location", lat: -33.86, lon: 151.2, tst: Math.floor(Date.now() / 1000) },
    });

    expect(response.statusCode).toBe(401);
  });

  // --- OwnTracks: Timestamp validation ---

  it("rejects owntracks location with timestamp too far in the future", async () => {
    const { app: a } = await createTestGateway({
      workDir: tmpDir,
      owntracksToken: "secret",
      gatewayApiToken: TEST_TOKEN,
    });
    app = a;

    const futureTs = Math.floor(Date.now() / 1000) + 3600; // 1 hour in the future
    const response = await app.inject({
      method: "POST",
      url: "/owntracks",
      headers: { authorization: "Bearer secret" },
      payload: { _type: "location", lat: -33.86, lon: 151.2, tst: futureTs },
    });

    expect(response.statusCode).toBe(400);
  });

  it("accepts owntracks location with recent timestamp (within 24h)", async () => {
    const { app: a } = await createTestGateway({
      workDir: tmpDir,
      owntracksToken: "secret",
      gatewayApiToken: TEST_TOKEN,
    });
    app = a;

    const recentTs = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
    const response = await app.inject({
      method: "POST",
      url: "/owntracks",
      headers: { authorization: "Bearer secret" },
      payload: { _type: "location", lat: -33.86, lon: 151.2, tst: recentTs },
    });

    expect(response.statusCode).toBe(200);
    expect(capturedWritePath).toContain("current-location.json");
  });

  it("rejects owntracks location with very stale timestamp (>24h old)", async () => {
    const { app: a } = await createTestGateway({
      workDir: tmpDir,
      owntracksToken: "secret",
      gatewayApiToken: TEST_TOKEN,
    });
    app = a;

    const staleTs = Math.floor(Date.now() / 1000) - (48 * 3600); // 48 hours ago
    const response = await app.inject({
      method: "POST",
      url: "/owntracks",
      headers: { authorization: "Bearer secret" },
      payload: { _type: "location", lat: -33.86, lon: 151.2, tst: staleTs },
    });

    expect(response.statusCode).toBe(400);
  });

  // --- OwnTracks: Atomic file writes ---

  it("writes location file atomically (write-then-rename)", async () => {
    capturedRenamePaths = null;
    const { app: a } = await createTestGateway({
      workDir: tmpDir,
      owntracksToken: "secret",
      gatewayApiToken: TEST_TOKEN,
    });
    app = a;

    await app.inject({
      method: "POST",
      url: "/owntracks",
      headers: { authorization: "Bearer secret" },
      payload: { _type: "location", lat: -33.86, lon: 151.2, tst: Math.floor(Date.now() / 1000) },
    });

    expect(capturedWritePath).toContain(".tmp");
    expect(capturedRenamePaths).not.toBeNull();
    expect(capturedRenamePaths!.from).toContain(".tmp");
    expect(capturedRenamePaths!.to).toContain("current-location.json");
    expect(capturedRenamePaths!.to).not.toContain(".tmp");
  });

  // --- OwnTracks: Data shape validation ---

  it("writes correct location data shape to file", async () => {
    capturedWriteData = null;
    const { app: a } = await createTestGateway({
      workDir: tmpDir,
      owntracksToken: "secret",
      gatewayApiToken: TEST_TOKEN,
    });
    app = a;

    const tst = Math.floor(Date.now() / 1000);
    await app.inject({
      method: "POST",
      url: "/owntracks",
      headers: { authorization: "Bearer secret" },
      payload: { _type: "location", lat: -33.86, lon: 151.2, tst, acc: 5, alt: 42, vel: 10, batt: 85, conn: "w" },
    });

    expect(capturedWriteData).not.toBeNull();
    const data = JSON.parse(capturedWriteData!);
    expect(data.lat).toBe(-33.86);
    expect(data.lon).toBe(151.2);
    expect(data.accuracy).toBe(5);
    expect(data.altitude).toBe(42);
    expect(data.velocity).toBe(10);
    expect(data.battery).toBe(85);
    expect(data.connection).toBe("w");
    expect(data.timestamp).toBe(new Date(tst * 1000).toISOString());
    expect(typeof data.receivedAt).toBe("string");
    expect(typeof data.localTime).toBe("string");
  });

  it("all protected routes return 401 without auth", async () => {
    const { app: a } = await createTestGateway({ gatewayApiToken: TEST_TOKEN });
    app = a;

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
      expect(res.statusCode, `expected 401 for ${route.method} ${route.url}`).toBe(401);
    }
  });
});
