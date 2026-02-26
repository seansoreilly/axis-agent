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
    opts?: { sessionId?: string; model?: string; signal?: AbortSignal }
  ): Promise<AgentResult> {
    const memoryContext = this.memory.getContext();
    const { claude } = this.config;
    const systemPrompt = [
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
      "## Google Calendar",
      "You have access to the user's calendar via an iCal feed and Google Calendar API.",
      "",
      "**Read events (iCal — fastest):**",
      "  python3 /home/ubuntu/agent/scripts/calendar/ical_fetch.py --days 7",
      "  python3 /home/ubuntu/agent/scripts/calendar/ical_fetch.py --days 30",
      "  # Returns JSON with events: summary, start, end, location, description",
      "",
      "**Google Calendar API (read/write):**",
      "  python3 /home/ubuntu/agent/scripts/calendar/calendar_list.py --days 7",
      "  python3 /home/ubuntu/agent/scripts/calendar/calendar_create.py --summary 'Meeting' --start '2026-03-01T10:00:00+11:00' --end '2026-03-01T11:00:00+11:00'",
      "  python3 /home/ubuntu/agent/scripts/calendar/calendar_update.py --event-id ID --summary 'New title'",
      "  python3 /home/ubuntu/agent/scripts/calendar/calendar_delete.py --event-id ID",
      "  python3 /home/ubuntu/agent/scripts/calendar/calendar_search.py --query 'meeting'",
      "  python3 /home/ubuntu/agent/scripts/calendar/calendar_calendars.py",
      "  # Service account: REDACTED_SERVICE_ACCOUNT",
      "  # To write to user's calendar, that calendar must be shared with the service account",
      "",
      "**When user asks about schedule/calendar/events:** always run ical_fetch.py first for a quick read.",
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
      "",
      memoryContext
        ? `## Currently Remembered Facts\n${memoryContext}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");

    const options: Parameters<typeof query>[0]["options"] = {
      cwd: this.config.claude.workDir,
      model: opts?.model ?? this.config.claude.model,
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
}
