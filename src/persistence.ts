import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Fact, FactCategory, SessionRecord } from "./memory.js";
import type { ScheduledTask } from "./scheduler.js";

export interface JobRecord {
  id: string;
  type: string;
  status: string;
  payloadJson: string;
  resultText?: string;
  errorText?: string;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
  runAfter: string;
  startedAt?: string;
  finishedAt?: string;
}

interface LegacyMemoryStore {
  facts: Record<string, string | Fact>;
  sessions: Array<SessionRecord | { sessionId: string; userId: number; startedAt: string; lastPrompt: string }>;
}

function nowIso(): string {
  return new Date().toISOString();
}

export class SqliteStore {
  private db: DatabaseSync;

  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(join(dir, "agent.db"));
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.createTables();
    this.migrateLegacyFiles();
  }

  private createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS facts (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        category TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_accessed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT NOT NULL,
        user_id INTEGER NOT NULL,
        started_at TEXT NOT NULL,
        last_activity_at TEXT NOT NULL,
        turn_count INTEGER NOT NULL DEFAULT 0,
        total_cost_usd REAL NOT NULL DEFAULT 0,
        summary TEXT,
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

  private migrateLegacyFiles(): void {
    const factCount = this.db.prepare("SELECT COUNT(*) as count FROM facts").get() as { count: number };
    const sessionCount = this.db.prepare("SELECT COUNT(*) as count FROM sessions").get() as { count: number };
    const taskCount = this.db.prepare("SELECT COUNT(*) as count FROM scheduled_tasks").get() as { count: number };

    const memoryPath = join(this.dir, "store.json");
    if ((factCount.count === 0 || sessionCount.count === 0) && existsSync(memoryPath)) {
      const parsed = JSON.parse(readFileSync(memoryPath, "utf-8")) as LegacyMemoryStore;
      for (const [key, raw] of Object.entries(parsed.facts ?? {})) {
        const structured = typeof raw === "string"
          ? {
              value: raw,
              category: inferCategory(key),
              createdAt: nowIso(),
              updatedAt: nowIso(),
              lastAccessedAt: nowIso(),
            }
          : raw;

        this.upsertFact(key, structured.value, structured.category, {
          createdAt: structured.createdAt,
          updatedAt: structured.updatedAt,
          lastAccessedAt: structured.lastAccessedAt,
        });
      }

      for (const session of parsed.sessions ?? []) {
        if ("lastActivityAt" in session) {
          this.upsertSession(session);
        } else {
          this.upsertSession({
            sessionId: session.sessionId,
            userId: session.userId,
            startedAt: session.startedAt,
            lastActivityAt: session.startedAt,
            turnCount: 0,
            totalCostUsd: 0,
            lastPrompt: session.lastPrompt,
          });
        }
      }

      rmSync(memoryPath, { force: true });
    }

    const tasksPath = join(this.dir, "tasks.json");
    if (taskCount.count === 0 && existsSync(tasksPath)) {
      const tasks = JSON.parse(readFileSync(tasksPath, "utf-8")) as ScheduledTask[];
      for (const task of tasks) {
        this.upsertTask(task);
      }
      rmSync(tasksPath, { force: true });
    }
  }

  upsertFact(
    key: string,
    value: string,
    category: FactCategory,
    timestamps?: { createdAt?: string; updatedAt?: string; lastAccessedAt?: string }
  ): void {
    const now = nowIso();
    this.db.prepare(`
      INSERT INTO facts (key, value, category, created_at, updated_at, last_accessed_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        category = excluded.category,
        updated_at = excluded.updated_at,
        last_accessed_at = excluded.last_accessed_at
    `).run(
      key,
      value,
      category,
      timestamps?.createdAt ?? now,
      timestamps?.updatedAt ?? now,
      timestamps?.lastAccessedAt ?? now
    );
  }

  touchFact(key: string): void {
    this.db.prepare("UPDATE facts SET last_accessed_at = ? WHERE key = ?").run(nowIso(), key);
  }

  getFact(key: string): Fact | undefined {
    const row = this.db.prepare("SELECT * FROM facts WHERE key = ?").get(key) as Record<string, string> | undefined;
    if (!row) return undefined;
    return mapFactRow(row);
  }

  getAllFacts(): Record<string, Fact> {
    const rows = this.db.prepare("SELECT * FROM facts").all() as Record<string, string>[];
    return Object.fromEntries(rows.map((row) => [row["key"], mapFactRow(row)]));
  }

  deleteFact(key: string): boolean {
    const result = this.db.prepare("DELETE FROM facts WHERE key = ?").run(key);
    return result.changes > 0;
  }

  queryFacts(categories?: FactCategory[], limit = 30): Array<[string, Fact]> {
    const params: Array<string | number> = [];
    let sql = "SELECT * FROM facts";
    if (categories && categories.length > 0) {
      sql += ` WHERE category IN (${categories.map(() => "?").join(",")})`;
      params.push(...categories);
    }
    sql += " ORDER BY updated_at DESC LIMIT ?";
    params.push(limit);
    const rows = this.db.prepare(sql).all(...params) as Record<string, string>[];
    return rows.map((row) => [row["key"], mapFactRow(row)]);
  }

  upsertSession(session: SessionRecord): void {
    this.db.prepare(`
      INSERT INTO sessions (session_id, user_id, started_at, last_activity_at, turn_count, total_cost_usd, summary, last_prompt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, user_id) DO UPDATE SET
        last_activity_at = excluded.last_activity_at,
        turn_count = excluded.turn_count,
        total_cost_usd = excluded.total_cost_usd,
        summary = COALESCE(excluded.summary, sessions.summary),
        last_prompt = excluded.last_prompt
    `).run(
      session.sessionId,
      session.userId,
      session.startedAt,
      session.lastActivityAt,
      session.turnCount,
      session.totalCostUsd,
      session.summary ?? null,
      session.lastPrompt
    );
  }

  updateSessionSummary(sessionId: string, summary: string): void {
    this.db.prepare("UPDATE sessions SET summary = ?, last_activity_at = ? WHERE session_id = ?")
      .run(summary, nowIso(), sessionId);
  }

  listSessions(): SessionRecord[] {
    const rows = this.db.prepare("SELECT * FROM sessions ORDER BY last_activity_at DESC LIMIT 100").all() as Array<Record<string, string | number | null>>;
    return rows.map(mapSessionRow);
  }

  getLastSession(userId: number, maxAgeMs: number): SessionRecord | undefined {
    const rows = this.db.prepare(
      "SELECT * FROM sessions WHERE user_id = ? ORDER BY last_activity_at DESC LIMIT 20"
    ).all(userId) as Array<Record<string, string | number | null>>;
    const cutoff = Date.now() - maxAgeMs;
    return rows
      .map(mapSessionRow)
      .find((session) => new Date(session.lastActivityAt).getTime() >= cutoff);
  }

  getLastSessionSummary(userId: number): string | undefined {
    const row = this.db.prepare(
      "SELECT summary FROM sessions WHERE user_id = ? AND summary IS NOT NULL ORDER BY last_activity_at DESC LIMIT 1"
    ).get(userId) as { summary?: string } | undefined;
    return row?.summary;
  }

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

  insertJob(job: JobRecord): void {
    this.db.prepare(`
      INSERT INTO jobs (id, type, status, payload_json, result_text, error_text, attempts, max_attempts, created_at, updated_at, run_after, started_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      job.id,
      job.type,
      job.status,
      job.payloadJson,
      job.resultText ?? null,
      job.errorText ?? null,
      job.attempts,
      job.maxAttempts,
      job.createdAt,
      job.updatedAt,
      job.runAfter,
      job.startedAt ?? null,
      job.finishedAt ?? null
    );
  }

  updateJob(job: JobRecord): void {
    this.db.prepare(`
      UPDATE jobs SET
        status = ?,
        payload_json = ?,
        result_text = ?,
        error_text = ?,
        attempts = ?,
        max_attempts = ?,
        updated_at = ?,
        run_after = ?,
        started_at = ?,
        finished_at = ?
      WHERE id = ?
    `).run(
      job.status,
      job.payloadJson,
      job.resultText ?? null,
      job.errorText ?? null,
      job.attempts,
      job.maxAttempts,
      job.updatedAt,
      job.runAfter,
      job.startedAt ?? null,
      job.finishedAt ?? null,
      job.id
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

  getRunnableJobs(limit = 10): JobRecord[] {
    const rows = this.db.prepare(
      "SELECT * FROM jobs WHERE status = 'queued' AND run_after <= ? ORDER BY created_at ASC LIMIT ?"
    ).all(nowIso(), limit) as Array<Record<string, string | number | null>>;
    return rows.map(mapJobRow);
  }

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

function mapFactRow(row: Record<string, string>): Fact {
  return {
    value: row["value"],
    category: row["category"] as FactCategory,
    createdAt: row["created_at"],
    updatedAt: row["updated_at"],
    lastAccessedAt: row["last_accessed_at"],
  };
}

function mapSessionRow(row: Record<string, string | number | null>): SessionRecord {
  return {
    sessionId: String(row["session_id"]),
    userId: Number(row["user_id"]),
    startedAt: String(row["started_at"]),
    lastActivityAt: String(row["last_activity_at"]),
    turnCount: Number(row["turn_count"]),
    totalCostUsd: Number(row["total_cost_usd"]),
    summary: row["summary"] ? String(row["summary"]) : undefined,
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

export function exportLegacyJson(dir: string): void {
  const store = new SqliteStore(dir);
  const facts = store.getAllFacts();
  const sessions = store.listSessions();
  writeFileSync(join(dir, "store.json"), JSON.stringify({ facts, sessions }, null, 2));
}
