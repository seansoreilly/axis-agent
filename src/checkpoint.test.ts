import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CheckpointStore, buildResumePrompt, type Checkpoint } from "./checkpoint.js";

describe("CheckpointStore", () => {
  let store: CheckpointStore;

  beforeEach(() => {
    store = new CheckpointStore();
  });

  describe("save()", () => {
    it("creates a checkpoint with generated ID and timestamp", () => {
      const cp = store.save({
        userId: 1,
        sessionId: "sess-1",
        prompt: "Fix the bug",
        partialResponse: "I found the issue in...",
        toolsUsed: ["Read", "Bash"],
        metadata: { source: "telegram" },
      });

      expect(cp.id).toBeDefined();
      expect(cp.id.length).toBeGreaterThan(0);
      expect(cp.createdAt).toBeDefined();
      expect(new Date(cp.createdAt).toISOString()).toBe(cp.createdAt);
      expect(cp.userId).toBe(1);
      expect(cp.sessionId).toBe("sess-1");
      expect(cp.prompt).toBe("Fix the bug");
      expect(cp.partialResponse).toBe("I found the issue in...");
      expect(cp.toolsUsed).toEqual(["Read", "Bash"]);
      expect(cp.metadata).toEqual({ source: "telegram" });
    });

    it("sets status to paused", () => {
      const cp = store.save({
        userId: 1,
        sessionId: "sess-1",
        prompt: "Fix the bug",
        partialResponse: "",
        toolsUsed: [],
      });

      expect(cp.status).toBe("paused");
    });
  });

  describe("getLatest()", () => {
    it("returns most recent paused checkpoint for user", () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-03-22T10:00:00Z"));
        store.save({
          userId: 1,
          sessionId: "sess-1",
          prompt: "First task",
          partialResponse: "progress 1",
          toolsUsed: [],
        });

        vi.setSystemTime(new Date("2026-03-22T11:00:00Z"));
        const second = store.save({
          userId: 1,
          sessionId: "sess-2",
          prompt: "Second task",
          partialResponse: "progress 2",
          toolsUsed: [],
        });

        const latest = store.getLatest(1);
        expect(latest).not.toBeNull();
        expect(latest!.id).toBe(second.id);
        expect(latest!.prompt).toBe("Second task");
      } finally {
        vi.useRealTimers();
      }
    });

    it("returns null when no checkpoints exist", () => {
      expect(store.getLatest(999)).toBeNull();
    });

    it("ignores resumed/expired/discarded checkpoints", () => {
      const cp1 = store.save({
        userId: 1,
        sessionId: "sess-1",
        prompt: "Task 1",
        partialResponse: "",
        toolsUsed: [],
      });
      const cp2 = store.save({
        userId: 1,
        sessionId: "sess-2",
        prompt: "Task 2",
        partialResponse: "",
        toolsUsed: [],
      });
      const cp3 = store.save({
        userId: 1,
        sessionId: "sess-3",
        prompt: "Task 3",
        partialResponse: "",
        toolsUsed: [],
      });

      store.markResumed(cp1.id);
      store.discard(cp2.id);

      const latest = store.getLatest(1);
      expect(latest).not.toBeNull();
      expect(latest!.id).toBe(cp3.id);

      // Now discard the last one too
      store.discard(cp3.id);
      expect(store.getLatest(1)).toBeNull();
    });
  });

  describe("get()", () => {
    it("retrieves checkpoint by ID", () => {
      const cp = store.save({
        userId: 1,
        sessionId: "sess-1",
        prompt: "Do something",
        partialResponse: "partial",
        toolsUsed: ["Edit"],
      });

      const retrieved = store.get(cp.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(cp.id);
      expect(retrieved!.prompt).toBe("Do something");
    });

    it("returns null for missing ID", () => {
      expect(store.get("nonexistent-id")).toBeNull();
    });
  });

  describe("listForUser()", () => {
    it("returns all checkpoints for a user", () => {
      store.save({ userId: 1, sessionId: "s1", prompt: "A", partialResponse: "", toolsUsed: [] });
      store.save({ userId: 1, sessionId: "s2", prompt: "B", partialResponse: "", toolsUsed: [] });
      store.save({ userId: 2, sessionId: "s3", prompt: "C", partialResponse: "", toolsUsed: [] });

      const user1Checkpoints = store.listForUser(1);
      expect(user1Checkpoints).toHaveLength(2);
      expect(user1Checkpoints.map((c) => c.prompt)).toEqual(["A", "B"]);
    });

    it("returns empty array for unknown user", () => {
      expect(store.listForUser(999)).toEqual([]);
    });
  });

  describe("markResumed()", () => {
    it("changes status to resumed", () => {
      const cp = store.save({
        userId: 1,
        sessionId: "sess-1",
        prompt: "Task",
        partialResponse: "",
        toolsUsed: [],
      });

      store.markResumed(cp.id);

      const retrieved = store.get(cp.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.status).toBe("resumed");
    });
  });

  describe("discard()", () => {
    it("changes status to discarded", () => {
      const cp = store.save({
        userId: 1,
        sessionId: "sess-1",
        prompt: "Task",
        partialResponse: "",
        toolsUsed: [],
      });

      store.discard(cp.id);

      const retrieved = store.get(cp.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.status).toBe("discarded");
    });
  });

  describe("pruneExpired()", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("marks old checkpoints as expired", () => {
      const expiryMs = 60 * 60 * 1000; // 1 hour
      const expiringStore = new CheckpointStore({ expiryMs });

      vi.setSystemTime(new Date("2026-03-22T10:00:00Z"));
      expiringStore.save({
        userId: 1,
        sessionId: "s1",
        prompt: "Old task",
        partialResponse: "",
        toolsUsed: [],
      });

      // Advance past expiry
      vi.setSystemTime(new Date("2026-03-22T11:01:00Z"));
      const pruned = expiringStore.pruneExpired();
      expect(pruned).toBe(1);

      const latest = expiringStore.getLatest(1);
      expect(latest).toBeNull();
    });

    it("leaves fresh checkpoints alone", () => {
      const expiryMs = 60 * 60 * 1000; // 1 hour
      const expiringStore = new CheckpointStore({ expiryMs });

      vi.setSystemTime(new Date("2026-03-22T10:00:00Z"));
      expiringStore.save({
        userId: 1,
        sessionId: "s1",
        prompt: "Fresh task",
        partialResponse: "",
        toolsUsed: [],
      });

      // Only 30 minutes later
      vi.setSystemTime(new Date("2026-03-22T10:30:00Z"));
      const pruned = expiringStore.pruneExpired();
      expect(pruned).toBe(0);

      const latest = expiringStore.getLatest(1);
      expect(latest).not.toBeNull();
      expect(latest!.prompt).toBe("Fresh task");
    });
  });

  describe("per-user limit", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("evicts oldest when exceeded", () => {
      const limitedStore = new CheckpointStore({ maxCheckpointsPerUser: 2 });

      vi.setSystemTime(new Date("2026-03-22T10:00:00Z"));
      const first = limitedStore.save({
        userId: 1,
        sessionId: "s1",
        prompt: "First",
        partialResponse: "",
        toolsUsed: [],
      });

      vi.setSystemTime(new Date("2026-03-22T10:01:00Z"));
      limitedStore.save({
        userId: 1,
        sessionId: "s2",
        prompt: "Second",
        partialResponse: "",
        toolsUsed: [],
      });

      vi.setSystemTime(new Date("2026-03-22T10:02:00Z"));
      limitedStore.save({
        userId: 1,
        sessionId: "s3",
        prompt: "Third",
        partialResponse: "",
        toolsUsed: [],
      });

      const all = limitedStore.listForUser(1);
      expect(all).toHaveLength(2);
      expect(all.map((c) => c.prompt)).toEqual(["Second", "Third"]);

      // First should be gone
      expect(limitedStore.get(first.id)).toBeNull();
    });
  });

  describe("getStats()", () => {
    it("returns correct counts", () => {
      store.save({ userId: 1, sessionId: "s1", prompt: "A", partialResponse: "", toolsUsed: [] });
      const cp2 = store.save({ userId: 1, sessionId: "s2", prompt: "B", partialResponse: "", toolsUsed: [] });
      const cp3 = store.save({ userId: 2, sessionId: "s3", prompt: "C", partialResponse: "", toolsUsed: [] });

      store.markResumed(cp2.id);
      store.discard(cp3.id);

      const stats = store.getStats();
      expect(stats).toEqual({
        total: 3,
        paused: 1,
        resumed: 1,
        expired: 0,
      });
    });
  });
});

describe("buildResumePrompt()", () => {
  const baseCheckpoint: Checkpoint = {
    id: "cp-1",
    userId: 1,
    sessionId: "sess-1",
    prompt: "Fix the login bug in auth.ts",
    partialResponse: "I identified the issue in the token validation logic.",
    toolsUsed: ["Read", "Edit", "Bash"],
    createdAt: "2026-03-22T10:00:00.000Z",
    status: "paused",
  };

  it("constructs continuation prompt", () => {
    const result = buildResumePrompt(baseCheckpoint);

    expect(result).toContain("[Resuming interrupted session]");
    expect(result).toContain("Fix the login bug in auth.ts");
    expect(result).toContain("I identified the issue in the token validation logic.");
    expect(result).toContain("Continue from where you left off.");
  });

  it("includes new instruction when provided", () => {
    const result = buildResumePrompt(baseCheckpoint, "Actually, skip auth.ts and fix user.ts instead");

    expect(result).toContain("[Resuming interrupted session]");
    expect(result).toContain("Fix the login bug in auth.ts");
    expect(result).toContain("New instruction:");
    expect(result).toContain("Actually, skip auth.ts and fix user.ts instead");
    expect(result).not.toContain("Continue from where you left off.");
  });

  it("includes tools used", () => {
    const result = buildResumePrompt(baseCheckpoint);

    expect(result).toContain("Tools used so far: Read, Edit, Bash");
  });
});
