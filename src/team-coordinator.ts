/**
 * Team Coordinator — Orchestrates parallel execution of multiple specialized agents
 * Implements fan-out/fan-in pattern for complex multi-part tasks
 *
 * ARCHITECTURE: Delegates to Task tool (native SDK parallelism) rather than direct query() calls.
 * The main agent invokes Task tool with subagent_type for each team member.
 * This coordinator orchestrates the process and synthesizes results.
 */

import type { Config } from "./config.js";
import { info } from "./logger.js";

export type AgentType = "research" | "reasoning" | "explore";

export interface TeamMemberSpec {
  type: AgentType;
  prompt: string;
  timeout?: number; // milliseconds, default 60000
}

export interface TeamMemberResult {
  type: AgentType;
  index: number;
  result: string;
  durationMs: number;
  costUsd: number;
  error?: string;
  isTimeout?: boolean;
}

export interface TeamExecutionResult {
  teamId: string;
  startedAtMs: number;
  completedAtMs: number;
  durationMs: number;
  totalCostUsd: number;
  memberResults: TeamMemberResult[];
  successCount: number;
  failureCount: number;
}

/**
 * Configuration for team execution
 */
export interface TeamConfig {
  maxMembers?: number; // default: 3
  maxTotalDurationMs?: number; // default: 120000
  perMemberTimeoutMs?: number; // default: 60000
  budgetPercent?: number; // default: 50 (% of session budget)
}

export class TeamCoordinator {
  private config: Config;
  private teamConfig: Required<TeamConfig>;

  constructor(config: Config, teamConfig?: TeamConfig) {
    this.config = config;
    this.teamConfig = {
      maxMembers: teamConfig?.maxMembers ?? 3,
      maxTotalDurationMs: teamConfig?.maxTotalDurationMs ?? 120000,
      perMemberTimeoutMs: teamConfig?.perMemberTimeoutMs ?? 60000,
      budgetPercent: teamConfig?.budgetPercent ?? 50,
    };
  }

  /**
   * Generate a team execution plan (prompts for each member).
   * The main agent will invoke Task tool with these prompts for parallel execution.
   * Returns the team ID and member specs so the agent can synthesize later.
   */
  generateTeamPlan(specs: TeamMemberSpec[], userId?: number): {
    teamId: string;
    members: Array<{
      type: AgentType;
      index: number;
      prompt: string;
      maxBudgetUsd: number;
    }>;
  } {
    // Validate team size
    if (specs.length === 0) {
      throw new Error("Team must have at least 1 member");
    }
    if (specs.length > this.teamConfig.maxMembers) {
      throw new Error(
        `Team size ${specs.length} exceeds max ${this.teamConfig.maxMembers}`
      );
    }

    const teamId = `team_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

    info("team-coordinator", `Planning team ${teamId} with ${specs.length} members`);

    // Generate member tasks for the agent to invoke via Task tool
    const members = specs.map((spec, index) => ({
      type: spec.type,
      index,
      prompt: this.buildMemberPrompt(spec, index, teamId, userId),
      maxBudgetUsd: this.getMaxBudgetForType(),
    }));

    return { teamId, members };
  }

  /**
   * Process team execution results from Task tool responses.
   * Called after the agent has collected all team member results.
   */
  synthesizeTeamResults(
    teamId: string,
    startedAtMs: number,
    memberResults: Array<{ type: AgentType; index: number; result: string; costUsd?: number }>
  ): TeamExecutionResult {
    const completedAtMs = Date.now();

    // Normalize results
    const normalized: TeamMemberResult[] = memberResults.map((mr) => ({
      type: mr.type,
      index: mr.index,
      result: mr.result || "",
      durationMs: completedAtMs - startedAtMs,
      costUsd: mr.costUsd ?? 0,
      error: undefined,
      isTimeout: false,
    }));

    const totalCostUsd = normalized.reduce((sum, m) => sum + m.costUsd, 0);
    const successCount = normalized.filter((m) => !m.error).length;
    const failureCount = normalized.filter((m) => m.error).length;

    const result: TeamExecutionResult = {
      teamId,
      startedAtMs,
      completedAtMs,
      durationMs: completedAtMs - startedAtMs,
      totalCostUsd,
      memberResults: normalized,
      successCount,
      failureCount,
    };

    info(
      "team-coordinator",
      `Team ${teamId} synthesized: ${successCount} success, ${failureCount} failed, cost $${totalCostUsd.toFixed(4)}`
    );

    return result;
  }

  /**
   * Build a system prompt for a team member
   */
  private buildMemberSystemPrompt(type: AgentType, userId?: number): string {
    const role = this.getRoleForType(type);
    return `You are a specialized agent in a parallel task team.

Role: ${role}

You are one of multiple agents working on different aspects of a complex problem. Work independently and thoroughly on your assigned subtask.

Output your findings clearly and structurally. Include any important caveats or limitations.

${userId ? `User ID: ${userId}` : ""}`;
  }

  /**
   * Build member-specific prompt that adds context
   */
  private buildMemberPrompt(
    spec: TeamMemberSpec,
    index: number,
    teamId: string,
    userId?: number
  ): string {
    const systemPrompt = this.buildMemberSystemPrompt(spec.type, userId);
    return `${systemPrompt}\n\n--- Team Member Task ---\n\n${spec.prompt}`;
  }

  /**
   * Get the appropriate model for an agent type
   */
  getModelForType(type: AgentType): string {
    switch (type) {
      case "research":
        return "claude-3-5-sonnet-20241022";
      case "reasoning":
        return "claude-opus-4-1-20250805";
      case "explore":
        return "claude-3-5-sonnet-20241022";
      default:
        return "claude-3-5-haiku-20241022";
    }
  }

  /**
   * Get max turns for an agent type
   */
  getMaxTurnsForType(type: AgentType): number {
    switch (type) {
      case "reasoning":
        return 15;
      case "research":
      case "explore":
      default:
        return 10;
    }
  }

  /**
   * Get max budget for a team member (% of session budget)
   */
  private getMaxBudgetForType(): number {
    const sessionBudget = this.config.claude.maxBudgetUsd;
    const teamBudgetPercent = this.teamConfig.budgetPercent;
    const perMemberBudget = (sessionBudget * teamBudgetPercent) / 100;
    return Math.max(perMemberBudget / this.teamConfig.maxMembers, 0.05); // min $0.05
  }

  /**
   * Get role description for an agent type
   */
  private getRoleForType(type: AgentType): string {
    switch (type) {
      case "research":
        return "Thorough research and analysis. Investigate deeply, cross-reference sources, and provide well-structured findings.";
      case "reasoning":
        return "Advanced reasoning and architecture. Think carefully and provide thorough, well-reasoned analysis.";
      case "explore":
        return "Codebase exploration and pattern discovery. Find relevant files and explain patterns.";
      default:
        return "General assistant. Help solve the assigned task.";
    }
  }
}
