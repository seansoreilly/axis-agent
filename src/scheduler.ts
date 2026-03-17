import { execFile } from "node:child_process";
import cron from "node-cron";
import { CronExpressionParser } from "cron-parser";
import type { Agent } from "./agent.js";
import { info, error as logError } from "./logger.js";
import { SqliteStore } from "./persistence.js";
import type { JobService } from "./jobs.js";

/** Max time for a monitor check command to run (10 seconds). */
const CHECK_COMMAND_TIMEOUT_MS = 10_000;

/**
 * Shell metacharacters that indicate potential injection.
 * Check commands should be simple commands, not pipelines or subshells.
 */
const SHELL_METACHAR_PATTERN = /[;&|`$(){}!<>\n\\]/;

/**
 * Validate a check command for safety. Rejects commands containing
 * shell metacharacters that could enable injection.
 */
export function validateCheckCommand(command: string): { valid: boolean; reason?: string } {
  if (!command.trim()) {
    return { valid: false, reason: "Check command cannot be empty" };
  }
  if (SHELL_METACHAR_PATTERN.test(command)) {
    return {
      valid: false,
      reason: `Check command contains shell metacharacters. Use simple commands only (no pipes, semicolons, backticks, subshells, redirects).`,
    };
  }
  return { valid: true };
}

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
   */
  checkCommand?: string;
}

type TaskCallback = (taskId: string, result: string) => void;

/**
 * Run a check command and return its stdout (trimmed).
 * Returns empty string if the command fails or times out.
 *
 * Uses execFile to avoid shell interpretation — the command string is split
 * into argv tokens (respecting single/double quotes) and executed directly.
 */
export function runCheckCommand(command: string): Promise<string> {
  const args = splitCommandArgs(command);
  if (args.length === 0) return Promise.resolve("");
  const [bin, ...rest] = args;
  return new Promise((resolve) => {
    execFile(bin, rest, { timeout: CHECK_COMMAND_TIMEOUT_MS }, (error, stdout) => {
      if (error) {
        // Command failed or timed out — treat as "nothing to report"
        resolve("");
        return;
      }
      resolve((stdout ?? "").trim());
    });
  });
}

/**
 * Split a command string into argv tokens, respecting single and double quotes.
 * Does NOT interpret shell metacharacters — just tokenizes.
 */
export function splitCommandArgs(command: string): string[] {
  const args: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (ch === " " && !inSingle && !inDouble) {
      if (current) {
        args.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current) args.push(current);
  return args;
}

export class Scheduler {
  private agent: Agent;
  private tasks: Map<string, cron.ScheduledTask> = new Map();
  private taskDefs: Map<string, ScheduledTask> = new Map();
  private onResult?: TaskCallback;
  private store: SqliteStore;
  private running = false;
  private jobs: JobService;

  constructor(agent: Agent, onResult?: TaskCallback, persistDir?: string, jobs?: JobService) {
    this.agent = agent;
    this.onResult = onResult;
    this.store = new SqliteStore(persistDir ?? "/home/ubuntu/.claude-agent/memory");
    if (!jobs) {
      throw new Error("JobService is required for Scheduler");
    }
    this.jobs = jobs;
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    try {
      const saved = this.store.listTasks();
      for (const task of saved) {
        this.add(task);
      }
      info("scheduler", `Loaded ${saved.length} task(s) from disk`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError("scheduler", `Failed to load tasks from disk: ${msg}`);
    }
  }

  private saveToDisk(): void {
    try {
      for (const task of this.taskDefs.values()) {
        this.store.upsertTask(task);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError("scheduler", `Failed to save tasks to disk: ${msg}`);
    }
  }

  add(task: ScheduledTask): void {
    if (!cron.validate(task.schedule)) {
      throw new Error(`Invalid cron expression: ${task.schedule}`);
    }

    // Validate check command for shell injection safety
    if (task.checkCommand) {
      const check = validateCheckCommand(task.checkCommand);
      if (!check.valid) {
        throw new Error(`Invalid check command: ${check.reason}`);
      }
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

            // All execution goes through JobService (handles retries, timeouts, persistence)
            const job = this.jobs.enqueuePromptJob({
              prompt,
              source: "scheduler",
              metadata: { taskId: task.id, taskName: task.name },
            });
            const completed = await this.jobs.waitForCompletion(job.id);
            const text = completed.resultText ?? completed.errorText ?? "Task completed.";
            info("scheduler", `Task ${task.id} completed via job ${job.id}`);
            this.onResult?.(task.id, text);
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
      this.store.deleteTask(id);
      this.saveToDisk();
    }
    return removed;
  }

  list(): ScheduledTask[] {
    return [...this.taskDefs.values()];
  }

  /**
   * Trigger a scheduled task immediately (on demand), bypassing its cron schedule.
   * Returns the job ID if enqueued, or throws if the task doesn't exist or is disabled.
   */
  runNow(id: string): string {
    const task = this.taskDefs.get(id);
    if (!task) {
      throw new Error(`Task not found: ${id}`);
    }
    if (!task.enabled) {
      throw new Error(`Task is disabled: ${id}`);
    }

    info("scheduler", `Manual trigger for task: ${task.name} (${task.id})`);
    const job = this.jobs.enqueuePromptJob({
      prompt: task.prompt,
      source: "scheduler",
      metadata: { taskId: task.id, taskName: task.name, manual: true },
    });

    // Wait for completion and deliver result (fire-and-forget)
    void this.jobs.waitForCompletion(job.id, 10 * 60 * 1000).then((completed) => {
      const text = completed.resultText ?? completed.errorText ?? "Task completed.";
      info("scheduler", `Manual task ${task.id} completed via job ${job.id}`);
      this.onResult?.(task.id, text);
    }).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      logError("scheduler", `Manual task ${task.id} failed: ${msg}`);
      this.onResult?.(task.id, `Task failed: ${msg}`);
    });

    return job.id;
  }

  stopAll(): void {
    for (const task of this.tasks.values()) {
      task.stop();
    }
    this.tasks.clear();
  }
}
