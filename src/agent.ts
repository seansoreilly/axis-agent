import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "./config.js";
import type { Memory } from "./memory.js";
import { error as logError } from "./logger.js";

export interface AgentResult {
  text: string;
  sessionId: string;
  durationMs: number;
  totalCostUsd: number;
  isError: boolean;
}

export class Agent {
  private config: Config;
  private memory: Memory;

  constructor(config: Config, memory: Memory) {
    this.config = config;
    this.memory = memory;
  }

  async run(
    prompt: string,
    opts?: { sessionId?: string }
  ): Promise<AgentResult> {
    const memoryContext = this.memory.getContext();
    const systemPrompt = [
      "You are a helpful AI assistant running as an always-on agent on a cloud server.",
      "You can browse the web, manage files, run commands, and help with research and tasks.",
      "Be concise in your responses — they will be sent via Telegram.",
      "For long outputs, summarize and offer to provide details if needed.",
      "",
      memoryContext
        ? `## Persistent Memory\n${memoryContext}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");

    const options: Parameters<typeof query>[0]["options"] = {
      cwd: this.config.claude.workDir,
      model: this.config.claude.model,
      maxTurns: this.config.claude.maxTurns,
      maxBudgetUsd: this.config.claude.maxBudgetUsd,
      systemPrompt,
      permissionMode: "bypassPermissions" as const,
      allowDangerouslySkipPermissions: true,
      allowedTools: [
        "Read",
        "Write",
        "Edit",
        "Bash",
        "Glob",
        "Grep",
        "WebSearch",
        "WebFetch",
        "Task",
      ],
    };

    // Resume existing session if provided
    if (opts?.sessionId) {
      options.resume = opts.sessionId;
    }

    let resultText = "";
    let sessionId = "";
    let durationMs = 0;
    let totalCostUsd = 0;
    let isError = false;

    try {
      const conversation = query({ prompt, options });

      for await (const message of conversation) {
        if (message.type === "system" && message.subtype === "init") {
          sessionId = message.session_id;
        }

        if (message.type === "assistant" && !("isReplay" in message)) {
          // Extract text content from the assistant message
          for (const block of message.message.content) {
            if (
              typeof block === "object" &&
              "type" in block &&
              block.type === "text"
            ) {
              resultText = block.text;
            }
          }
        }

        if (message.type === "result") {
          sessionId = message.session_id;
          durationMs = message.duration_ms;
          totalCostUsd = message.total_cost_usd;

          if (message.subtype === "success") {
            resultText = message.result;
          } else {
            isError = true;
            if ("errors" in message) {
              resultText = `Error: ${message.errors.join(", ")}`;
            }
          }
        }
      }
    } catch (error) {
      isError = true;
      logError("agent", `Run failed: ${error instanceof Error ? error.message : String(error)}`);
      resultText = "An internal error occurred. Please try again.";
    }

    return {
      text: resultText || "(no response)",
      sessionId,
      durationMs,
      totalCostUsd,
      isError,
    };
  }
}
