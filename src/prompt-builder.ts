import type { Config } from "./config.js";
import type { Memory } from "./memory.js";
import { DEFAULT_CORE_SECTIONS, DEFAULT_EXTENDED_SECTIONS, type PromptSection } from "./prompt-config.js";

interface PromptBuildOptions {
  resumedSession?: boolean;
  userId?: number;
  soulMd?: string | null;
  runtimeSkillsSection?: string;
}

function renderSection(section: PromptSection): string {
  return [`## ${section.title}`, ...section.lines].join("\n");
}

export class PromptBuilder {
  constructor(
    private readonly config: Config,
    private readonly memory: Memory
  ) {}

  buildMemoryContext(userId?: number): string {
    const parts: string[] = [];
    const coreContext = this.memory.getContext({
      categories: ["personal", "preference"],
    });
    const otherContext = this.memory.getContext({
      categories: ["work", "system", "general"],
      maxFacts: 20,
    });

    const allContext = [coreContext, otherContext].filter(Boolean).join("\n");
    if (allContext) {
      parts.push(`## Currently Remembered Facts\n${allContext}`);
    }

    if (userId) {
      const summary = this.memory.getLastSessionSummary(userId);
      if (summary) {
        parts.push(`## Previous Conversation Summary\n${summary}`);
      }
    }

    return parts.join("\n\n");
  }

  buildCorePrompt(soulMd?: string | null): string {
    const { claude } = this.config;
    const runtimeContext = [
      "## Runtime",
      `- Model: ${claude.model}`,
      `- Max turns per request: ${claude.maxTurns}`,
      `- Budget limit: $${claude.maxBudgetUsd} per request`,
      `- Working directory: ${claude.workDir}`,
      "- Timezone: Australia/Melbourne (AEST/AEDT)",
      "- Infrastructure: AWS Lightsail instance, behind Tailscale VPN",
      "- Interface: Telegram bot — users interact with you via chat messages",
      "- Tools: Read, Write, Edit, Bash, Glob, Grep, WebSearch, WebFetch, Task, Composio MCP (mcp__composio__*), Playwright MCP (mcp__playwright__*)",
      '- Location: always available via the "current-location" memory fact.',
      "- Source code: /home/ubuntu/agent (git repo)",
    ].join("\n");

    if (soulMd) {
      return `${soulMd}\n\n${runtimeContext}`;
    }

    return [DEFAULT_CORE_SECTIONS.map(renderSection).join("\n\n"), runtimeContext].join("\n\n");
  }

  buildExtendedPrompt(runtimeSkillsSection?: string): string {
    return [runtimeSkillsSection ?? "", DEFAULT_EXTENDED_SECTIONS.map(renderSection).join("\n\n")]
      .filter(Boolean)
      .join("\n\n");
  }

  buildSystemPrompt(opts: PromptBuildOptions): string {
    const parts = [this.buildCorePrompt(opts.soulMd)];
    if (!opts.resumedSession) {
      parts.push(this.buildExtendedPrompt(opts.runtimeSkillsSection));
    }

    const memoryContext = this.buildMemoryContext(opts.userId);
    if (memoryContext) {
      parts.push(memoryContext);
    }

    return parts.filter(Boolean).join("\n");
  }
}
