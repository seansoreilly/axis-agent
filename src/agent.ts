import { spawn } from "node:child_process";
import type { Config } from "./config.js";
import type { SqliteStore } from "./persistence.js";
import { error as logError } from "./logger.js";
import { ensureValidToken } from "./auth.js";
import { DynamicContextBuilder } from "./dynamic-context.js";

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
      env: { ...process.env },
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

  constructor(
    private readonly config: Config,
    store: SqliteStore,
  ) {
    this.contextBuilder = new DynamicContextBuilder(store);
  }

  async run(
    prompt: string,
    opts?: { sessionId?: string; model?: string; signal?: AbortSignal; userId?: number; timeoutMs?: number }
  ): Promise<AgentResult> {
    const { claude } = this.config;
    const model = opts?.model ?? claude.model;
    const dynamicContext = this.contextBuilder.buildDynamicContext();

    const args: string[] = [
      "-p",
      "--output-format", "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
      "--model", model,
      "--max-budget-usd", String(claude.maxBudgetUsd),
      "--append-system-prompt", dynamicContext,
      "--allowed-tools", "Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebSearch", "WebFetch", "Task", "mcp__*",
      "--agents", JSON.stringify({
        research: {
          description: "Thorough research and analysis agent for tasks requiring investigation, comparison, multi-source research, synthesizing documents, technical analysis, and moderate coding tasks. Use when the main agent lacks the depth needed.",
          prompt: "You are a thorough research assistant. Investigate deeply, cross-reference sources, and provide well-structured findings.",
          model: "sonnet",
        },
        reasoning: {
          description: "Advanced reasoning agent for complex architecture decisions, nuanced creative writing, multi-step logical reasoning, holistic code review, and strategic planning. Use sparingly — only when the task genuinely requires deep thought.",
          prompt: "You are an advanced reasoning assistant. Think carefully and provide thorough, well-reasoned analysis.",
          model: "opus",
        },
      }),
    ];

    if (opts?.sessionId) {
      args.push("--resume", opts.sessionId);
    }

    args.push(prompt);

    const timeoutMs = opts?.timeoutMs ?? claude.agentTimeoutMs;

    await ensureValidToken();

    try {
      const result = await spawnClaude(args, {
        cwd: claude.workDir,
        signal: opts?.signal,
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
      const msg = error instanceof Error ? error.message : String(error);
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
  }
}
