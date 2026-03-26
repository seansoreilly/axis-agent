import { spawn } from "node:child_process";
import { join } from "node:path";
import type { Config } from "./config.js";
import type { SqliteStore } from "./persistence.js";
import { error as logError, info, createLogger } from "./logger.js";
import { ensureValidToken } from "./auth.js";
import { DynamicContextBuilder } from "./dynamic-context.js";
import { ProcessManager } from "./persistent-process.js";

export interface RateLimitInfo {
  status: "allowed" | "allowed_warning" | "rejected";
  utilization?: number;
  resetsAt?: number;
  rateLimitType?: string;
  isUsingOverage?: boolean;
}

export interface AgentResult {
  text: string;
  sessionId: string;
  durationMs: number;
  totalCostUsd: number;
  isError: boolean;
  isTimeout: boolean;
  rateLimit?: RateLimitInfo;
}

/** Stream-json message types from Claude Code CLI */
interface StreamMessage {
  type: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  duration_ms?: number;
  total_cost_usd?: number;
  is_error?: boolean;
  message?: {
    content: Array<{ type: string; text?: string } | string>;
  };
  errors?: string[];
}

/**
 * Spawn the `claude` CLI and parse stream-json output.
 */
function spawnClaude(args: string[], opts: {
  cwd: string;
  signal?: AbortSignal;
  timeoutMs: number;
}): Promise<{ resultText: string; sessionId: string; durationMs: number; totalCostUsd: number; isError: boolean; isTimeout: boolean }> {
  return new Promise((resolve, reject) => {
    let resultText = "";
    let sessionId = "";
    let durationMs = 0;
    let totalCostUsd = 0;
    let isError = false;
    let isTimeout = false;
    let buffer = "";
    let killed = false;

    const proc = spawn("claude", args, {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
        CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
        CLAUDE_STREAM_IDLE_TIMEOUT_MS: String(opts.timeoutMs + 30_000),
      },
    });

    const timeoutId = setTimeout(() => {
      killed = true;
      isTimeout = true;
      proc.kill("SIGTERM");
    }, opts.timeoutMs);

    const onAbort = (): void => {
      killed = true;
      proc.kill("SIGTERM");
    };
    if (opts.signal) {
      if (opts.signal.aborted) {
        proc.kill("SIGTERM");
        clearTimeout(timeoutId);
        resolve({ resultText: "Request cancelled.", sessionId: "", durationMs: 0, totalCostUsd: 0, isError: true, isTimeout: false });
        return;
      }
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    proc.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg: StreamMessage = JSON.parse(line);

          if (msg.type === "system" && msg.subtype === "init" && msg.session_id) {
            sessionId = msg.session_id;
          }

          if (msg.type === "assistant" && msg.message?.content) {
            for (const block of msg.message.content) {
              if (typeof block === "object" && "type" in block && block.type === "text" && block.text) {
                resultText = block.text;
              }
            }
          }

          if (msg.type === "result") {
            if (msg.session_id) sessionId = msg.session_id;
            durationMs = msg.duration_ms ?? 0;
            totalCostUsd = msg.total_cost_usd ?? 0;

            if (msg.subtype === "success" && !msg.is_error) {
              resultText = msg.result ?? resultText;
            } else {
              isError = true;
              if (msg.result) {
                resultText = msg.result;
              } else if (msg.errors?.length) {
                resultText = `Error: ${msg.errors.join(", ")}`;
              } else {
                resultText = "The agent encountered an error. Please try again or start a /new session.";
              }
            }
          }
        } catch {
          // Skip unparseable lines
        }
      }
    });

    let stderrOutput = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      stderrOutput += chunk.toString();
    });

    proc.on("close", (code) => {
      clearTimeout(timeoutId);
      opts.signal?.removeEventListener("abort", onAbort);

      if (killed && isTimeout) {
        resolve({
          resultText: "Request timed out. Try a shorter request or start a /new session.",
          sessionId, durationMs, totalCostUsd, isError: true, isTimeout: true,
        });
        return;
      }

      if (killed) {
        resolve({
          resultText: "Request cancelled.",
          sessionId, durationMs, totalCostUsd, isError: true, isTimeout: false,
        });
        return;
      }

      if (code !== 0 && !resultText) {
        isError = true;
        if (stderrOutput.includes("exited with code 1") || code === 1) {
          resultText = "Claude Code process failed (likely auth/permissions). Token refresh was attempted — please retry.";
        } else {
          resultText = "An internal error occurred. Please try again.";
        }
      }

      resolve({ resultText: resultText || "(no response)", sessionId, durationMs, totalCostUsd, isError, isTimeout });
    });

    proc.on("error", (err) => {
      clearTimeout(timeoutId);
      opts.signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
  });
}

export class Agent {
  private readonly contextBuilder: DynamicContextBuilder;
  private processManager!: ProcessManager;
  private readonly agents = {
    research: {
      description: "Thorough research and analysis agent for tasks requiring investigation, comparison, multi-source research, synthesizing documents, technical analysis, and moderate coding tasks. Use when the main agent lacks the depth needed.",
      prompt: "You are a thorough research assistant. Investigate deeply, cross-reference sources, and provide well-structured findings.",
      model: "sonnet",
      tools: "Read,Grep,Glob,Bash,WebSearch,WebFetch,mcp__*",
      maxTurns: 15,
    },
    reasoning: {
      description: "Advanced reasoning agent for complex architecture decisions, nuanced creative writing, multi-step logical reasoning, holistic code review, and strategic planning. Use sparingly — only when the task genuinely requires deep thought.",
      prompt: "You are an advanced reasoning assistant. Think carefully and provide thorough, well-reasoned analysis.",
      model: "opus",
      tools: "Read,Edit,Write,Grep,Glob,Bash,WebSearch,WebFetch,mcp__*",
      maxTurns: 20,
    },
  };
  private readonly allowedTools = ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebSearch", "WebFetch", "Task", "mcp__*"];

  constructor(
    private readonly config: Config,
    store: SqliteStore,
    identity?: import("./identity.js").IdentityManager,
  ) {
    const reflectionStorePath = join(config.memoryDir, "reflections.jsonl");
    this.contextBuilder = new DynamicContextBuilder(store, identity, config.claude.workDir, reflectionStorePath);
    // ProcessManager created lazily after async identity context is loaded
    this.initPromise = this.contextBuilder.buildDynamicContext().then((ctx) => {
      this.processManager = new ProcessManager({
        model: config.claude.model,
        workDir: config.claude.workDir,
        maxBudgetUsd: config.claude.maxBudgetUsd,
        systemPrompt: ctx,
        allowedTools: this.allowedTools,
        agents: this.agents,
        selfReview: true,
      });
    });
  }

  private readonly initPromise: Promise<void>;

  private async ensureReady(): Promise<void> {
    await this.initPromise;
  }

  async run(
    prompt: string,
    opts?: {
      sessionId?: string;
      model?: string;
      signal?: AbortSignal;
      userId?: number;
      timeoutMs?: number;
      correlationId?: string;
      onActivity?: (event: { tool?: string; text?: string }) => void;
    }
  ): Promise<AgentResult> {
    const { claude } = this.config;
    const model = opts?.model ?? claude.model;
    const timeoutMs = opts?.timeoutMs ?? claude.agentTimeoutMs;
    const log = createLogger(opts?.correlationId);

    await this.ensureReady();

    log.info("agent", `Starting run (model: ${model}, timeout: ${timeoutMs}ms)`);

    // Use persistent process for user-initiated requests
    if (opts?.userId) {
      return this.runPersistent(prompt, opts.userId, model, timeoutMs, opts.signal, opts.onActivity);
    }

    // Fall back to one-shot spawn for jobs/webhooks (no userId)
    return this.runOneShot(prompt, model, timeoutMs, opts?.sessionId, opts?.signal);
  }

  /**
   * Send prompt to a persistent process for this user.
   * Falls back to one-shot spawn on process crash.
   */
  private async runPersistent(
    prompt: string,
    userId: number,
    model: string,
    timeoutMs: number,
    signal?: AbortSignal,
    onActivity?: (event: { tool?: string; text?: string }) => void,
  ): Promise<AgentResult> {
    try {
      info("agent", `Using persistent process for user ${userId} (model: ${model})`);
      const proc = await this.processManager.getOrCreate(userId, model, onActivity);
      info("agent", `Persistent process ready for user ${userId} (session: ${proc.sessionId})`);
      const result = await proc.sendPrompt(prompt, { timeoutMs, signal, maxRunMs: 5 * 60 * 1000 });
      info("agent", `Persistent process completed for user ${userId} (${result.durationMs}ms, error: ${result.isError})`);
      return {
        text: result.text,
        sessionId: result.sessionId,
        durationMs: result.durationMs,
        totalCostUsd: result.totalCostUsd,
        isError: result.isError,
        isTimeout: result.isTimeout,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (/dead|crash|exited|timed out|startup/i.test(msg)) {
        info("agent", `Persistent process failed for user ${userId}, falling back to one-shot: ${msg}`);
        this.processManager.reset(userId);
        return this.runOneShot(prompt, model, timeoutMs, undefined, signal);
      }
      return this.makeErrorResult(msg);
    }
  }

  /**
   * Legacy one-shot spawn — used for jobs/webhooks and as fallback.
   */
  private async runOneShot(
    prompt: string,
    model: string,
    timeoutMs: number,
    sessionId?: string,
    signal?: AbortSignal,
  ): Promise<AgentResult> {
    const { claude } = this.config;
    const dynamicContext = await this.contextBuilder.buildDynamicContext();

    const args: string[] = [
      "-p",
      "--output-format", "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
      "--model", model,
      "--max-budget-usd", String(claude.maxBudgetUsd),
      "--append-system-prompt", dynamicContext,
      "--allowed-tools", ...this.allowedTools,
      "--agents", JSON.stringify(this.agents),
    ];

    if (sessionId) {
      args.push("--resume", sessionId);
    }

    args.push(prompt);

    await ensureValidToken();

    try {
      const result = await spawnClaude(args, {
        cwd: claude.workDir,
        signal,
        timeoutMs,
      });

      return {
        text: result.resultText,
        sessionId: result.sessionId,
        durationMs: result.durationMs,
        totalCostUsd: result.totalCostUsd,
        isError: result.isError,
        isTimeout: result.isTimeout,
      };
    } catch (error) {
      return this.makeErrorResult(error instanceof Error ? error.message : String(error));
    }
  }

  private makeErrorResult(msg: string): AgentResult {
    logError("agent", `Run failed: ${msg}`);

    let resultText: string;
    let isTimeout = false;
    if (/rate limit|429|529|overloaded/i.test(msg)) {
      resultText = "Rate limited. Please wait a few minutes and try again.";
    } else if (/timeout|ETIMEDOUT|timed out/i.test(msg)) {
      isTimeout = true;
      resultText = "Request timed out. Try a shorter request or start a /new session.";
    } else if (/ECONNRESET|ECONNREFUSED|socket hang up/i.test(msg)) {
      resultText = "Connection error — usually temporary, please retry.";
    } else if (/ENOENT/i.test(msg)) {
      resultText = "Claude Code CLI not found. Ensure `claude` is installed and in PATH.";
    } else {
      resultText = "An internal error occurred. Please try again.";
    }

    return {
      text: resultText,
      sessionId: "",
      durationMs: 0,
      totalCostUsd: 0,
      isError: true,
      isTimeout,
    };
  }

  /**
   * Kill the persistent process for a user (used by /new, /model).
   */
  resetSession(userId: number): void {
    this.processManager.reset(userId);
  }

  /**
   * Return info about all active persistent processes.
   */
  getActiveProcesses(): Array<{ userId: number; state: string; model: string }> {
    return this.processManager.getActiveProcesses();
  }

  /**
   * Kill all persistent processes (used at shutdown).
   */
  shutdown(): void {
    this.processManager.resetAll();
  }
}
