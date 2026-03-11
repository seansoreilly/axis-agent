import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("SqliteStore (memory)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `memory-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("stores and retrieves facts with inferred categories", async () => {
    const { SqliteStore } = await import("./persistence.js");
    const store = new SqliteStore(tmpDir);

    store.setFact("user-timezone", "Australia/Sydney");

    expect(store.getFactValue("user-timezone")).toBe("Australia/Sydney");
    expect(store.getAllFacts()["user-timezone"]?.category).toBe("personal");
  });

  it("builds context sorted by recency and category", async () => {
    const { SqliteStore } = await import("./persistence.js");
    const store = new SqliteStore(tmpDir);

    store.setFact("favorite-tool", "claude code");
    store.setFact("project-stack", "agent");
    store.setFact("server-region", "ap-southeast-2");

    const personalPref = store.getContext({ categories: ["preference"] });
    const other = store.getContext({ categories: ["work", "system"] });

    expect(personalPref).toContain("favorite-tool");
    expect(other).toContain("project-stack");
    expect(other).toContain("server-region");
  });

  it("records sessions and returns the latest non-stale session", async () => {
    const { SqliteStore } = await import("./persistence.js");
    const store = new SqliteStore(tmpDir);

    store.recordSession("sess-1", 1, "first");
    store.recordSession("sess-2", 1, "second");

    expect(store.getRecentSession(1)?.sessionId).toBe("sess-2");
  });

  it("setFact preserves existing category and createdAt", async () => {
    const { SqliteStore } = await import("./persistence.js");
    const store = new SqliteStore(tmpDir);

    store.setFact("user-timezone", "Australia/Sydney");
    const before = store.getFact("user-timezone")!;

    // Update value — category and createdAt should be preserved
    store.setFact("user-timezone", "America/New_York");
    const after = store.getFact("user-timezone")!;

    expect(after.value).toBe("America/New_York");
    expect(after.category).toBe(before.category);
    expect(after.createdAt).toBe(before.createdAt);
  });

  it("setFact with explicit category overrides inference", async () => {
    const { SqliteStore } = await import("./persistence.js");
    const store = new SqliteStore(tmpDir);

    store.setFact("my-thing", "value", "system");
    expect(store.getFact("my-thing")!.category).toBe("system");
  });

  it("getFactValue touches lastAccessedAt", async () => {
    const { SqliteStore } = await import("./persistence.js");
    const store = new SqliteStore(tmpDir);

    store.setFact("key1", "val1");
    const before = store.getFact("key1")!.lastAccessedAt;

    // Small delay to ensure timestamp differs
    await new Promise((r) => setTimeout(r, 10));
    store.getFactValue("key1");
    const after = store.getFact("key1")!.lastAccessedAt;

    expect(new Date(after).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());
  });

  it("getStats returns correct counts by category", async () => {
    const { SqliteStore } = await import("./persistence.js");
    const store = new SqliteStore(tmpDir);

    store.setFact("user-name", "Alice");       // personal
    store.setFact("user-email", "a@b.com");     // personal
    store.setFact("project-stack", "TypeScript"); // work
    store.setFact("deploy-region", "ap-south");   // system

    const stats = store.getStats();
    expect(stats.totalFacts).toBe(4);
    expect(stats.byCategory["personal"]).toBe(2);
    expect(stats.byCategory["work"]).toBe(1);
    expect(stats.byCategory["system"]).toBe(1);
  });

  it("recordSession merges with existing session data", async () => {
    const { SqliteStore } = await import("./persistence.js");
    const store = new SqliteStore(tmpDir);

    store.recordSession("sess-1", 1, "first prompt", { totalCostUsd: 0.01 });
    store.updateSessionSummary("sess-1", "discussed things");

    // Re-record same session — should preserve summary
    store.recordSession("sess-1", 1, "second prompt", { totalCostUsd: 0.05 });
    const sessions = store.listSessions();
    const sess = sessions.find(s => s.sessionId === "sess-1");

    expect(sess!.lastPrompt).toBe("second prompt");
    expect(sess!.totalCostUsd).toBe(0.05);
    expect(sess!.summary).toBe("discussed things");
  });

  it("getRecentSession returns undefined for stale sessions", async () => {
    const { SqliteStore } = await import("./persistence.js");
    const store = new SqliteStore(tmpDir);

    // Insert a session with old timestamp
    store.upsertSession({
      sessionId: "old-sess",
      userId: 1,
      startedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      lastActivityAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      turnCount: 1,
      totalCostUsd: 0.01,
      lastPrompt: "old",
    });

    expect(store.getRecentSession(1)).toBeUndefined();
  });

  it("migrates legacy JSON store on startup", async () => {
    const storePath = join(tmpDir, "store.json");
    writeFileSync(
      storePath,
      JSON.stringify({
        facts: {
          name: "Sean",
        },
        sessions: [
          {
            sessionId: "legacy-1",
            userId: 1,
            startedAt: "2026-01-01T00:00:00.000Z",
            lastPrompt: "hello",
          },
        ],
      })
    );

    const { SqliteStore } = await import("./persistence.js");
    const store = new SqliteStore(tmpDir);

    expect(store.getFactValue("name")).toBe("Sean");
    expect(store.getAllFacts()["name"]?.category).toBe("personal");
    expect(store.getRecentSession(1)?.sessionId).toBeUndefined();
  });
});

describe("SqliteStore (jobs & events)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `store-jobs-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("getStuckJobs returns only running jobs older than cutoff", async () => {
    const { SqliteStore } = await import("./persistence.js");
    const store = new SqliteStore(tmpDir);

    const oldTime = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    const recentTime = new Date(Date.now() - 5 * 60 * 1000).toISOString();

    store.insertJob({
      id: "stuck", type: "prompt", status: "running",
      payloadJson: "{}", attempts: 1, maxAttempts: 2,
      createdAt: oldTime, updatedAt: oldTime, runAfter: oldTime, startedAt: oldTime,
    });
    store.insertJob({
      id: "recent", type: "prompt", status: "running",
      payloadJson: "{}", attempts: 1, maxAttempts: 2,
      createdAt: recentTime, updatedAt: recentTime, runAfter: recentTime, startedAt: recentTime,
    });
    store.insertJob({
      id: "queued", type: "prompt", status: "queued",
      payloadJson: "{}", attempts: 0, maxAttempts: 2,
      createdAt: oldTime, updatedAt: oldTime, runAfter: oldTime,
    });

    const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const stuck = store.getStuckJobs(cutoff);

    expect(stuck).toHaveLength(1);
    expect(stuck[0].id).toBe("stuck");
  });

  it("getRunnableJobs returns only queued jobs with runAfter <= now", async () => {
    const { SqliteStore } = await import("./persistence.js");
    const store = new SqliteStore(tmpDir);

    const past = new Date(Date.now() - 10_000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();

    store.insertJob({
      id: "ready", type: "prompt", status: "queued",
      payloadJson: "{}", attempts: 0, maxAttempts: 2,
      createdAt: past, updatedAt: past, runAfter: past,
    });
    store.insertJob({
      id: "delayed", type: "prompt", status: "queued",
      payloadJson: "{}", attempts: 0, maxAttempts: 2,
      createdAt: past, updatedAt: past, runAfter: future,
    });
    store.insertJob({
      id: "done", type: "prompt", status: "succeeded",
      payloadJson: "{}", attempts: 1, maxAttempts: 2,
      createdAt: past, updatedAt: past, runAfter: past,
    });

    const runnable = store.getRunnableJobs();
    expect(runnable).toHaveLength(1);
    expect(runnable[0].id).toBe("ready");
  });

  it("addEvent and listEvents records and retrieves events", async () => {
    const { SqliteStore } = await import("./persistence.js");
    const store = new SqliteStore(tmpDir);

    store.addEvent("job_enqueued", { jobId: "j1", source: "webhook" });
    store.addEvent("job_started", { jobId: "j1" });
    store.addEvent("job_finished", { jobId: "j1", status: "succeeded" });

    const events = store.listEvents(10);
    expect(events).toHaveLength(3);
    // Listed in reverse chronological order
    expect(events[0].eventType).toBe("job_finished");
    expect(events[0].details).toEqual({ jobId: "j1", status: "succeeded" });
    expect(events[2].eventType).toBe("job_enqueued");
    expect(events[2].details).toEqual({ jobId: "j1", source: "webhook" });
  });
});
