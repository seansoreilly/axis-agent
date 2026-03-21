import { appendFile, readFile, readdir, unlink, stat, mkdir } from "node:fs/promises";
import { join } from "node:path";

export interface TranscriptEntry {
  timestamp: string;
  sessionId: string;
  userId: number;
  role: "user" | "assistant";
  content: string;
  metadata?: {
    model?: string;
    durationMs?: number;
    costUsd?: number;
    isError?: boolean;
    toolsUsed?: string[];
  };
}

const VALID_SESSION_ID = /^[a-zA-Z0-9_-]+$/;

function validateSessionId(sessionId: string): void {
  if (!sessionId || !VALID_SESSION_ID.test(sessionId)) {
    throw new Error(`Invalid sessionId: "${sessionId}". Only alphanumeric, hyphens, and underscores are allowed.`);
  }
}

export class TranscriptLogger {
  private dirEnsured = false;

  constructor(private readonly logDir: string) {}

  private sessionPath(sessionId: string): string {
    return join(this.logDir, `${sessionId}.jsonl`);
  }

  private async ensureDir(): Promise<void> {
    if (!this.dirEnsured) {
      await mkdir(this.logDir, { recursive: true });
      this.dirEnsured = true;
    }
  }

  /** Append a transcript entry. File: <logDir>/<sessionId>.jsonl */
  async append(entry: TranscriptEntry): Promise<void> {
    validateSessionId(entry.sessionId);
    await this.ensureDir();
    const line = JSON.stringify(entry) + "\n";
    await appendFile(this.sessionPath(entry.sessionId), line, "utf-8");
  }

  /** Read all entries for a session */
  async read(sessionId: string): Promise<TranscriptEntry[]> {
    validateSessionId(sessionId);
    try {
      const data = await readFile(this.sessionPath(sessionId), "utf-8");
      return data
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as TranscriptEntry);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw err;
    }
  }

  /** List all session IDs that have transcripts */
  async listSessions(): Promise<string[]> {
    try {
      const files = await readdir(this.logDir);
      return files
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => f.slice(0, -".jsonl".length));
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw err;
    }
  }

  /** Search transcripts by content substring (across all sessions) */
  async search(query: string): Promise<TranscriptEntry[]> {
    const sessions = await this.listSessions();
    const lowerQuery = query.toLowerCase();
    const results: TranscriptEntry[] = [];

    for (const sessionId of sessions) {
      const entries = await this.read(sessionId);
      for (const entry of entries) {
        if (entry.content.toLowerCase().includes(lowerQuery)) {
          results.push(entry);
        }
      }
    }

    return results;
  }

  /** Delete transcript for a session */
  async delete(sessionId: string): Promise<boolean> {
    validateSessionId(sessionId);
    try {
      await unlink(this.sessionPath(sessionId));
      return true;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      throw err;
    }
  }

  /** Get total size of all transcript files in bytes */
  async totalSize(): Promise<number> {
    const sessions = await this.listSessions();
    let total = 0;

    for (const sessionId of sessions) {
      const fileStat = await stat(this.sessionPath(sessionId));
      total += fileStat.size;
    }

    return total;
  }
}
