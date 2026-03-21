import { spawn, type ChildProcess } from "node:child_process";
import { info, error as logError } from "./logger.js";
import { ensureValidToken } from "./auth.js";

export type ProcessState = "starting" | "ready" | "busy" | "dead";

export interface PersistentProcessOpts {
  model: string;
  workDir: string;
  maxBudgetUsd: number;
  systemPrompt?: string;
  sessionId?: string;
  allowedTools?: string[];
  agents?: Record<string, unknown>;
  onActivity?: (event: ActivityEvent) => void;
  selfReview?: boolean;
  selfReviewCooldownMs?: number;
}

export interface SendPromptOpts {
  timeoutMs?: number;
  signal?: AbortSignal;
  maxRunMs?: number;
}

export interface PromptResult {
  text: string;
  sessionId: string;
  durationMs: number;
  totalCostUsd: number;
  isError: boolean;
  isTimeout: boolean;
}

/** Stream-json message types from Claude Code CLI */
/** Activity event emitted during prompt processing */
export interface ActivityEvent {
  tool?: string;
  text?: string;
}

interface StreamMessage {
  type: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  duration_ms?: number;
  total_cost_usd?: number;
  is_error?: boolean;
  message?: {
    role?: string;
    content: Array<{ type: string; text?: string; name?: string } | string>;
  };
  errors?: string[];
}

/**
 * A long-lived claude CLI process that accepts multiple prompts via stdin.
 * Uses `--input-format stream-json` for multi-turn within a single process.
 */
export class PersistentProcess {
  private proc: ChildProcess;
  private _state: ProcessState = "starting";
  private _sessionId = "";
  private _model: string;
  private buffer = "";
  private currentResolve?: (result: PromptResult) => void;
  private currentResultText = "";
  private readyResolve?: () => void;
  private readyReject?: (err: Error) => void;
  private onActivity?: (event: ActivityEvent) => void;
  private selfReview: boolean;
  private selfReviewCooldownMs: number;
  private lastReviewMs = 0;
  private _inReview = false;
  readonly ready: Promise<void>;

  constructor(opts: PersistentProcessOpts) {
    this._model = opts.model;
    this.onActivity = opts.onActivity;
    this.selfReview = opts.selfReview ?? false;
    this.selfReviewCooldownMs = opts.selfReviewCooldownMs ?? 10 * 60 * 1000; // 10 min default

    const args: string[] = [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
      "--model", opts.model,
      "--max-budget-usd", String(opts.maxBudgetUsd),
    ];

    if (opts.systemPrompt) {
      args.push("--append-system-prompt", opts.systemPrompt);
    }

    if (opts.sessionId) {
      args.push("--resume", opts.sessionId);
    }

    if (opts.allowedTools) {
      args.push("--allowed-tools", ...opts.allowedTools);
    }

    if (opts.agents) {
      args.push("--agents", JSON.stringify(opts.agents));
    }

    // No prompt argument — process reads from stdin
    this.proc = spawn("claude", args, {
      cwd: opts.workDir,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    this.ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    this.proc.stdout?.on("data", (chunk: Buffer) => {
      this.handleStdout(chunk.toString());
    });

    this.proc.on("close", (code) => {
      this.handleClose(code);
    });

    this.proc.on("error", (err) => {
      logError("persistent-process", `Process error: ${err.message}`);
      this._state = "dead";
      this.readyReject?.(err);
    });
  }

  get state(): ProcessState {
    return this._state;
  }

  get sessionId(): string {
    return this._sessionId;
  }

  get model(): string {
    return this._model;
  }

  /**
   * Send a prompt to the persistent process.
   * Writes a JSON line to stdin, collects stream-json events until result.
   */
  async sendPrompt(prompt: string, opts?: SendPromptOpts): Promise<PromptResult> {
    if (this._state === "starting") {
      throw new Error("Process not ready yet — still starting");
    }
    if (this._state === "dead") {
      throw new Error("Process is dead");
    }
    if (this._state === "busy") {
      throw new Error("Process is busy — already handling a prompt");
    }

    // If a self-review is in progress, interrupt it first
    if (this._inReview) {
      this.interrupt();
      this._inReview = false;
      await new Promise((r) => setTimeout(r, 50));
    }

    this._state = "busy";
    this.currentResultText = "";

    return new Promise<PromptResult>((resolve) => {
      this.currentResolve = resolve;

      // Set up timeout
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      if (opts?.timeoutMs) {
        timeoutId = setTimeout(() => {
          this.interrupt();
          resolve({
            text: "Request timed out. Try a shorter request or start a /new session.",
            sessionId: this._sessionId,
            durationMs: 0,
            totalCostUsd: 0,
            isError: true,
            isTimeout: true,
          });
          this.currentResolve = undefined;
          this._state = "ready";
        }, opts.timeoutMs);
      }

      // Set up maxRunMs auto-interrupt (orchestrator watchdog)
      let maxRunId: ReturnType<typeof setTimeout> | undefined;
      if (opts?.maxRunMs) {
        maxRunId = setTimeout(() => {
          this.interrupt();
        }, opts.maxRunMs);
      }

      // Set up abort signal
      const onAbort = (): void => {
        this.interrupt();
      };
      if (opts?.signal) {
        if (opts.signal.aborted) {
          this._state = "ready";
          resolve({
            text: "Request cancelled.",
            sessionId: this._sessionId,
            durationMs: 0,
            totalCostUsd: 0,
            isError: true,
            isTimeout: false,
          });
          this.currentResolve = undefined;
          return;
        }
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }

      // Wrap resolve to clean up timeout/signal/maxRun
      const originalResolve = this.currentResolve;
      this.currentResolve = (result: PromptResult) => {
        if (timeoutId) clearTimeout(timeoutId);
        if (maxRunId) clearTimeout(maxRunId);
        opts?.signal?.removeEventListener("abort", onAbort);
        originalResolve?.(result);
      };

      // Write the prompt as a JSON line
      const message = JSON.stringify({
        type: "user",
        message: { role: "user", content: prompt },
      });
      this.proc.stdin?.write(message + "\n");
    });
  }

  /**
   * Send an interrupt control message to cancel the current response
   * without killing the process.
   */
  interrupt(): void {
    const msg = JSON.stringify({
      type: "control_request",
      request: { subtype: "interrupt" },
    });
    this.proc.stdin?.write(msg + "\n");
  }

  /**
   * Gracefully end the session and close stdin.
   */
  shutdown(): void {
    const msg = JSON.stringify({
      type: "control_request",
      request: { subtype: "end_session" },
    });
    this.proc.stdin?.write(msg + "\n");
    this.proc.stdin?.end();
    this._state = "dead";
  }

  /**
   * Force-kill the process.
   */
  kill(): void {
    this.proc.kill("SIGTERM");
    this._state = "dead";
  }

  private canSelfReview(): boolean {
    return Date.now() - this.lastReviewMs >= this.selfReviewCooldownMs;
  }

  private handleStdout(data: string): void {
    this.buffer += data;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg: StreamMessage = JSON.parse(line);
        this.handleMessage(msg);
      } catch {
        // Skip unparseable lines
      }
    }
  }

  private handleMessage(msg: StreamMessage): void {
    // Init event — process is ready
    if (msg.type === "system" && msg.subtype === "init" && msg.session_id) {
      this._sessionId = msg.session_id;
      this._state = "ready";
      this.readyResolve?.();
      return;
    }

    // Assistant content — capture text and emit activity events
    if (msg.type === "assistant" && msg.message?.content) {
      for (const block of msg.message.content) {
        if (typeof block === "object" && "type" in block) {
          if (block.type === "text" && block.text) {
            this.currentResultText = block.text;
            this.onActivity?.({ text: block.text });
          } else if (block.type === "tool_use" && block.name) {
            this.onActivity?.({ tool: block.name });
          }
        }
      }
    }

    // Result event — response complete
    if (msg.type === "result") {
      // Silently consume self-review results
      if (this._inReview) {
        this._inReview = false;
        return;
      }

      const sessionId = msg.session_id ?? this._sessionId;
      if (sessionId) this._sessionId = sessionId;

      let text: string;
      let isError = false;

      if (msg.subtype === "success" && !msg.is_error) {
        text = msg.result ?? this.currentResultText;
      } else {
        isError = true;
        text = msg.result ?? msg.errors?.join(", ") ?? "The agent encountered an error.";
      }

      this._state = "ready";
      this.currentResolve?.({
        text,
        sessionId,
        durationMs: msg.duration_ms ?? 0,
        totalCostUsd: msg.total_cost_usd ?? 0,
        isError,
        isTimeout: false,
      });
      this.currentResolve = undefined;

      // Fire self-review after successful task (fire-and-forget)
      if (this.selfReview && !isError && this.canSelfReview()) {
        this.lastReviewMs = Date.now();
        queueMicrotask(() => {
          if (this._state !== "ready") return;
          this._inReview = true;
          const reviewMsg = JSON.stringify({
            type: "user",
            message: {
              role: "user",
              content: "[self-review] Briefly review the task you just completed. If you identify a concrete improvement to your process, tools, skills, or workspace files (SOUL.md, scripts, skills) — make the change now. If nothing to improve, just say 'No improvements needed.' Keep this under 30 seconds.",
            },
          });
          this.proc.stdin?.write(reviewMsg + "\n");
        });
      }
    }
  }

  private handleClose(code: number | null): void {
    const wasBusy = this._state === "busy";
    const wasStarting = this._state === "starting";
    this._state = "dead";

    if (wasStarting) {
      this.readyReject?.(new Error(`Process exited during startup with code ${code}`));
    }

    if (wasBusy && this.currentResolve) {
      this.currentResolve({
        text: "Process crashed unexpectedly. Please try again.",
        sessionId: this._sessionId,
        durationMs: 0,
        totalCostUsd: 0,
        isError: true,
        isTimeout: false,
      });
      this.currentResolve = undefined;
    }

    info("persistent-process", `Process exited with code ${code}`);
  }
}

export interface ProcessManagerOpts {
  model: string;
  workDir: string;
  maxBudgetUsd: number;
  systemPrompt?: string;
  allowedTools?: string[];
  agents?: Record<string, unknown>;
  idleTimeoutMs?: number;
  selfReview?: boolean;
}

/**
 * Manages persistent claude processes, one per user.
 */
export class ProcessManager {
  private processes = new Map<number, PersistentProcess>();
  private lastActivity = new Map<number, number>();
  private reaperInterval?: ReturnType<typeof setInterval>;
  private readonly opts: ProcessManagerOpts;
  private readonly idleTimeoutMs: number;

  constructor(opts: ProcessManagerOpts) {
    this.opts = opts;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 10 * 60 * 1000; // 10 minutes default
    this.startReaper();
  }

  /**
   * Get an existing ready process for this user, or create a new one.
   * If the model has changed, kills the old process and creates a new one.
   */
  async getOrCreate(
    userId: number,
    model?: string,
    onActivity?: (event: ActivityEvent) => void,
  ): Promise<PersistentProcess> {
    const requestedModel = model ?? this.opts.model;
    const existing = this.processes.get(userId);

    if (existing && existing.state !== "dead" && existing.model === requestedModel) {
      this.lastActivity.set(userId, Date.now());
      return existing;
    }

    // Kill existing if wrong model or dead
    if (existing) {
      if (existing.state !== "dead") {
        existing.kill();
      }
      this.processes.delete(userId);
    }

    await ensureValidToken();

    const proc = new PersistentProcess({
      model: requestedModel,
      workDir: this.opts.workDir,
      maxBudgetUsd: this.opts.maxBudgetUsd,
      systemPrompt: this.opts.systemPrompt,
      allowedTools: this.opts.allowedTools,
      agents: this.opts.agents,
      onActivity,
      selfReview: this.opts.selfReview,
    });

    this.processes.set(userId, proc);
    this.lastActivity.set(userId, Date.now());

    await proc.ready;
    return proc;
  }

  /**
   * Kill and remove the process for a specific user.
   */
  reset(userId: number): void {
    const proc = this.processes.get(userId);
    if (proc && proc.state !== "dead") {
      proc.kill();
    }
    this.processes.delete(userId);
    this.lastActivity.delete(userId);
  }

  /**
   * Kill all processes.
   */
  resetAll(): void {
    for (const [userId] of this.processes) {
      this.reset(userId);
    }
    if (this.reaperInterval) {
      clearInterval(this.reaperInterval);
    }
  }

  /**
   * Return info about all active (non-dead) processes.
   */
  getActiveProcesses(): Array<{ userId: number; state: string; model: string }> {
    const result: Array<{ userId: number; state: string; model: string }> = [];
    for (const [userId, proc] of this.processes) {
      if (proc.state !== "dead") {
        result.push({ userId, state: proc.state, model: proc.model });
      }
    }
    return result;
  }

  private startReaper(): void {
    this.reaperInterval = setInterval(() => {
      const now = Date.now();
      for (const [userId, lastTime] of this.lastActivity) {
        if (now - lastTime > this.idleTimeoutMs) {
          info("persistent-process", `Reaping idle process for user ${userId}`);
          this.reset(userId);
        }
      }
    }, 60_000); // Check every minute
  }
}
