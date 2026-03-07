import { describe, expect, it } from "vitest";

describe("Agent prompt construction", () => {
  it("injects memory context and session summaries into system prompt inputs", async () => {
    const { Agent } = await import("./agent.js");

    const memory = {
      getContext: (opts?: { categories?: string[] }) => {
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
      },
      memoryDir: process.cwd(),
    }, memory as any, "/definitely/missing/SOUL.md");

    const prompt = (agent as unknown as { buildMemoryContext: (userId?: number) => string }).buildMemoryContext(1);

    expect(prompt).toContain("Currently Remembered Facts");
    expect(prompt).toContain("timezone");
    expect(prompt).toContain("project");
    expect(prompt).toContain("Previous Conversation Summary");
  });
});
