import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "./config.js";
import type { Memory } from "./memory.js";
import { error as logError, info } from "./logger.js";
import { ensureValidToken } from "./auth.js";
import { PromptBuilder } from "./prompt-builder.js";

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
  rateLimit?: RateLimitInfo;
}

/** Cost threshold (USD) above which we generate a conversation summary. */
const SUMMARY_COST_THRESHOLD = 0.05;

/** Default search paths for SOUL.md, checked in order. */
const SOUL_MD_SEARCH_PATHS = [
  "SOUL.md",              // relative to cwd (project root)
  "../SOUL.md",           // parent dir (when running from dist/)
];

/**
 * Load SOUL.md from disk. Searches default paths, then falls back to
 * an explicit absolute path if provided. Returns null if not found.
 */
export function loadSoulMd(basePath?: string): string | null {
  // Check explicit path first
  if (basePath) {
    if (existsSync(basePath)) {
      return readFileSync(basePath, "utf-8");
    }
    return null;
  }

  // Search default paths relative to cwd
  const cwd = process.cwd();
  for (const relPath of SOUL_MD_SEARCH_PATHS) {
    const fullPath = join(cwd, relPath);
    if (existsSync(fullPath)) {
      info("agent", `Loaded personality from ${fullPath}`);
      return readFileSync(fullPath, "utf-8");
    }
  }

  return null;
}

interface SkillInfo {
  name: string;
  description: string;
  dir: string;
}

/**
 * Scan .claude/skills/ for SKILL.md files and extract name + description
 * from YAML frontmatter. Returns a list of discovered skills.
 */
export function discoverSkills(skillsDir: string): SkillInfo[] {
  if (!existsSync(skillsDir)) return [];
  const skills: SkillInfo[] = [];
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillMdPath = join(skillsDir, entry.name, "SKILL.md");
    if (!existsSync(skillMdPath)) continue;
    const content = readFileSync(skillMdPath, "utf-8");
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) continue;
    const nameMatch = fmMatch[1].match(/^name:\s*(.+)$/m);
    const descMatch = fmMatch[1].match(/^description:\s*(.+)$/m);
    if (nameMatch && descMatch) {
      skills.push({
        name: nameMatch[1].trim(),
        description: descMatch[1].trim(),
        dir: join(skillsDir, entry.name),
      });
    }
  }
  return skills;
}

export class Agent {
  private config: Config;
  private memory: Memory;
  private soulMd: string | null;
  private skillsDir: string;
  private promptBuilder: PromptBuilder;

  constructor(config: Config, memory: Memory, soulMdPath?: string) {
    this.config = config;
    this.memory = memory;
    this.soulMd = loadSoulMd(soulMdPath);
    this.promptBuilder = new PromptBuilder(config, memory);
    if (this.soulMd) {
      info("agent", "Using SOUL.md for core personality");
    } else {
      info("agent", "No SOUL.md found, using built-in default prompt");
    }
    this.skillsDir = join(config.claude.workDir, ".claude", "skills");
    const skills = discoverSkills(this.skillsDir);
    if (skills.length > 0) {
      info("agent", `Discovered ${skills.length} skills: ${skills.map(s => s.name).join(", ")}`);
    }
  }

  /** Build dynamic skills section from discovered SKILL.md files (re-scanned each call). */
  private buildSkillsPrompt(): string {
    const skills = discoverSkills(this.skillsDir);
    if (skills.length === 0) return "";
    const lines = [
      "",
      "## Available Skills",
      "You have the following skills installed. Before using a skill, read its SKILL.md for full usage instructions.",
      "",
    ];
    for (const skill of skills) {
      lines.push(`- **${skill.name}** (${skill.dir}/SKILL.md) — ${skill.description}`);
    }
    lines.push("");
    lines.push("To use a skill: `cat <skill_dir>/SKILL.md` to read the instructions, then follow them.");
    return lines.join("\n");
  }

  /** Build the core system prompt (always included). */
  private buildCorePrompt(): string {
    return this.promptBuilder.buildCorePrompt(this.soulMd);
  }

  /** Build extended prompt sections (included on first message of session only). */
  private buildExtendedPrompt(): string {
    return this.promptBuilder.buildExtendedPrompt(this.buildSkillsPrompt());
  }

  /** Build memory context section for injection into the system prompt. */
  private buildMemoryContext(userId?: number): string {
    return this.promptBuilder.buildMemoryContext(userId);
  }

  async run(
    prompt: string,
    opts?: { sessionId?: string; model?: string; signal?: AbortSignal; userId?: number }
  ): Promise<AgentResult> {
    const isResumedSession = !!opts?.sessionId;
    const { claude } = this.config;

    const systemPrompt = this.promptBuilder.buildSystemPrompt({
      resumedSession: isResumedSession,
      userId: opts?.userId,
      soulMd: this.soulMd,
      runtimeSkillsSection: this.buildSkillsPrompt(),
    });

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
      agents: {
        "research": {
          description: "Thorough research and analysis agent for tasks requiring investigation, comparison, multi-source research, synthesizing documents, technical analysis, and moderate coding tasks. Use when the main agent (Haiku) lacks the depth needed.",
          prompt: "You are a thorough research assistant. Investigate deeply, cross-reference sources, and provide well-structured findings.",
          model: "sonnet",
        },
        "reasoning": {
          description: "Advanced reasoning agent for complex architecture decisions, nuanced creative writing, multi-step logical reasoning, holistic code review, and strategic planning. Use sparingly — only when the task genuinely requires deep thought.",
          prompt: "You are an advanced reasoning assistant. Think carefully and provide thorough, well-reasoned analysis.",
          model: "opus",
          maxTurns: 15,
        },
      },
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
    let rateLimit: RateLimitInfo | undefined;

    // Pre-flight: ensure OAuth token is valid before spawning SDK
    await ensureValidToken();

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
            if ("errors" in message && message.errors.length > 0) {
              resultText = `Error: ${message.errors.join(", ")}`;
            } else {
              resultText = "The agent encountered an error. Please try again or start a /new session.";
            }
          }
        }

        if (message.type === "rate_limit_event") {
          const rl = message.rate_limit_info;
          rateLimit = {
            status: rl.status,
            utilization: rl.utilization,
            resetsAt: rl.resetsAt,
            rateLimitType: rl.rateLimitType,
            isUsingOverage: rl.isUsingOverage,
          };
          if (rl.status !== "allowed") {
            info("agent", `Rate limit ${rl.status}: ${rl.rateLimitType} at ${Math.round((rl.utilization ?? 0) * 100)}% utilization`);
          }
        }
      }
    } catch (error) {
      isError = true;
      const msg = error instanceof Error ? error.message : String(error);
      logError("agent", `Run failed: ${msg}`);
      if (msg.includes("exited with code 1")) {
        resultText = "Claude Code process failed (likely auth/permissions). Token refresh was attempted — please retry.";
      } else {
        resultText = "An internal error occurred. Please try again.";
      }
    }

    return {
      text: resultText || "(no response)",
      sessionId,
      durationMs,
      totalCostUsd,
      isError,
      rateLimit,
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
