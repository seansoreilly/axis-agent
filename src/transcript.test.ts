import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TranscriptLogger, type TranscriptEntry } from "./transcript.js";

function makeEntry(overrides: Partial<TranscriptEntry> = {}): TranscriptEntry {
  return {
    timestamp: new Date().toISOString(),
    sessionId: "session-abc-123",
    userId: 42,
    role: "user",
    content: "Hello world",
    ...overrides,
  };
}

describe("TranscriptLogger", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `transcript-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("append()", () => {
    it("creates file and writes entry", async () => {
      const logger = new TranscriptLogger(tmpDir);
      const entry = makeEntry();
      await logger.append(entry);

      const filePath = join(tmpDir, "session-abc-123.jsonl");
      const raw = readFileSync(filePath, "utf-8");
      expect(raw.trim()).not.toBe("");
      const parsed = JSON.parse(raw.trim());
      expect(parsed.content).toBe("Hello world");
      expect(parsed.sessionId).toBe("session-abc-123");
    });

    it("appends multiple entries to same session", async () => {
      const logger = new TranscriptLogger(tmpDir);
      await logger.append(makeEntry({ content: "first" }));
      await logger.append(makeEntry({ content: "second" }));
      await logger.append(makeEntry({ content: "third" }));

      const filePath = join(tmpDir, "session-abc-123.jsonl");
      const lines = readFileSync(filePath, "utf-8").trim().split("\n");
      expect(lines).toHaveLength(3);
      expect(JSON.parse(lines[0]).content).toBe("first");
      expect(JSON.parse(lines[1]).content).toBe("second");
      expect(JSON.parse(lines[2]).content).toBe("third");
    });

    it("creates logDir if missing", async () => {
      const nestedDir = join(tmpDir, "nested", "deep", "dir");
      const logger = new TranscriptLogger(nestedDir);
      await logger.append(makeEntry());

      const filePath = join(nestedDir, "session-abc-123.jsonl");
      const raw = readFileSync(filePath, "utf-8");
      expect(JSON.parse(raw.trim()).content).toBe("Hello world");
    });

    it("writes valid JSON per line", async () => {
      const logger = new TranscriptLogger(tmpDir);
      await logger.append(makeEntry({ content: "line one" }));
      await logger.append(makeEntry({ content: "line two" }));

      const filePath = join(tmpDir, "session-abc-123.jsonl");
      const lines = readFileSync(filePath, "utf-8").trim().split("\n");
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    });
  });

  describe("read()", () => {
    it("returns entries in order", async () => {
      const logger = new TranscriptLogger(tmpDir);
      await logger.append(makeEntry({ content: "first" }));
      await logger.append(makeEntry({ content: "second" }));

      const entries = await logger.read("session-abc-123");
      expect(entries).toHaveLength(2);
      expect(entries[0].content).toBe("first");
      expect(entries[1].content).toBe("second");
    });

    it("returns empty array for nonexistent session", async () => {
      const logger = new TranscriptLogger(tmpDir);
      const entries = await logger.read("nonexistent");
      expect(entries).toEqual([]);
    });

    it("handles metadata fields correctly", async () => {
      const logger = new TranscriptLogger(tmpDir);
      const entry = makeEntry({
        role: "assistant",
        content: "response",
        metadata: {
          model: "claude-opus-4-6",
          durationMs: 1500,
          costUsd: 0.05,
          isError: false,
          toolsUsed: ["Read", "Write"],
        },
      });
      await logger.append(entry);

      const entries = await logger.read("session-abc-123");
      expect(entries).toHaveLength(1);
      expect(entries[0].metadata?.model).toBe("claude-opus-4-6");
      expect(entries[0].metadata?.durationMs).toBe(1500);
      expect(entries[0].metadata?.costUsd).toBe(0.05);
      expect(entries[0].metadata?.isError).toBe(false);
      expect(entries[0].metadata?.toolsUsed).toEqual(["Read", "Write"]);
    });
  });

  describe("listSessions()", () => {
    it("returns session IDs", async () => {
      const logger = new TranscriptLogger(tmpDir);
      await logger.append(makeEntry({ sessionId: "session-1" }));
      await logger.append(makeEntry({ sessionId: "session-2" }));
      await logger.append(makeEntry({ sessionId: "session-3" }));

      const sessions = await logger.listSessions();
      expect(sessions.sort()).toEqual(["session-1", "session-2", "session-3"]);
    });

    it("returns empty array for empty directory", async () => {
      const logger = new TranscriptLogger(tmpDir);
      const sessions = await logger.listSessions();
      expect(sessions).toEqual([]);
    });
  });

  describe("search()", () => {
    it("finds matching entries across sessions", async () => {
      const logger = new TranscriptLogger(tmpDir);
      await logger.append(makeEntry({ sessionId: "s1", content: "deploy the app" }));
      await logger.append(makeEntry({ sessionId: "s1", content: "ok done" }));
      await logger.append(makeEntry({ sessionId: "s2", content: "deploy to production" }));
      await logger.append(makeEntry({ sessionId: "s2", content: "nothing here" }));

      const results = await logger.search("deploy");
      expect(results).toHaveLength(2);
      expect(results.map((r) => r.content).sort()).toEqual([
        "deploy the app",
        "deploy to production",
      ]);
    });

    it("performs case-insensitive search", async () => {
      const logger = new TranscriptLogger(tmpDir);
      await logger.append(makeEntry({ sessionId: "s1", content: "Hello World" }));
      await logger.append(makeEntry({ sessionId: "s2", content: "hello world" }));
      await logger.append(makeEntry({ sessionId: "s3", content: "HELLO WORLD" }));

      const results = await logger.search("hello world");
      expect(results).toHaveLength(3);
    });

    it("returns empty for no matches", async () => {
      const logger = new TranscriptLogger(tmpDir);
      await logger.append(makeEntry({ content: "nothing relevant" }));

      const results = await logger.search("xyzzy");
      expect(results).toEqual([]);
    });
  });

  describe("delete()", () => {
    it("removes transcript file", async () => {
      const logger = new TranscriptLogger(tmpDir);
      await logger.append(makeEntry({ sessionId: "to-delete" }));

      const result = await logger.delete("to-delete");
      expect(result).toBe(true);

      const entries = await logger.read("to-delete");
      expect(entries).toEqual([]);
    });

    it("returns false for nonexistent session", async () => {
      const logger = new TranscriptLogger(tmpDir);
      const result = await logger.delete("nonexistent");
      expect(result).toBe(false);
    });
  });

  describe("totalSize()", () => {
    it("returns sum of file sizes", async () => {
      const logger = new TranscriptLogger(tmpDir);
      await logger.append(makeEntry({ sessionId: "s1", content: "some content" }));
      await logger.append(makeEntry({ sessionId: "s2", content: "other content" }));

      const size = await logger.totalSize();
      expect(size).toBeGreaterThan(0);

      // Verify it roughly matches the actual file sizes
      const filePath1 = join(tmpDir, "s1.jsonl");
      const filePath2 = join(tmpDir, "s2.jsonl");
      const actualSize =
        readFileSync(filePath1).length + readFileSync(filePath2).length;
      expect(size).toBe(actualSize);
    });

    it("returns 0 for empty directory", async () => {
      const logger = new TranscriptLogger(tmpDir);
      const size = await logger.totalSize();
      expect(size).toBe(0);
    });
  });

  describe("session ID validation", () => {
    it("rejects invalid characters in sessionId", async () => {
      const logger = new TranscriptLogger(tmpDir);

      await expect(
        logger.append(makeEntry({ sessionId: "../escape" }))
      ).rejects.toThrow();

      await expect(
        logger.append(makeEntry({ sessionId: "has spaces" }))
      ).rejects.toThrow();

      await expect(
        logger.append(makeEntry({ sessionId: "path/traversal" }))
      ).rejects.toThrow();

      await expect(
        logger.append(makeEntry({ sessionId: "" }))
      ).rejects.toThrow();
    });

    it("accepts valid sessionId characters", async () => {
      const logger = new TranscriptLogger(tmpDir);

      await expect(
        logger.append(makeEntry({ sessionId: "valid-session_123" }))
      ).resolves.toBeUndefined();
    });
  });
});
