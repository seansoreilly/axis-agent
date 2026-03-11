import { existsSync, mkdirSync } from "node:fs";
import { SqliteStore } from "./persistence.js";

export type FactCategory = "personal" | "work" | "preference" | "system" | "general";

export interface Fact {
  value: string;
  category: FactCategory;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string;
}

export interface SessionRecord {
  sessionId: string;
  userId: number;
  startedAt: string;
  lastActivityAt: string;
  turnCount: number;
  totalCostUsd: number;
  summary?: string;
  lastPrompt: string;
}

const MAX_SESSIONS = 100;
const MAX_CONTEXT_FACTS = 30;
const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Infer a category from a fact key using simple heuristics. */
function inferCategory(key: string): FactCategory {
  const k = key.toLowerCase();
  if (
    k.includes("project") ||
    k.includes("employer") ||
    k.includes("role") ||
    k.includes("repo") ||
    k.includes("stack") ||
    k.includes("work") ||
    k.includes("client")
  ) {
    return "work";
  }
  if (
    k.includes("name") ||
    k.includes("birthday") ||
    k.includes("location") ||
    k.includes("timezone") ||
    k.includes("email") ||
    k.includes("phone") ||
    k.includes("address")
  ) {
    return "personal";
  }
  if (
    k.includes("prefer") ||
    k.includes("style") ||
    k.includes("favorite") ||
    k.includes("language") ||
    k.includes("tool")
  ) {
    return "preference";
  }
  if (
    k.includes("deploy") ||
    k.includes("server") ||
    k.includes("service") ||
    k.includes("config") ||
    k.includes("infra")
  ) {
    return "system";
  }
  return "general";
}

export class Memory {
  private store: SqliteStore;

  constructor(memoryDir: string) {
    if (!existsSync(memoryDir)) {
      mkdirSync(memoryDir, { recursive: true });
    }
    this.store = new SqliteStore(memoryDir);
  }

  setFact(key: string, value: string, category?: FactCategory): void {
    const existing = this.store.getFact(key);
    this.store.upsertFact(
      key,
      value,
      category ?? existing?.category ?? inferCategory(key),
      { createdAt: existing?.createdAt }
    );
  }

  getFact(key: string): string | undefined {
    const fact = this.store.getFact(key);
    if (fact) {
      this.store.touchFact(key);
    }
    return fact?.value;
  }

  getAllFacts(): Record<string, Fact> {
    return this.store.getAllFacts();
  }

  deleteFact(key: string): boolean {
    return this.store.deleteFact(key);
  }

  recordSession(
    sessionId: string,
    userId: number,
    prompt: string,
    opts?: { totalCostUsd?: number; turnCount?: number }
  ): void {
    const existing = this.store.listSessions()
      .find((s) => s.sessionId === sessionId && s.userId === userId);
    const startedAt = existing?.startedAt ?? new Date().toISOString();
    this.store.upsertSession({
      sessionId,
      userId,
      startedAt,
      lastActivityAt: new Date().toISOString(),
      turnCount: opts?.turnCount ?? existing?.turnCount ?? 0,
      totalCostUsd: opts?.totalCostUsd ?? existing?.totalCostUsd ?? 0,
      summary: existing?.summary,
      lastPrompt: prompt.slice(0, 200),
    });
  }

  /** Update a session's summary (e.g., after generating a conversation summary). */
  updateSessionSummary(sessionId: string, summary: string): void {
    this.store.updateSessionSummary(sessionId, summary);
  }

  getLastSession(userId: number): SessionRecord | undefined {
    return this.store.getLastSession(userId, SESSION_MAX_AGE_MS);
  }

  /**
   * Build context string for the system prompt.
   * Sorts facts by recency (updatedAt), caps at MAX_CONTEXT_FACTS.
   * Optionally filters by categories.
   */
  getContext(opts?: { categories?: FactCategory[]; maxFacts?: number }): string {
    const entries = this.store.queryFacts(opts?.categories, opts?.maxFacts ?? MAX_CONTEXT_FACTS);
    if (entries.length === 0) return "";
    return entries.map(([k, f]) => `- ${k}: ${f.value}`).join("\n");
  }

  /** Get the last session summary for a user (for including in next session's prompt). */
  getLastSessionSummary(userId: number): string | undefined {
    return this.store.getLastSessionSummary(userId);
  }

  /** Get memory statistics. */
  getStats(): { totalFacts: number; byCategory: Record<string, number> } {
    const facts = this.store.getAllFacts();
    const byCategory: Record<string, number> = {};
    for (const fact of Object.values(facts)) {
      byCategory[fact.category] = (byCategory[fact.category] ?? 0) + 1;
    }
    return { totalFacts: Object.keys(facts).length, byCategory };
  }
}
