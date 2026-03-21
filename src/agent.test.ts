import { describe, it, expect, vi } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock child_process to avoid spawning real claude CLI
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

// Mock auth to avoid hitting real OAuth
vi.mock("./auth.js", () => ({
  ensureValidToken: vi.fn().mockResolvedValue(true),
}));

describe("Agent", () => {
  it("constructs with SqliteStore", async () => {
    const { Agent } = await import("./agent.js");
    const { SqliteStore } = await import("./persistence.js");

    const tmpDir = join(tmpdir(), `agent-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });

    try {
      const store = new SqliteStore(tmpDir);
      const agent = new Agent(
        {
          telegram: { botToken: "test", allowedUsers: [1] },
          server: { port: 8080 },
          claude: { model: "claude-sonnet-4-6", maxTurns: 5, maxBudgetUsd: 1, workDir: tmpDir, agentTimeoutMs: 600000 },
          memoryDir: tmpDir,
        },
        store
      );
      expect(agent).toBeDefined();
    } finally {
      if (existsSync(tmpDir)) {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    }
  });
});
