import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

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

interface MemoryStore {
  facts: Record<string, Fact>;
  sessions: SessionRecord[];
}

// Legacy format for migration
interface LegacyMemoryStore {
  facts: Record<string, string | Fact>;
  sessions: Array<SessionRecord | LegacySessionRecord>;
}

interface LegacySessionRecord {
  sessionId: string;
  userId: number;
  startedAt: string;
  lastPrompt: string;
}

const MAX_SESSIONS = 100;
const MAX_CONTEXT_FACTS = 30;
const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Infer a category from a fact key using simple heuristics. */
function inferCategory(key: string): FactCategory {
  const k = key.toLowerCase();
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

function isStructuredFact(v: unknown): v is Fact {
  return typeof v === "object" && v !== null && "value" in v && "category" in v;
}

function migrateFact(key: string, raw: string | Fact): Fact {
  if (isStructuredFact(raw)) return raw;
  const now = new Date().toISOString();
  return {
    value: raw as string,
    category: inferCategory(key),
    createdAt: now,
    updatedAt: now,
    lastAccessedAt: now,
  };
}

function migrateSession(raw: SessionRecord | LegacySessionRecord): SessionRecord {
  if ("lastActivityAt" in raw) return raw as SessionRecord;
  return {
    sessionId: raw.sessionId,
    userId: raw.userId,
    startedAt: raw.startedAt,
    lastActivityAt: raw.startedAt,
    turnCount: 0,
    totalCostUsd: 0,
    lastPrompt: raw.lastPrompt,
  };
}

export class Memory {
  private storePath: string;
  private data: MemoryStore;

  constructor(memoryDir: string) {
    if (!existsSync(memoryDir)) {
      mkdirSync(memoryDir, { recursive: true });
    }
    this.storePath = join(memoryDir, "store.json");
    this.data = this.load();
  }

  private load(): MemoryStore {
    if (existsSync(this.storePath)) {
      const raw = readFileSync(this.storePath, "utf-8");
      const parsed = JSON.parse(raw) as LegacyMemoryStore;

      // Migrate facts from legacy string format to structured Fact
      const facts: Record<string, Fact> = {};
      for (const [key, val] of Object.entries(parsed.facts)) {
        facts[key] = migrateFact(key, val);
      }

      // Migrate sessions from legacy format
      const sessions = (parsed.sessions ?? []).map(migrateSession);

      const migrated: MemoryStore = { facts, sessions };

      // Write back migrated data if we changed anything
      const needsMigration = Object.values(parsed.facts).some(
        (v) => typeof v === "string"
      ) || (parsed.sessions ?? []).some((s) => !("lastActivityAt" in s));

      if (needsMigration) {
        writeFileSync(this.storePath, JSON.stringify(migrated, null, 2));
      }

      return migrated;
    }
    return { facts: {}, sessions: [] };
  }

  private save(): void {
    writeFileSync(this.storePath, JSON.stringify(this.data, null, 2));
  }

  setFact(key: string, value: string, category?: FactCategory): void {
    const now = new Date().toISOString();
    const existing = this.data.facts[key];
    this.data.facts[key] = {
      value,
      category: category ?? existing?.category ?? inferCategory(key),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastAccessedAt: now,
    };
    this.save();
  }

  getFact(key: string): string | undefined {
    const fact = this.data.facts[key];
    if (fact) {
      fact.lastAccessedAt = new Date().toISOString();
      // Don't save on every read to avoid excessive I/O — batch via setFact/save
    }
    return fact?.value;
  }

  getAllFacts(): Record<string, Fact> {
    return { ...this.data.facts };
  }

  deleteFact(key: string): boolean {
    if (key in this.data.facts) {
      delete this.data.facts[key];
      this.save();
      return true;
    }
    return false;
  }

  recordSession(
    sessionId: string,
    userId: number,
    prompt: string,
    opts?: { totalCostUsd?: number; turnCount?: number }
  ): void {
    // Update existing session if same sessionId, otherwise create new
    const existing = this.data.sessions.find(
      (s) => s.sessionId === sessionId && s.userId === userId
    );

    if (existing) {
      existing.lastActivityAt = new Date().toISOString();
      existing.lastPrompt = prompt.slice(0, 200);
      if (opts?.totalCostUsd !== undefined) existing.totalCostUsd = opts.totalCostUsd;
      if (opts?.turnCount !== undefined) existing.turnCount = opts.turnCount;
    } else {
      this.data.sessions.push({
        sessionId,
        userId,
        startedAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
        turnCount: opts?.turnCount ?? 0,
        totalCostUsd: opts?.totalCostUsd ?? 0,
        lastPrompt: prompt.slice(0, 200),
      });
    }

    // Keep only the most recent sessions
    if (this.data.sessions.length > MAX_SESSIONS) {
      this.data.sessions = this.data.sessions.slice(-MAX_SESSIONS);
    }

    this.save();
  }

  /** Update a session's summary (e.g., after generating a conversation summary). */
  updateSessionSummary(sessionId: string, summary: string): void {
    const session = [...this.data.sessions]
      .reverse()
      .find((s) => s.sessionId === sessionId);
    if (session) {
      session.summary = summary;
      this.save();
    }
  }

  getLastSession(userId: number): SessionRecord | undefined {
    const now = Date.now();
    return [...this.data.sessions]
      .reverse()
      .find((s) => {
        if (s.userId !== userId) return false;
        // Skip sessions older than 24 hours — they're likely stale
        const age = now - new Date(s.lastActivityAt).getTime();
        return age < SESSION_MAX_AGE_MS;
      });
  }

  /**
   * Build context string for the system prompt.
   * Sorts facts by recency (updatedAt), caps at MAX_CONTEXT_FACTS.
   * Optionally filters by categories.
   */
  getContext(opts?: { categories?: FactCategory[]; maxFacts?: number }): string {
    const entries = Object.entries(this.data.facts);
    if (entries.length === 0) return "";

    let filtered = entries;
    if (opts?.categories) {
      const cats = new Set(opts.categories);
      filtered = filtered.filter(([, f]) => cats.has(f.category));
    }

    // Sort by updatedAt descending (most recent first)
    filtered.sort(
      ([, a], [, b]) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );

    // Cap the number of facts
    const limit = opts?.maxFacts ?? MAX_CONTEXT_FACTS;
    const capped = filtered.slice(0, limit);

    return capped.map(([k, f]) => `- ${k}: ${f.value}`).join("\n");
  }

  /** Get the last session summary for a user (for including in next session's prompt). */
  getLastSessionSummary(userId: number): string | undefined {
    return [...this.data.sessions]
      .reverse()
      .find((s) => s.userId === userId && s.summary)?.summary;
  }

  /** Get memory statistics. */
  getStats(): { totalFacts: number; byCategory: Record<string, number> } {
    const byCategory: Record<string, number> = {};
    for (const fact of Object.values(this.data.facts)) {
      byCategory[fact.category] = (byCategory[fact.category] ?? 0) + 1;
    }
    return { totalFacts: Object.keys(this.data.facts).length, byCategory };
  }
}
