import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
  };
}

function makeMemory() {
  return {
    setFact: vi.fn(),
  };
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
    });

    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);

    const webhook = await app.inject({
      method: "POST",
      url: "/webhook",
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
    });

    const create = await app.inject({
      method: "POST",
      url: "/tasks",
      payload: { id: "t1", name: "Test", schedule: "0 * * * *", prompt: "run" },
    });
    expect(create.statusCode).toBe(200);
    expect(scheduler.add).toHaveBeenCalled();

    const remove = await app.inject({ method: "DELETE", url: "/tasks/t1" });
    expect(remove.statusCode).toBe(200);
    expect(scheduler.remove).toHaveBeenCalledWith("t1");
  });

  it("accepts owntracks updates with bearer auth", async () => {
    const { createGateway } = await import("./gateway.js");
    const agent = makeAgent();
    const scheduler = makeScheduler();
    const memory = makeMemory();

    app = await createGateway({
      port: 0,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      agent: agent as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      scheduler: scheduler as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      memory: memory as any,
      owntracksToken: "secret",
    });

    const response = await app.inject({
      method: "POST",
      url: "/owntracks",
      headers: { authorization: "Bearer secret" },
      payload: { _type: "location", lat: -33.86, lon: 151.2, tst: 1760000000 },
    });

    expect(response.statusCode).toBe(200);
    expect(memory.setFact).toHaveBeenCalledWith(
      "current-location",
      expect.any(String),
      "personal"
    );
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
    });

    const status = await app.inject({ method: "GET", url: "/admin/status" });
    const metrics = await app.inject({ method: "GET", url: "/admin/metrics" });

    expect(status.statusCode).toBe(200);
    expect(metrics.statusCode).toBe(200);
  });
});
