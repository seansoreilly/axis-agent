import cron from "node-cron";
import { CronExpressionParser } from "cron-parser";
import type { Agent } from "./agent.js";
import { info, error as logError } from "./logger.js";

const MAX_TASKS = 20;
const MIN_INTERVAL_SECONDS = 300; // 5 minutes

export interface ScheduledTask {
  id: string;
  name: string;
  schedule: string; // cron expression
  prompt: string;
  enabled: boolean;
}

type TaskCallback = (taskId: string, result: string) => void;

export class Scheduler {
  private agent: Agent;
  private tasks: Map<string, cron.ScheduledTask> = new Map();
  private taskDefs: Map<string, ScheduledTask> = new Map();
  private onResult?: TaskCallback;

  constructor(agent: Agent, onResult?: TaskCallback) {
    this.agent = agent;
    this.onResult = onResult;
  }

  add(task: ScheduledTask): void {
    if (!cron.validate(task.schedule)) {
      throw new Error(`Invalid cron expression: ${task.schedule}`);
    }

    // Enforce minimum interval
    try {
      const interval = CronExpressionParser.parse(task.schedule);
      const first = interval.next().toDate();
      const second = interval.next().toDate();
      const gapSeconds = (second.getTime() - first.getTime()) / 1000;
      if (gapSeconds < MIN_INTERVAL_SECONDS) {
        throw new Error(
          `Schedule interval too frequent (${gapSeconds}s). Minimum is ${MIN_INTERVAL_SECONDS}s.`
        );
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes("too frequent")) {
        throw err;
      }
      // If cron-parser fails but node-cron validated, allow it
    }

    // Enforce max task count (don't count if replacing existing)
    if (!this.taskDefs.has(task.id) && this.taskDefs.size >= MAX_TASKS) {
      throw new Error(`Maximum number of scheduled tasks (${MAX_TASKS}) reached.`);
    }

    // Remove existing task with same ID
    this.remove(task.id);

    this.taskDefs.set(task.id, task);

    if (task.enabled) {
      const scheduled = cron.schedule(
        task.schedule,
        async () => {
          info("scheduler", `Running task: ${task.name} (${task.id})`);
          try {
            const result = await this.agent.run(task.prompt);
            info(
              "scheduler",
              `Task ${task.id} completed in ${result.durationMs}ms`
            );
            this.onResult?.(task.id, result.text);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logError("scheduler", `Task ${task.id} failed: ${msg}`);
            this.onResult?.(task.id, `Task failed: ${msg}`);
          }
        },
        { timezone: "Australia/Melbourne" }
      );
      this.tasks.set(task.id, scheduled);
    }
  }

  remove(id: string): boolean {
    const existing = this.tasks.get(id);
    if (existing) {
      existing.stop();
      this.tasks.delete(id);
    }
    return this.taskDefs.delete(id);
  }

  list(): ScheduledTask[] {
    return [...this.taskDefs.values()];
  }

  stopAll(): void {
    for (const task of this.tasks.values()) {
      task.stop();
    }
    this.tasks.clear();
  }
}
