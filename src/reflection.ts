import { appendFileSync } from "node:fs";
import { info, error as logError } from "./logger.js";
import { metrics } from "./metrics.js";

const COMPONENT = "reflection";

export interface ReflectionInput {
  taskPrompt: string;
  taskResponse: string;
  durationMs: number;
  costUsd: number;
  isError: boolean;
  model: string;
  toolsUsed?: string[];
}

export interface ReflectionResult {
  shouldReflect: boolean;
  assessment: "efficient" | "acceptable" | "needs_improvement" | "failed";
  insights: string[];
  suggestedAction?: string;
  timestamp: string;
}

export interface ReflectionServiceOptions {
  reflectAgent: (prompt: string) => Promise<{ text: string; isError: boolean }>;
  onReflection?: (result: ReflectionResult) => void;
  costThresholdUsd?: number;
  durationThresholdMs?: number;
  cooldownMs?: number;
  storePath?: string;
}

type Assessment = ReflectionResult["assessment"];

const VALID_ASSESSMENTS = new Set<Assessment>(["efficient", "acceptable", "needs_improvement", "failed"]);
const DEFAULT_COST_THRESHOLD = 0.10;
const DEFAULT_DURATION_THRESHOLD = 30_000;
const DEFAULT_COOLDOWN = 5 * 60 * 1000;

export class ReflectionService {
  private readonly reflectAgent: ReflectionServiceOptions["reflectAgent"];
  private readonly onReflection: ReflectionServiceOptions["onReflection"];
  private readonly costThreshold: number;
  private readonly durationThreshold: number;
  private readonly cooldownMs: number;
  private readonly storePath: string | undefined;
  private readonly reflections: ReflectionResult[] = [];
  private lastReflectionTime = 0;

  constructor(opts: ReflectionServiceOptions) {
    this.reflectAgent = opts.reflectAgent;
    this.onReflection = opts.onReflection;
    this.costThreshold = opts.costThresholdUsd ?? DEFAULT_COST_THRESHOLD;
    this.durationThreshold = opts.durationThresholdMs ?? DEFAULT_DURATION_THRESHOLD;
    this.cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN;
    this.storePath = opts.storePath;
  }

  async maybeReflect(input: ReflectionInput): Promise<ReflectionResult> {
    const now = Date.now();
    const cooldownPassed = (now - this.lastReflectionTime) >= this.cooldownMs;

    const meetsThreshold =
      input.isError ||
      (cooldownPassed && (input.costUsd > this.costThreshold || input.durationMs > this.durationThreshold));

    if (!meetsThreshold) {
      metrics.increment("reflection.skipped");
      return {
        shouldReflect: false,
        assessment: "acceptable",
        insights: [],
        timestamp: new Date().toISOString(),
      };
    }

    return this.reflect(input);
  }

  async reflect(input: ReflectionInput): Promise<ReflectionResult> {
    const prompt = this.buildPrompt(input);

    let parsed: Pick<ReflectionResult, "assessment" | "insights" | "suggestedAction">;
    try {
      const response = await this.reflectAgent(prompt);
      if (response.isError || !response.text) {
        logError(COMPONENT, `Agent reflection failed or returned empty`);
        parsed = { assessment: "acceptable", insights: [] };
      } else {
        parsed = ReflectionService.parseReflection(response.text);
      }
    } catch (err) {
      logError(COMPONENT, `Reflection agent threw: ${err instanceof Error ? err.message : String(err)}`);
      parsed = { assessment: "acceptable", insights: [] };
    }

    const result: ReflectionResult = {
      shouldReflect: true,
      assessment: parsed.assessment,
      insights: parsed.insights,
      suggestedAction: parsed.suggestedAction,
      timestamp: new Date().toISOString(),
    };

    this.lastReflectionTime = Date.now();
    this.reflections.push(result);

    metrics.increment("reflection.runs");
    metrics.increment("reflection.insights_count", result.insights.length);

    if (this.storePath) {
      try {
        appendFileSync(this.storePath, JSON.stringify(result) + "\n");
      } catch (err) {
        logError(COMPONENT, `Failed to write reflection: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (this.onReflection) {
      this.onReflection(result);
    }

    info(COMPONENT, `Reflection complete: ${result.assessment}, ${result.insights.length} insights`);
    return result;
  }

  static parseReflection(agentResponse: string): Pick<ReflectionResult, "assessment" | "insights" | "suggestedAction"> {
    // Extract assessment
    const assessmentMatch = agentResponse.match(/^ASSESSMENT:\s*(\S+)/m);
    const rawAssessment = assessmentMatch?.[1]?.trim();
    const assessment: Assessment = rawAssessment && VALID_ASSESSMENTS.has(rawAssessment as Assessment)
      ? (rawAssessment as Assessment)
      : "acceptable";

    // Extract insights - lines starting with "- " after INSIGHTS:
    const insights: string[] = [];
    const insightsMatch = agentResponse.match(/^INSIGHTS:\s*\n((?:\s*-\s+.+\n?)+)/m);
    if (insightsMatch) {
      const lines = insightsMatch[1].split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("- ")) {
          insights.push(trimmed.slice(2).trim());
        }
      }
    }

    // Extract action
    const actionMatch = agentResponse.match(/^ACTION:\s*(.+)$/m);
    const suggestedAction = actionMatch?.[1]?.trim();

    return {
      assessment,
      insights,
      suggestedAction: suggestedAction || undefined,
    };
  }

  getRecentReflections(count?: number): ReflectionResult[] {
    if (count === undefined) {
      return [...this.reflections];
    }
    return this.reflections.slice(-count);
  }

  private buildPrompt(input: ReflectionInput): string {
    const toolsList = input.toolsUsed?.length ? input.toolsUsed.join(", ") : "none";
    return `You are reviewing a completed agent task. Evaluate the performance and provide structured feedback.

TASK PROMPT: ${input.taskPrompt}

TASK RESPONSE (truncated): ${input.taskResponse.slice(0, 500)}

METRICS:
- Duration: ${input.durationMs}ms
- Cost: $${input.costUsd.toFixed(4)}
- Model: ${input.model}
- Tools used: ${toolsList}
- Error: ${input.isError ? "yes" : "no"}

Respond with EXACTLY this format:

ASSESSMENT: <one of: efficient, acceptable, needs_improvement, failed>
INSIGHTS:
- <insight 1>
- <insight 2 (optional)>
- <insight 3 (optional)>
ACTION: <concrete suggested action, or "None">`;
  }
}
