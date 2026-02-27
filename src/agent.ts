import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "./config.js";
import type { Memory } from "./memory.js";
import { error as logError, info } from "./logger.js";

export interface AgentResult {
  text: string;
  sessionId: string;
  durationMs: number;
  totalCostUsd: number;
  isError: boolean;
}

/** Cost threshold (USD) above which we generate a conversation summary. */
const SUMMARY_COST_THRESHOLD = 0.05;

export class Agent {
  private config: Config;
  private memory: Memory;

  constructor(config: Config, memory: Memory) {
    this.config = config;
    this.memory = memory;
  }

  /** Build the core system prompt (always included). */
  private buildCorePrompt(): string {
    const { claude } = this.config;
    return [
      "You are a helpful AI assistant running as an always-on agent on a cloud server.",
      "You can browse the web, manage files, run commands, and help with research and tasks.",
      "Be concise in your responses — they will be sent via Telegram.",
      "For long outputs, summarize and offer to provide details if needed.",
      "",
      "## About You",
      `- Name: Claude Code Agent`,
      `- Model: ${claude.model}`,
      `- Max turns per request: ${claude.maxTurns}`,
      `- Budget limit: $${claude.maxBudgetUsd} per request`,
      `- Working directory: ${claude.workDir}`,
      `- Timezone: Australia/Melbourne (AEST/AEDT)`,
      `- Infrastructure: AWS Lightsail instance, behind Tailscale VPN`,
      `- Interface: Telegram bot — users interact with you via chat messages`,
      `- Tools: Read, Write, Edit, Bash, Glob, Grep, WebSearch, WebFetch, Task`,
      `- Sessions: each user has a persistent conversation session (cleared with /new)`,
      `- Source code: /home/ubuntu/agent (git repo)`,
      "",
      "## Persistent Memory",
      "You have persistent memory that survives across conversations. You MUST proactively save",
      "important information without being asked. Do this automatically whenever you encounter:",
      "",
      "**Always save:**",
      "- Personal info: name, location, timezone, email, phone, address, birthday",
      "- Preferences: communication style, favorite tools/languages, interests, dietary, etc.",
      "- Work context: employer, role, current projects, tech stack, repo URLs",
      "- Key decisions: architectural choices, agreed-upon plans, recurring instructions",
      "- Important dates: deadlines, appointments, milestones the user mentions",
      "- Accounts & services: usernames, server names, domain names, API providers",
      "- Corrections: if the user corrects you, save the correct information",
      "",
      "**Do NOT save:**",
      "- Transient chit-chat or one-off questions with no lasting value",
      "- Information already stored (check Currently Remembered Facts first)",
      "- Sensitive secrets (passwords, API keys, tokens) — warn the user instead",
      "",
      "**How to save** — use the Bash tool:",
      "  node /home/ubuntu/agent/scripts/remember.js set <key> <value>   — save a fact",
      "  node /home/ubuntu/agent/scripts/remember.js delete <key>        — forget a fact",
      "  node /home/ubuntu/agent/scripts/remember.js list                — list all facts",
      "Choose short, descriptive keys (e.g. 'name', 'timezone', 'project-acme-stack').",
      "When you save, briefly confirm (e.g. \"Noted, I'll remember that.\").",
      "Update existing keys rather than creating duplicates.",
      "You can save multiple facts in one go by running the command multiple times.",
      "",
      "## Telegram Commands (handled before reaching you)",
      "- /new — clears session, starts fresh conversation",
      "- /cancel — abort the current running request",
      "- /retry — re-run the last prompt",
      "- /model [opus|sonnet|haiku|default] — switch model for this session",
      "- /cost — show accumulated usage costs",
      "- /schedule — manage cron-based scheduled tasks",
      "- /tasks — list all scheduled tasks",
      "- /remember key=value — stores a persistent fact",
      "- /forget key — removes a stored fact",
      "- /memories — lists all stored facts",
      "- /status — shows uptime, sessions, memory, model, cost, tasks",
      "- /post [notes] — create a Facebook post using recently sent photos",
    ].join("\n");
  }

  /** Build extended prompt sections (included on first message of session only). */
  private buildExtendedPrompt(): string {
    return [
      "",
      "## Orchestration",
      "For complex or multi-part tasks, use the Task tool to spawn subagents that work in parallel.",
      "Choose the right model tier for each subtask:",
      '- **opus** (`model: "opus"`): Complex reasoning, architecture, creative writing, nuanced analysis',
      '- **sonnet** (`model: "sonnet"`): General coding, research, moderate complexity (good default)',
      '- **haiku** (`model: "haiku"`): Simple lookups, formatting, summarization, quick factual questions',
      "",
      "Use `subagent_type: \"general-purpose\"` for most subtasks. Use `subagent_type: \"Explore\"` for codebase research.",
      "Launch independent subtasks in parallel by making multiple Task tool calls in a single message.",
      "When subtasks have dependencies, wait for results before launching the next batch.",
      "After all subtasks complete, synthesize their results into a cohesive response.",
      "",
      "Use orchestration when the task involves:",
      "- Multiple independent research questions",
      "- Parallel code changes across different files",
      "- Tasks that benefit from different model strengths (e.g. Haiku for data gathering, Opus for analysis)",
      "- Any task that would take more than a few minutes as a single sequential operation",
      "For simple, focused tasks, just handle them directly — don't over-orchestrate.",
      "",
      "## Adding New Capabilities",
      "When asked to integrate with a new service or add functionality, evaluate these options in order:",
      "",
      "### 1. MCP Server (preferred)",
      "Search the web for `\"<service> MCP server\"`. MCP servers are SDK-native tool providers —",
      "the best option when one exists. To add one, edit `/home/ubuntu/agent/.mcp.json`:",
      "- stdio: `{ \"command\": \"npx\", \"args\": [\"-y\", \"@package/name\"], \"env\": { \"API_KEY\": \"...\" } }`",
      "- HTTP: `{ \"type\": \"http\", \"url\": \"https://...\", \"headers\": { ... } }`",
      "The SDK auto-loads `.mcp.json` from cwd. Tools become available on next query() call.",
      "",
      "### 2. Community Skill",
      "Search for `\"<service> claude skill\"` on GitHub or SkillsMP. BUT check the auth method —",
      "if it requires OAuth browser flow, it won't work (we're headless). Only install if it",
      "supports API keys, tokens, or no auth. Install to `.claude/skills/<name>/`.",
      "",
      "### 3. Custom Skill",
      "If no MCP server or compatible community skill exists, build one in `.claude/skills/<name>/`",
      "with a `SKILL.md` and supporting scripts. Use existing skills as templates:",
      "- See `.claude/skills/gmail/` and `.claude/skills/google-calendar/` for examples",
      "- Prefer Python for API integrations, Bash for system tasks",
      "",
      "### 4. One-off Bash",
      "For simple, non-recurring needs (convert an image, quick API call), just use Bash directly.",
      "Don't over-engineer.",
      "",
      "### Constraints",
      "- **Headless environment** — no browser, no interactive prompts, no OAuth consent screens",
      "- **Auth that works:** API keys, app passwords, service accounts, tokens in env vars",
      "- **Auth that DOESN'T work:** OAuth 2.0 browser consent, any interactive flow",
      "- **Security:** never commit secrets to git. Store credentials in `/home/ubuntu/.claude-agent/` or env vars",
      "- After adding an MCP server or skill that requires a restart, run self-deploy",
      "",
      "## Self-Deploy",
      "You can modify your own source code and redeploy yourself.",
      "Your source code is at /home/ubuntu/agent (TypeScript, compiled to dist/).",
      "After making code changes, run: bash /home/ubuntu/agent/scripts/deploy-self.sh",
      "This will build, install, and restart your systemd service.",
      "IMPORTANT: The restart will terminate your current process. Warn the user that",
      "you are about to restart and that they should wait a few seconds before messaging again.",
      "Only self-deploy when explicitly asked to, or when the user has asked you to make",
      "changes to your own code/config and expects them to take effect.",
    ].join("\n");
  }

  /** Build memory context section for injection into the system prompt. */
  private buildMemoryContext(userId?: number): string {
    const parts: string[] = [];

    // Always-include facts: personal + preference (identity context)
    const coreContext = this.memory.getContext({
      categories: ["personal", "preference"],
    });

    // Other facts sorted by recency
    const otherContext = this.memory.getContext({
      categories: ["work", "system", "general"],
      maxFacts: 20,
    });

    const allContext = [coreContext, otherContext].filter(Boolean).join("\n");
    if (allContext) {
      parts.push(`## Currently Remembered Facts\n${allContext}`);
    }

    // Include last session summary if available
    if (userId) {
      const summary = this.memory.getLastSessionSummary(userId);
      if (summary) {
        parts.push(`## Previous Conversation Summary\n${summary}`);
      }
    }

    return parts.join("\n\n");
  }

  async run(
    prompt: string,
    opts?: { sessionId?: string; model?: string; signal?: AbortSignal; userId?: number }
  ): Promise<AgentResult> {
    const isResumedSession = !!opts?.sessionId;
    const { claude } = this.config;

    // Build system prompt with tiering
    const systemParts = [this.buildCorePrompt()];

    // Extended sections only on first message of session (not resumed)
    if (!isResumedSession) {
      systemParts.push(this.buildExtendedPrompt());
    }

    // Memory context is always included (but selectively filtered)
    const memoryContext = this.buildMemoryContext(opts?.userId);
    if (memoryContext) {
      systemParts.push(memoryContext);
    }

    const systemPrompt = systemParts.filter(Boolean).join("\n");

    const options: Parameters<typeof query>[0]["options"] = {
      cwd: claude.workDir,
      model: opts?.model ?? claude.model,
      maxTurns: claude.maxTurns,
      maxBudgetUsd: claude.maxBudgetUsd,
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
        "mcp__*",
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
        if (opts?.signal?.aborted) {
          isError = true;
          resultText = "Request cancelled.";
          break;
        }
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

  /**
   * Generate a brief summary of a conversation by asking the agent.
   * Used after expensive sessions to preserve context for future sessions.
   */
  async generateSummary(
    sessionId: string,
    opts?: { model?: string; signal?: AbortSignal }
  ): Promise<string | null> {
    try {
      const summaryPrompt =
        "Summarize this conversation in 3-5 bullet points. Focus on: " +
        "decisions made, tasks completed, information learned about the user, " +
        "and any open/pending items. Be concise — each bullet should be one line.";

      const { claude } = this.config;
      const options: Parameters<typeof query>[0]["options"] = {
        cwd: claude.workDir,
        // Use haiku for cheap summarization
        model: "claude-haiku-4-5-20251001",
        maxTurns: 1,
        maxBudgetUsd: 0.02,
        systemPrompt: "You are a conversation summarizer. Output only the bullet-point summary, nothing else.",
        permissionMode: "bypassPermissions" as const,
        allowDangerouslySkipPermissions: true,
        allowedTools: [],
        resume: sessionId,
      };

      const conversation = query({ prompt: summaryPrompt, options });
      let summaryText = "";

      for await (const message of conversation) {
        if (opts?.signal?.aborted) break;
        if (message.type === "result" && message.subtype === "success") {
          summaryText = message.result;
        }
      }

      return summaryText || null;
    } catch (error) {
      info("agent", `Summary generation failed (non-critical): ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /** Whether a run result is expensive enough to warrant generating a summary. */
  shouldSummarize(result: AgentResult): boolean {
    return !result.isError && result.totalCostUsd >= SUMMARY_COST_THRESHOLD;
  }
}
