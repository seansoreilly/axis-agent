import { existsSync, mkdirSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ScheduledTask } from "./scheduler.js";

export interface SessionRecord {
  sessionId: string;
  userId: number;
  startedAt: string;
  lastActivityAt: string;
  turnCount: number;
  totalCostUsd: number;
  lastPrompt: string;
}

export interface JobRecord {
  id: string;
  type: string;
  status: string;
  payloadJson: string;
  resultText?: string;
  resultSessionId?: string;
  errorText?: string;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
  runAfter: string;
  startedAt?: string;
  finishedAt?: string;
}

const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

function nowIso(): string {
  return new Date().toISOString();
}

interface LegacySession {
  sessionId: string;
  userId: number;
  startedAt: string;
  lastActivityAt?: string;
  lastPrompt: string;
  turnCount?: number;
  totalCostUsd?: number;
}

export class SqliteStore {
  private db: DatabaseSync;

  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const dbPath = join(dir, "agent.db");
    this.db = new DatabaseSync(dbPath);
    try { chmodSync(dbPath, 0o600); } catch { /* may not exist yet */ }
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.createTables();
    this.migrateSchema();
    try { chmodSync(dbPath, 0o600); } catch { /* best-effort */ }
    this.migrateLegacyFiles();
  }

  private createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT NOT NULL,
        user_id INTEGER NOT NULL,
        started_at TEXT NOT NULL,
        last_activity_at TEXT NOT NULL,
        turn_count INTEGER NOT NULL DEFAULT 0,
        total_cost_usd REAL NOT NULL DEFAULT 0,
        last_prompt TEXT NOT NULL,
        PRIMARY KEY (session_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS scheduled_tasks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        schedule TEXT NOT NULL,
        prompt TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        check_command TEXT
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        result_text TEXT,
        result_session_id TEXT,
        error_text TEXT,
        attempts INTEGER NOT NULL,
        max_attempts INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        run_after TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        details_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  private migrateSchema(): void {
    // Drop legacy facts table if present (no longer used)
    this.db.exec("DROP TABLE IF EXISTS facts");
    // Drop legacy summary column from sessions if present
    try {
      this.db.exec("ALTER TABLE sessions DROP COLUMN summary");
    } catch { /* column may not exist */ }
  }

  private migrateLegacyFiles(): void {
    const sessionCount = this.db.prepare("SELECT COUNT(*) as count FROM sessions").get() as { count: number };
    const taskCount = this.db.prepare("SELECT COUNT(*) as count FROM scheduled_tasks").get() as { count: number };

    // Migrate legacy store.json (sessions only — facts are dropped)
    const memoryPath = join(this.dir, "store.json");
    if (sessionCount.count === 0 && existsSync(memoryPath)) {
      try {
        const parsed = JSON.parse(readFileSync(memoryPath, "utf-8")) as { sessions?: LegacySession[] };
        for (const session of parsed.sessions ?? []) {
          this.upsertSession({
            sessionId: session.sessionId,
            userId: session.userId,
            startedAt: session.startedAt,
            lastActivityAt: session.lastActivityAt ?? session.startedAt,
            turnCount: session.turnCount ?? 0,
            totalCostUsd: session.totalCostUsd ?? 0,
            lastPrompt: session.lastPrompt,
          });
        }
      } catch { /* corrupt file — skip */ }
      rmSync(memoryPath, { force: true });
    }

    // Migrate legacy tasks.json
    const tasksPath = join(this.dir, "tasks.json");
    if (taskCount.count === 0 && existsSync(tasksPath)) {
      try {
        const tasks = JSON.parse(readFileSync(tasksPath, "utf-8")) as ScheduledTask[];
        for (const task of tasks) {
          this.upsertTask(task);
        }
      } catch { /* corrupt file — skip */ }
      rmSync(tasksPath, { force: true });
    }
  }

  // --- Sessions ---

  recordSession(
    sessionId: string,
    userId: number,
    prompt: string,
    opts?: { totalCostUsd?: number; turnCount?: number }
  ): void {
    const existing = this.listSessions().find((s) => s.sessionId === sessionId && s.userId === userId);
    this.upsertSession({
      sessionId,
      userId,
      startedAt: existing?.startedAt ?? nowIso(),
      lastActivityAt: nowIso(),
      turnCount: opts?.turnCount ?? existing?.turnCount ?? 0,
      totalCostUsd: opts?.totalCostUsd ?? existing?.totalCostUsd ?? 0,
      lastPrompt: prompt.slice(0, 200),
    });
  }

  getRecentSession(userId: number): SessionRecord | undefined {
    return this.getLastSession(userId, SESSION_MAX_AGE_MS);
  }

  upsertSession(session: SessionRecord): void {
    this.db.prepare(`
      INSERT INTO sessions (session_id, user_id, started_at, last_activity_at, turn_count, total_cost_usd, last_prompt)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, user_id) DO UPDATE SET
        last_activity_at = excluded.last_activity_at,
        turn_count = excluded.turn_count,
        total_cost_usd = excluded.total_cost_usd,
        last_prompt = excluded.last_prompt
    `).run(
      session.sessionId,
      session.userId,
      session.startedAt,
      session.lastActivityAt,
      session.turnCount,
      session.totalCostUsd,
      session.lastPrompt
    );
  }

  listSessions(): SessionRecord[] {
    const rows = this.db.prepare("SELECT * FROM sessions ORDER BY last_activity_at DESC LIMIT 100").all() as Array<Record<string, string | number | null>>;
    return rows.map(mapSessionRow);
  }

  getLastSession(userId: number, maxAgeMs: number): SessionRecord | undefined {
    const rows = this.db.prepare(
      "SELECT * FROM sessions WHERE user_id = ? ORDER BY last_activity_at DESC, rowid DESC LIMIT 20"
    ).all(userId) as Array<Record<string, string | number | null>>;
    const cutoff = Date.now() - maxAgeMs;
    return rows.map(mapSessionRow).find((s) => new Date(s.lastActivityAt).getTime() >= cutoff);
  }

  // --- Tasks ---

  upsertTask(task: ScheduledTask): void {
    this.db.prepare(`
      INSERT INTO scheduled_tasks (id, name, schedule, prompt, enabled, check_command)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        schedule = excluded.schedule,
        prompt = excluded.prompt,
        enabled = excluded.enabled,
        check_command = excluded.check_command
    `).run(task.id, task.name, task.schedule, task.prompt, task.enabled ? 1 : 0, task.checkCommand ?? null);
  }

  deleteTask(id: string): boolean {
    const result = this.db.prepare("DELETE FROM scheduled_tasks WHERE id = ?").run(id);
    return result.changes > 0;
  }

  listTasks(): ScheduledTask[] {
    const rows = this.db.prepare("SELECT * FROM scheduled_tasks ORDER BY id").all() as Array<Record<string, string | number | null>>;
    return rows.map((row) => ({
      id: String(row["id"]),
      name: String(row["name"]),
      schedule: String(row["schedule"]),
      prompt: String(row["prompt"]),
      enabled: Number(row["enabled"]) === 1,
      checkCommand: row["check_command"] ? String(row["check_command"]) : undefined,
    }));
  }

  // --- Jobs ---

  insertJob(job: JobRecord): void {
    this.db.prepare(`
      INSERT INTO jobs (id, type, status, payload_json, result_text, result_session_id, error_text, attempts, max_attempts, created_at, updated_at, run_after, started_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      job.id, job.type, job.status, job.payloadJson,
      job.resultText ?? null, job.resultSessionId ?? null, job.errorText ?? null,
      job.attempts, job.maxAttempts, job.createdAt, job.updatedAt, job.runAfter,
      job.startedAt ?? null, job.finishedAt ?? null
    );
  }

  updateJob(job: JobRecord): void {
    this.db.prepare(`
      UPDATE jobs SET
        status = ?, payload_json = ?, result_text = ?, result_session_id = ?,
        error_text = ?, attempts = ?, max_attempts = ?, updated_at = ?,
        run_after = ?, started_at = ?, finished_at = ?
      WHERE id = ?
    `).run(
      job.status, job.payloadJson, job.resultText ?? null, job.resultSessionId ?? null,
      job.errorText ?? null, job.attempts, job.maxAttempts, job.updatedAt,
      job.runAfter, job.startedAt ?? null, job.finishedAt ?? null, job.id
    );
  }

  getJob(id: string): JobRecord | undefined {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Record<string, string | number | null> | undefined;
    return row ? mapJobRow(row) : undefined;
  }

  listJobs(limit = 50): JobRecord[] {
    const rows = this.db.prepare("SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?").all(limit) as Array<Record<string, string | number | null>>;
    return rows.map(mapJobRow);
  }

  getStuckJobs(olderThan: string): JobRecord[] {
    const rows = this.db.prepare(
      "SELECT * FROM jobs WHERE status = 'running' AND started_at < ?"
    ).all(olderThan) as Array<Record<string, string | number | null>>;
    return rows.map(mapJobRow);
  }

  getRunnableJobs(limit = 10): JobRecord[] {
    const rows = this.db.prepare(
      "SELECT * FROM jobs WHERE status = 'queued' AND run_after <= ? ORDER BY created_at ASC LIMIT ?"
    ).all(nowIso(), limit) as Array<Record<string, string | number | null>>;
    return rows.map(mapJobRow);
  }

  // --- Events ---

  addEvent(eventType: string, details: Record<string, unknown>): void {
    this.db.prepare("INSERT INTO events (event_type, details_json, created_at) VALUES (?, ?, ?)")
      .run(eventType, JSON.stringify(details), nowIso());
  }

  listEvents(limit = 100): Array<{ id: number; eventType: string; details: Record<string, unknown>; createdAt: string }> {
    const rows = this.db.prepare("SELECT * FROM events ORDER BY id DESC LIMIT ?").all(limit) as Array<Record<string, string | number>>;
    return rows.map((row) => ({
      id: Number(row["id"]),
      eventType: String(row["event_type"]),
      details: JSON.parse(String(row["details_json"])) as Record<string, unknown>,
      createdAt: String(row["created_at"]),
    }));
  }
}

function mapSessionRow(row: Record<string, string | number | null>): SessionRecord {
  return {
    sessionId: String(row["session_id"]),
    userId: Number(row["user_id"]),
    startedAt: String(row["started_at"]),
    lastActivityAt: String(row["last_activity_at"]),
    turnCount: Number(row["turn_count"]),
    totalCostUsd: Number(row["total_cost_usd"]),
    lastPrompt: String(row["last_prompt"]),
  };
}

function mapJobRow(row: Record<string, string | number | null>): JobRecord {
  return {
    id: String(row["id"]),
    type: String(row["type"]),
    status: String(row["status"]),
    payloadJson: String(row["payload_json"]),
    resultText: row["result_text"] ? String(row["result_text"]) : undefined,
    resultSessionId: row["result_session_id"] ? String(row["result_session_id"]) : undefined,
    errorText: row["error_text"] ? String(row["error_text"]) : undefined,
    attempts: Number(row["attempts"]),
    maxAttempts: Number(row["max_attempts"]),
    createdAt: String(row["created_at"]),
    updatedAt: String(row["updated_at"]),
    runAfter: String(row["run_after"]),
    startedAt: row["started_at"] ? String(row["started_at"]) : undefined,
    finishedAt: row["finished_at"] ? String(row["finished_at"]) : undefined,
  };
}
