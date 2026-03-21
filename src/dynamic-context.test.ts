import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
      const context = await builder.buildDynamicContext();

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
      const context = await builder.buildDynamicContext();

      expect(context).toContain("Current Date & Time");
      expect(context).toContain("Australia/Melbourne");
    } finally {
      if (existsSync(tmpDir)) {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    }
  });

  it("includes identity context when IdentityManager is provided", async () => {
    const { DynamicContextBuilder } = await import("./dynamic-context.js");
    const { SqliteStore } = await import("./persistence.js");
    const { IdentityManager } = await import("./identity.js");

    const tmpDir = join(tmpdir(), `dc-identity-test-${Date.now()}`);
    const workDir = join(tmpDir, "work");
    mkdirSync(workDir, { recursive: true });

    writeFileSync(join(workDir, "USER.md"), "Preferred name: Alex\nRole: Engineer");
    writeFileSync(join(workDir, "TOOLS.md"), "Available: Trello, Gmail");

    try {
      const store = new SqliteStore(tmpDir);
      const identity = new IdentityManager(workDir);
      const builder = new DynamicContextBuilder(store, identity);
      const context = await builder.buildDynamicContext();

      expect(context).toContain("Preferred name: Alex");
      expect(context).toContain("Available: Trello, Gmail");
      expect(context).toContain("Current Date & Time");
    } finally {
      if (existsSync(tmpDir)) {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    }
  });
});
