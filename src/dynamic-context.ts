import type { SqliteStore } from "./persistence.js";
import { buildPolicyPromptSection } from "./policies.js";

export class DynamicContextBuilder {
  constructor(private readonly store: SqliteStore) {}

  buildDynamicContext(): string {
    const parts: string[] = [];

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

    return parts.join("\n\n");
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
      '  curl -s -X POST http://localhost:8080/tasks/<id>/run -H "Content-Type: application/json"',
      "",
      ...lines,
    ].join("\n");
  }
}
