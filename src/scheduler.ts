import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { exec } from "node:child_process";
import { dirname, join } from "node:path";
import cron from "node-cron";
import { CronExpressionParser } from "cron-parser";
import type { Agent } from "./agent.js";
import { info, error as logError } from "./logger.js";

/** Max time for a monitor check command to run (10 seconds). */
const CHECK_COMMAND_TIMEOUT_MS = 10_000;

const MAX_TASKS = 20;
const MIN_INTERVAL_SECONDS = 300; // 5 minutes

export interface ScheduledTask {
  id: string;
  name: string;
  schedule: string; // cron expression
  prompt: string;
  enabled: boolean;
  /**
   * Optional check command for monitor-style tasks.
   * When set, this shell command runs first. If it produces non-empty stdout,
   * that output is prepended to the prompt and the full agent runs.
   * If stdout is empty or the command fails, the task is skipped silently.
   * This enables "check and only act if needed" patterns (e.g., new emails, RSS updates).
   */
  checkCommand?: string;
}

type TaskCallback = (taskId: string, result: string) => void;

/**
 * Run a check command and return its stdout (trimmed).
 * Returns empty string if the command fails or times out.
 */
export function runCheckCommand(command: string): Promise<string> {
  return new Promise((resolve) => {
    exec(command, { timeout: CHECK_COMMAND_TIMEOUT_MS }, (error, stdout) => {
      if (error) {
        // Command failed or timed out — treat as "nothing to report"
        resolve("");
        return;
      }
      resolve((stdout ?? "").trim());
    });
  });
}

export class Scheduler {
  private agent: Agent;
  private tasks: Map<string, cron.ScheduledTask> = new Map();
  private taskDefs: Map<string, ScheduledTask> = new Map();
  private onResult?: TaskCallback;
  private persistPath: string;
  private running = false;

  constructor(agent: Agent, onResult?: TaskCallback, persistDir?: string) {
    this.agent = agent;
    this.onResult = onResult;
    const dir = persistDir ?? "/home/ubuntu/.claude-agent/memory";
    this.persistPath = join(dir, "tasks.json");
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    try {
      if (existsSync(this.persistPath)) {
        const raw = readFileSync(this.persistPath, "utf-8");
        const saved: ScheduledTask[] = JSON.parse(raw);
        for (const task of saved) {
          this.add(task);
        }
        info("scheduler", `Loaded ${saved.length} task(s) from disk`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError("scheduler", `Failed to load tasks from disk: ${msg}`);
    }
  }

  private saveToDisk(): void {
    try {
      const dir = dirname(this.persistPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      const tasks = [...this.taskDefs.values()];
      writeFileSync(this.persistPath, JSON.stringify(tasks, null, 2));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError("scheduler", `Failed to save tasks to disk: ${msg}`);
    }
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
          if (this.running) {
            info("scheduler", `Skipping task ${task.id} — another task is running`);
            return;
          }
          this.running = true;
          try {
            // Monitor mode: run check command first, skip if no output
            let prompt = task.prompt;
            if (task.checkCommand) {
              info("scheduler", `Running check for monitor task: ${task.name} (${task.id})`);
              const checkOutput = await runCheckCommand(task.checkCommand);
              if (!checkOutput) {
                info("scheduler", `Monitor task ${task.id} — check returned nothing, skipping`);
                return;
              }
              info("scheduler", `Monitor task ${task.id} — check found data, running agent`);
              prompt = `## Monitor Check Output\nThe following was returned by the check command (\`${task.checkCommand}\`):\n\n${checkOutput}\n\n## Task Instructions\n${task.prompt}`;
            } else {
              info("scheduler", `Running task: ${task.name} (${task.id})`);
            }

            const result = await this.agent.run(prompt);
            info(
              "scheduler",
              `Task ${task.id} completed in ${result.durationMs}ms`
            );
            this.onResult?.(task.id, result.text);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logError("scheduler", `Task ${task.id} failed: ${msg}`);
            this.onResult?.(task.id, `Task failed: ${msg}`);
          } finally {
            this.running = false;
          }
        },
        { timezone: "Australia/Melbourne" }
      );
      this.tasks.set(task.id, scheduled);
    }

    this.saveToDisk();
  }

  remove(id: string): boolean {
    const existing = this.tasks.get(id);
    if (existing) {
      existing.stop();
      this.tasks.delete(id);
    }
    const removed = this.taskDefs.delete(id);
    if (removed) {
      this.saveToDisk();
    }
    return removed;
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
