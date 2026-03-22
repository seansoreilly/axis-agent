import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ReflectionResult } from "./reflection.js";

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

  it("includes LEARNINGS.md content when workDir is provided", async () => {
    const { DynamicContextBuilder } = await import("./dynamic-context.js");
    const { SqliteStore } = await import("./persistence.js");

    const tmpDir = join(tmpdir(), `dc-learnings-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });

    const learningsContent = `# Learnings

Important discoveries.

---

### 2026-03-01 - test - lesson
- **Lesson**: Always verify assumptions before acting.
`;
    writeFileSync(join(tmpDir, "LEARNINGS.md"), learningsContent);

    try {
      const store = new SqliteStore(tmpDir);
      const builder = new DynamicContextBuilder(store, undefined, tmpDir);
      const context = await builder.buildDynamicContext();

      expect(context).toContain("Past Learnings");
      expect(context).toContain("Always verify assumptions before acting");
    } finally {
      if (existsSync(tmpDir)) {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    }
  });

  it("gracefully handles missing LEARNINGS.md", async () => {
    const { DynamicContextBuilder } = await import("./dynamic-context.js");
    const { SqliteStore } = await import("./persistence.js");

    const tmpDir = join(tmpdir(), `dc-no-learnings-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });

    try {
      const store = new SqliteStore(tmpDir);
      const builder = new DynamicContextBuilder(store, undefined, tmpDir);
      const context = await builder.buildDynamicContext();

      expect(context).not.toContain("Past Learnings");
      expect(context).toContain("Current Date & Time");
    } finally {
      if (existsSync(tmpDir)) {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    }
  });

  it("includes recent reflections when reflectionStorePath is provided", async () => {
    const { DynamicContextBuilder } = await import("./dynamic-context.js");
    const { SqliteStore } = await import("./persistence.js");

    const tmpDir = join(tmpdir(), `dc-reflections-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });

    const reflectionStorePath = join(tmpDir, "reflections.jsonl");
    const entry: ReflectionResult = {
      shouldReflect: true,
      assessment: "needs_improvement",
      insights: ["Used too many search iterations"],
      timestamp: "2026-03-22T10:00:00.000Z",
    };
    writeFileSync(reflectionStorePath, JSON.stringify(entry) + "\n");

    try {
      const store = new SqliteStore(tmpDir);
      const builder = new DynamicContextBuilder(store, undefined, undefined, reflectionStorePath);
      const context = await builder.buildDynamicContext();

      expect(context).toContain("Recent Task Reflections");
      expect(context).toContain("needs_improvement");
      expect(context).toContain("Used too many search iterations");
    } finally {
      if (existsSync(tmpDir)) {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    }
  });

  it("gracefully handles missing reflections file", async () => {
    const { DynamicContextBuilder } = await import("./dynamic-context.js");
    const { SqliteStore } = await import("./persistence.js");

    const tmpDir = join(tmpdir(), `dc-no-reflections-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });

    try {
      const store = new SqliteStore(tmpDir);
      const builder = new DynamicContextBuilder(store, undefined, undefined, join(tmpDir, "reflections.jsonl"));
      const context = await builder.buildDynamicContext();

      expect(context).not.toContain("Recent Task Reflections");
      expect(context).toContain("Current Date & Time");
    } finally {
      if (existsSync(tmpDir)) {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    }
  });
});
