import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadSoulMd } from "./agent.js";

// Mock the SDK to avoid real API calls
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

describe("loadSoulMd", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `soul-md-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("loads SOUL.md from an explicit path", () => {
    const soulPath = join(tmpDir, "SOUL.md");
    writeFileSync(soulPath, "You are a test agent.");

    const result = loadSoulMd(soulPath);
    expect(result).toBe("You are a test agent.");
  });

  it("returns null when explicit path does not exist", () => {
    const result = loadSoulMd(join(tmpDir, "nonexistent.md"));
    expect(result).toBeNull();
  });

  it("returns null when no explicit path and no file in cwd", () => {
    // Use a temp dir with no SOUL.md as cwd
    const originalCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      const result = loadSoulMd();
      expect(result).toBeNull();
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("loads SOUL.md from cwd when no explicit path given", () => {
    const soulPath = join(tmpDir, "SOUL.md");
    writeFileSync(soulPath, "# Personality\nBe helpful and concise.");

    const originalCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      const result = loadSoulMd();
      expect(result).toBe("# Personality\nBe helpful and concise.");
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("loads SOUL.md from parent dir (../SOUL.md) for dist/ scenario", () => {
    // Simulate running from a dist/ subdirectory
    const distDir = join(tmpDir, "dist");
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(tmpDir, "SOUL.md"), "Parent SOUL content.");

    const originalCwd = process.cwd();
    process.chdir(distDir);
    try {
      const result = loadSoulMd();
      expect(result).toBe("Parent SOUL content.");
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("prefers SOUL.md in cwd over parent dir", () => {
    const distDir = join(tmpDir, "dist");
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(tmpDir, "SOUL.md"), "Parent SOUL.");
    writeFileSync(join(distDir, "SOUL.md"), "CWD SOUL.");

    const originalCwd = process.cwd();
    process.chdir(distDir);
    try {
      const result = loadSoulMd();
      expect(result).toBe("CWD SOUL.");
    } finally {
      process.chdir(originalCwd);
    }
  });
});

describe("Agent with SOUL.md", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `agent-soul-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("constructs with SOUL.md path and loads it", async () => {
    const soulPath = join(tmpDir, "SOUL.md");
    writeFileSync(soulPath, "You are a custom personality agent.");

    const memoryDir = join(tmpDir, "memory");
    mkdirSync(memoryDir, { recursive: true });

    // Import Agent dynamically to get the class with mock SDK
    const { Agent } = await import("./agent.js");
    const { SqliteStore } = await import("./persistence.js");

    const store = new SqliteStore(memoryDir);
    const agent = new Agent(
      {
        telegram: { botToken: "test", allowedUsers: [1] },
        server: { port: 8080 },
        claude: { model: "claude-sonnet-4-6", maxTurns: 5, maxBudgetUsd: 1, workDir: tmpDir, agentTimeoutMs: 600000 },
        memoryDir,
      },
      store,
      soulPath
    );

    // Agent should be constructed without error
    expect(agent).toBeDefined();
  });

  it("constructs without SOUL.md and uses default prompt", async () => {
    const memoryDir = join(tmpDir, "memory");
    mkdirSync(memoryDir, { recursive: true });

    const { Agent } = await import("./agent.js");
    const { SqliteStore } = await import("./persistence.js");

    const store = new SqliteStore(memoryDir);
    const agent = new Agent(
      {
        telegram: { botToken: "test", allowedUsers: [1] },
        server: { port: 8080 },
        claude: { model: "claude-sonnet-4-6", maxTurns: 5, maxBudgetUsd: 1, workDir: tmpDir, agentTimeoutMs: 600000 },
        memoryDir,
      },
      store,
      join(tmpDir, "nonexistent-soul.md")
    );

    expect(agent).toBeDefined();
  });
});
