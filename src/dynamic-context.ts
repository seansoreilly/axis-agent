import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SqliteStore } from "./persistence.js";
import type { IdentityManager } from "./identity.js";
import { buildPolicyPromptSection } from "./policies.js";

const LEARNINGS_MAX_CHARS = 2000;
const REFLECTION_RECENT_COUNT = 5;

interface StoredReflection {
  assessment: string;
  insights: string[];
  timestamp: string;
}

export class DynamicContextBuilder {
  constructor(
    private readonly store: SqliteStore,
    private readonly identity?: IdentityManager,
    private readonly workDir?: string,
    private readonly reflectionStorePath?: string,
  ) {}

  async buildDynamicContext(): Promise<string> {
    const parts: string[] = [];

    // Identity context (USER.md, TOOLS.md — SOUL.md is auto-discovered by CLI)
    if (this.identity) {
      const ctx = await this.identity.load();
      if (ctx.composed) {
        parts.push(ctx.composed);
      }
    }

    // Current datetime
    const now = new Date().toLocaleString("en-AU", {
      timeZone: "Australia/Melbourne",
      dateStyle: "full",
      timeStyle: "short",
    });
    parts.push(`## Current Date & Time\n${now} (Australia/Melbourne)`);

    // Scheduled tasks
    const tasksContext = this.buildScheduledTasksContext();
    if (tasksContext) parts.push(tasksContext);

    // Security policies (soft enforcement)
    parts.push(buildPolicyPromptSection());

    // Past learnings (non-obvious debugging insights and patterns)
    const learningsContext = await this.buildLearningsContext();
    if (learningsContext) parts.push(learningsContext);

    // Recent task reflections (structured post-task analysis)
    const reflectionContext = await this.buildReflectionContext();
    if (reflectionContext) parts.push(reflectionContext);

    return parts.join("\n\n");
  }

  private async buildLearningsContext(): Promise<string> {
    if (!this.workDir) return "";
    try {
      let content = await readFile(join(this.workDir, "LEARNINGS.md"), "utf-8");
      // Strip the header (first line "# Learnings" and following blank/meta lines)
      content = content.replace(/^#[^\n]*\n[\s\S]*?---\n/, "").trim();
      if (!content) return "";
      if (content.length > LEARNINGS_MAX_CHARS) {
        content = content.slice(0, LEARNINGS_MAX_CHARS) + "\n...(truncated)";
      }
      return `## Past Learnings\n${content}`;
    } catch {
      return "";
    }
  }

  private async buildReflectionContext(): Promise<string> {
    if (!this.reflectionStorePath) return "";
    try {
      const raw = await readFile(this.reflectionStorePath, "utf-8");
      const lines = raw.trim().split("\n").filter(Boolean);
      const recent = lines.slice(-REFLECTION_RECENT_COUNT);
      if (recent.length === 0) return "";
      const summaries = recent.map((line) => {
        const entry = JSON.parse(line) as StoredReflection;
        const date = entry.timestamp ? entry.timestamp.slice(0, 10) : "";
        const firstInsight = entry.insights?.[0] ?? "";
        const insightPart = firstInsight ? `: ${firstInsight}` : "";
        return `- [${entry.assessment}]${insightPart} (${date})`;
      });
      return `## Recent Task Reflections\n${summaries.join("\n")}`;
    } catch {
      return "";
    }
  }

  private buildScheduledTasksContext(): string {
    const tasks = this.store.listTasks();
    if (tasks.length === 0) return "";

    const lines = tasks.map(
      (t) =>
        `- **${t.name}** (id: \`${t.id}\`, schedule: \`${t.schedule}\`, ${t.enabled ? "enabled" : "disabled"})`
    );
    return [
      "## Scheduled Tasks",
      "These tasks run automatically on their cron schedules. To trigger one manually:",
      '  curl -s -X POST http://localhost:8080/tasks/<id>/run -H "Content-Type: application/json" -H "Authorization: Bearer $GATEWAY_API_TOKEN"',
      "",
      ...lines,
    ].join("\n");
  }
}
