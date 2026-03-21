import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("Policies", () => {
  it("buildPolicyPromptSection includes blocked commands and sensitive files", async () => {
    const { buildPolicyPromptSection } = await import("./policies.js");
    const section = buildPolicyPromptSection();
    expect(section).toContain("rm -rf");
    expect(section).toContain("shutdown");
    expect(section).toContain(".env");
    expect(section).toContain("REFUSE");
  });
});

describe("DynamicContextBuilder", () => {
  it("includes scheduled tasks in dynamic context", async () => {
    const { DynamicContextBuilder } = await import("./dynamic-context.js");
    const { SqliteStore } = await import("./persistence.js");

    const tmpDir = join(tmpdir(), `dc-test-${Date.now()}`);
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

      const builder = new DynamicContextBuilder(store);
      const context = builder.buildDynamicContext();

      expect(context).toContain("Scheduled Tasks");
      expect(context).toContain("email-triage");
      expect(context).toContain("Email Triage");
      expect(context).toContain("/tasks/<id>/run");
    } finally {
      if (existsSync(tmpDir)) {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    }
  });

  it("includes current date and time in dynamic context", async () => {
    const { DynamicContextBuilder } = await import("./dynamic-context.js");
    const { SqliteStore } = await import("./persistence.js");

    const tmpDir = join(tmpdir(), `dc-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });

    try {
      const store = new SqliteStore(tmpDir);
      const builder = new DynamicContextBuilder(store);
      const context = builder.buildDynamicContext();

      expect(context).toContain("Current Date & Time");
      expect(context).toContain("Australia/Melbourne");
    } finally {
      if (existsSync(tmpDir)) {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    }
  });
});
