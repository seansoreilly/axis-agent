import { randomUUID } from "node:crypto";

export interface Checkpoint {
  id: string;
  userId: number;
  sessionId: string;
  prompt: string;
  partialResponse: string;
  toolsUsed: string[];
  createdAt: string;
  status: "paused" | "resumed" | "expired" | "discarded";
  metadata?: Record<string, string>;
}

export interface CheckpointStoreOptions {
  maxCheckpointsPerUser?: number;
  expiryMs?: number;
}

const DEFAULT_MAX_PER_USER = 5;
const DEFAULT_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

export class CheckpointStore {
  private checkpoints: Map<string, Checkpoint>;
  private maxPerUser: number;
  private expiryMs: number;

  constructor(opts?: CheckpointStoreOptions) {
    this.checkpoints = new Map();
    this.maxPerUser = opts?.maxCheckpointsPerUser ?? DEFAULT_MAX_PER_USER;
    this.expiryMs = opts?.expiryMs ?? DEFAULT_EXPIRY_MS;
  }

  save(
    input: Omit<Checkpoint, "id" | "createdAt" | "status">
  ): Checkpoint {
    const checkpoint: Checkpoint = {
      ...input,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      status: "paused",
    };

    this.checkpoints.set(checkpoint.id, checkpoint);
    this.enforceUserLimit(input.userId);

    return checkpoint;
  }

  getLatest(userId: number): Checkpoint | null {
    let latest: Checkpoint | null = null;

    for (const cp of this.checkpoints.values()) {
      if (cp.userId !== userId || cp.status !== "paused") continue;
      if (!latest || cp.createdAt > latest.createdAt) {
        latest = cp;
      }
    }

    return latest;
  }

  get(id: string): Checkpoint | null {
    return this.checkpoints.get(id) ?? null;
  }

  listForUser(userId: number): Checkpoint[] {
    const result: Checkpoint[] = [];
    for (const cp of this.checkpoints.values()) {
      if (cp.userId === userId) {
        result.push(cp);
      }
    }
    return result.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  markResumed(id: string): void {
    const cp = this.checkpoints.get(id);
    if (cp) {
      cp.status = "resumed";
    }
  }

  discard(id: string): void {
    const cp = this.checkpoints.get(id);
    if (cp) {
      cp.status = "discarded";
    }
  }

  pruneExpired(): number {
    const now = Date.now();
    let count = 0;

    for (const cp of this.checkpoints.values()) {
      if (cp.status !== "paused") continue;
      const age = now - new Date(cp.createdAt).getTime();
      if (age > this.expiryMs) {
        cp.status = "expired";
        count++;
      }
    }

    return count;
  }

  getStats(): { total: number; paused: number; resumed: number; expired: number } {
    let paused = 0;
    let resumed = 0;
    let expired = 0;

    for (const cp of this.checkpoints.values()) {
      if (cp.status === "paused") paused++;
      else if (cp.status === "resumed") resumed++;
      else if (cp.status === "expired") expired++;
    }

    return { total: this.checkpoints.size, paused, resumed, expired };
  }

  private enforceUserLimit(userId: number): void {
    const userCheckpoints = this.listForUser(userId);
    if (userCheckpoints.length <= this.maxPerUser) return;

    // Remove oldest until within limit
    const toRemove = userCheckpoints.length - this.maxPerUser;
    for (let i = 0; i < toRemove; i++) {
      this.checkpoints.delete(userCheckpoints[i].id);
    }
  }
}

export function buildResumePrompt(
  checkpoint: Checkpoint,
  newInstruction?: string
): string {
  const toolLine =
    checkpoint.toolsUsed.length > 0
      ? `\nTools used so far: ${checkpoint.toolsUsed.join(", ")}\n`
      : "";

  const actionLine = newInstruction
    ? `New instruction: ${newInstruction}`
    : "Continue from where you left off.";

  return `[Resuming interrupted session]

You were previously working on the following task:
${checkpoint.prompt}

You had made the following progress:
${checkpoint.partialResponse}
${toolLine}
${actionLine}`;
}
