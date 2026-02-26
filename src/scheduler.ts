import cron from "node-cron";
import type { Agent } from "./agent.js";
import { info, error as logError } from "./logger.js";

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

    // Remove existing task with same ID
    this.remove(task.id);

    this.taskDefs.set(task.id, task);

    if (task.enabled) {
      const scheduled = cron.schedule(task.schedule, async () => {
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
      });
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
