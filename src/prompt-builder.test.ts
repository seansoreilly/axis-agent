import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("Agent prompt construction", () => {
  it("injects memory context and session summaries into system prompt inputs", async () => {
    const { Agent } = await import("./agent.js");

    const store = {
      getContext: (opts?: { categories?: string[]; maxFacts?: number }) => {
        if (opts?.categories?.includes("personal")) {
          return "- timezone: Australia/Sydney";
        }
        return "- project: axis-agent";
      },
      getLastSessionSummary: () => " - discussed refactor",
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const agent = new Agent({
      telegram: { botToken: "token", allowedUsers: [1] },
      server: { port: 8080 },
      claude: {
        model: "claude-haiku-4-5-20251001",
        maxTurns: 25,
        maxBudgetUsd: 5,
        workDir: process.cwd(),
        agentTimeoutMs: 600000,
      },
      memoryDir: process.cwd(),
    }, store as any, "/definitely/missing/SOUL.md");

    const prompt = (agent as unknown as { buildMemoryContext: (userId?: number) => string }).buildMemoryContext(1);

    expect(prompt).toContain("Currently Remembered Facts");
    expect(prompt).toContain("timezone");
    expect(prompt).toContain("project");
    expect(prompt).toContain("Previous Conversation Summary");
  });

  it("includes scheduled tasks in system prompt", async () => {
    const { PromptBuilder } = await import("./prompt-builder.js");
    const { SqliteStore } = await import("./persistence.js");

    const tmpDir = join(tmpdir(), `pb-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });

    try {
      const store = new SqliteStore(tmpDir);
      store.upsertTask({
        id: "email-triage",
        name: "Email Triage",
        schedule: "0 8-22 * * *",
        prompt: "Run email triage",
        enabled: true,
      });

      const builder = new PromptBuilder(
        {
          telegram: { botToken: "t", allowedUsers: [1] },
          server: { port: 8080 },
          claude: {
            model: "claude-haiku-4-5-20251001",
            maxTurns: 25,
            maxBudgetUsd: 5,
            workDir: process.cwd(),
            agentTimeoutMs: 600000,
          },
          memoryDir: tmpDir,
        },
        store
      );

      const systemPrompt = builder.buildSystemPrompt({});
      expect(systemPrompt).toContain("Scheduled Tasks");
      expect(systemPrompt).toContain("email-triage");
      expect(systemPrompt).toContain("Email Triage");
      expect(systemPrompt).toContain("/tasks/<id>/run");
    } finally {
      if (existsSync(tmpDir)) {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    }
  });
});
