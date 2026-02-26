import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

interface MemoryStore {
  facts: Record<string, string>;
  sessions: SessionRecord[];
}

interface SessionRecord {
  sessionId: string;
  userId: number;
  startedAt: string;
  lastPrompt: string;
}

const MAX_SESSIONS = 100;

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
      return JSON.parse(raw) as MemoryStore;
    }
    return { facts: {}, sessions: [] };
  }

  private save(): void {
    writeFileSync(this.storePath, JSON.stringify(this.data, null, 2));
  }

  setFact(key: string, value: string): void {
    this.data.facts[key] = value;
    this.save();
  }

  getFact(key: string): string | undefined {
    return this.data.facts[key];
  }

  getAllFacts(): Record<string, string> {
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

  recordSession(sessionId: string, userId: number, prompt: string): void {
    this.data.sessions.push({
      sessionId,
      userId,
      startedAt: new Date().toISOString(),
      lastPrompt: prompt.slice(0, 200),
    });

    // Keep only the most recent sessions
    if (this.data.sessions.length > MAX_SESSIONS) {
      this.data.sessions = this.data.sessions.slice(-MAX_SESSIONS);
    }

    this.save();
  }

  getLastSession(userId: number): SessionRecord | undefined {
    return [...this.data.sessions]
      .reverse()
      .find((s) => s.userId === userId);
  }

  getContext(): string {
    const facts = this.getAllFacts();
    const entries = Object.entries(facts);
    if (entries.length === 0) return "";

    return entries.map(([k, v]) => `- ${k}: ${v}`).join("\n");
  }
}
