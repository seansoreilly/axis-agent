import fs from "node:fs";
import { info, error as logError } from "./logger.js";
import { metrics } from "./metrics.js";

const COMPONENT = "heartbeat";

export interface HeartbeatOptions {
  filePath: string;
  intervalMs: number;
  onResult?: (result: HeartbeatResult) => void;
  runAgent: (prompt: string) => Promise<{ text: string; isError: boolean; durationMs: number; totalCostUsd: number }>;
}

export interface HeartbeatResult {
  items: string[];
  skipped: boolean;
  response?: string;
  isError: boolean;
  durationMs: number;
  costUsd: number;
  timestamp: string;
}

export class HeartbeatService {
  private opts: HeartbeatOptions;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastResult: HeartbeatResult | null = null;

  constructor(opts: HeartbeatOptions) {
    this.opts = opts;
  }

  start(): void {
    info(COMPONENT, `Starting heartbeat with interval ${this.opts.intervalMs}ms`);
    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.opts.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      info(COMPONENT, "Heartbeat stopped");
    }
  }

  async runOnce(): Promise<HeartbeatResult> {
    let content: string;
    try {
      content = fs.readFileSync(this.opts.filePath, "utf-8") as string;
    } catch (err: unknown) {
      const nodeErr = err as { code?: string };
      if (nodeErr.code === "ENOENT") {
        info(COMPONENT, `Heartbeat file not found: ${this.opts.filePath}`);
      } else {
        logError(COMPONENT, `Failed to read heartbeat file: ${String(err)}`);
      }
      const result: HeartbeatResult = {
        items: [],
        skipped: true,
        isError: false,
        durationMs: 0,
        costUsd: 0,
        timestamp: new Date().toISOString(),
      };
      metrics.increment("heartbeat.skipped");
      this.lastResult = result;
      this.opts.onResult?.(result);
      return result;
    }

    const items = HeartbeatService.parseChecklist(content);

    if (items.length === 0) {
      info(COMPONENT, "No unchecked items found, skipping");
      const result: HeartbeatResult = {
        items: [],
        skipped: true,
        isError: false,
        durationMs: 0,
        costUsd: 0,
        timestamp: new Date().toISOString(),
      };
      metrics.increment("heartbeat.skipped");
      this.lastResult = result;
      this.opts.onResult?.(result);
      return result;
    }

    info(COMPONENT, `Found ${items.length} unchecked item(s), running agent`);
    metrics.increment("heartbeat.runs");

    const prompt = buildPrompt(items);
    const agentResult = await this.opts.runAgent(prompt);

    const result: HeartbeatResult = {
      items,
      skipped: false,
      response: agentResult.text,
      isError: agentResult.isError,
      durationMs: agentResult.durationMs,
      costUsd: agentResult.totalCostUsd,
      timestamp: new Date().toISOString(),
    };

    if (agentResult.isError) {
      metrics.increment("heartbeat.errors");
      logError(COMPONENT, `Agent returned error: ${agentResult.text}`);
    }

    metrics.histogram("heartbeat.cost_usd", agentResult.totalCostUsd);
    this.lastResult = result;
    this.opts.onResult?.(result);
    return result;
  }

  getLastResult(): HeartbeatResult | null {
    return this.lastResult;
  }

  static parseChecklist(content: string): string[] {
    const lines = content.split("\n");
    const items: string[] = [];
    for (const line of lines) {
      const match = line.match(/^-\s+\[\s\]\s+(.+)$/);
      if (match) {
        items.push(match[1].trim());
      }
    }
    return items;
  }
}

function buildPrompt(items: string[]): string {
  const checklist = items.map((item) => `- ${item}`).join("\n");
  return `You are running a periodic heartbeat check. Here are the items to triage and act on:

${checklist}

Instructions:
1. Evaluate each item for urgency
2. Act on any urgent items immediately using available tools
3. For non-urgent items, provide a brief status summary
4. Report back with what you found and any actions taken`;
}
