import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("Memory", () => {
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
    const { Memory } = await import("./memory.js");
    const memory = new Memory(tmpDir);

    memory.setFact("user-timezone", "Australia/Sydney");

    expect(memory.getFact("user-timezone")).toBe("Australia/Sydney");
    expect(memory.getAllFacts()["user-timezone"]?.category).toBe("personal");
  });

  it("builds context sorted by recency and category", async () => {
    const { Memory } = await import("./memory.js");
    const memory = new Memory(tmpDir);

    memory.setFact("favorite-tool", "claude code");
    memory.setFact("project-stack", "agent");
    memory.setFact("server-region", "ap-southeast-2");

    const personalPref = memory.getContext({ categories: ["preference"] });
    const other = memory.getContext({ categories: ["work", "system"] });

    expect(personalPref).toContain("favorite-tool");
    expect(other).toContain("project-stack");
    expect(other).toContain("server-region");
  });

  it("records sessions and returns the latest non-stale session", async () => {
    const { Memory } = await import("./memory.js");
    const memory = new Memory(tmpDir);

    memory.recordSession("sess-1", 1, "first");
    memory.recordSession("sess-2", 1, "second");

    expect(memory.getLastSession(1)?.sessionId).toBe("sess-2");
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

    const { Memory } = await import("./memory.js");
    const memory = new Memory(tmpDir);

    expect(memory.getFact("name")).toBe("Sean");
    expect(memory.getAllFacts()["name"]?.category).toBe("personal");
    expect(memory.getLastSession(1)?.sessionId).toBeUndefined();
  });
});
