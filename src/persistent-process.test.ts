/**
 * TDD tests for PersistentProcess and ProcessManager.
 * Written RED first — these will fail until the implementation exists.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter, Readable, Writable } from "node:stream";

// Mock child_process
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

// Mock auth
vi.mock("./auth.js", () => ({
  ensureValidToken: vi.fn().mockResolvedValue(true),
}));

const flush = () => new Promise((r) => setTimeout(r, 10));

/** Create a mock child process with piped stdin/stdout/stderr */
function mockChildProcess() {
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const stdin = new Writable({
    write(_chunk, _encoding, cb) { cb(); },
  });
  const proc = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    stdin,
    pid: 12345,
    kill: vi.fn(),
  });
  return proc;
}

/** Emit a stream-json init event on a mock process stdout */
function emitInit(proc: ReturnType<typeof mockChildProcess>, sessionId = "sess-1") {
  proc.stdout.push(
    JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: sessionId,
      tools: [],
      mcp_servers: [],
      model: "claude-sonnet-4-6",
    }) + "\n"
  );
}

/** Emit a stream-json result event on a mock process stdout */
function emitResult(
  proc: ReturnType<typeof mockChildProcess>,
  opts?: { text?: string; sessionId?: string; isError?: boolean; costUsd?: number; durationMs?: number }
) {
  const text = opts?.text ?? "response text";
  // Emit assistant message first (like real CLI)
  proc.stdout.push(
    JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
      },
      session_id: opts?.sessionId ?? "sess-1",
    }) + "\n"
  );
  // Then emit result
  proc.stdout.push(
    JSON.stringify({
      type: "result",
      subtype: opts?.isError ? "error" : "success",
      is_error: opts?.isError ?? false,
      result: text,
      session_id: opts?.sessionId ?? "sess-1",
      duration_ms: opts?.durationMs ?? 100,
      total_cost_usd: opts?.costUsd ?? 0.01,
    }) + "\n"
  );
}

describe("PersistentProcess", () => {
  let mockProc: ReturnType<typeof mockChildProcess>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockProc = mockChildProcess();
    const { spawn } = await import("node:child_process");
    (spawn as ReturnType<typeof vi.fn>).mockReturnValue(mockProc);
  });

  it("spawns with --input-format stream-json and no prompt arg", async () => {
    const { PersistentProcess } = await import("./persistent-process.js");
    const { spawn } = await import("node:child_process");

    new PersistentProcess({
      model: "claude-sonnet-4-6",
      workDir: "/tmp/test",
      maxBudgetUsd: 5,
      systemPrompt: "test context",
    });

    const args = (spawn as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
    expect(args).toContain("--input-format");
    expect(args).toContain("stream-json");
    expect(args).toContain("-p");
    expect(args).toContain("--output-format");
    // Should NOT contain a prompt as the last positional arg
    const lastArg = args[args.length - 1];
    expect(lastArg).not.toBe("some prompt");
  });

  it("transitions to ready when init event received", async () => {
    const { PersistentProcess } = await import("./persistent-process.js");

    const proc = new PersistentProcess({
      model: "claude-sonnet-4-6",
      workDir: "/tmp/test",
      maxBudgetUsd: 5,
    });

    expect(proc.state).toBe("starting");
    emitInit(mockProc);
    await proc.ready;
    expect(proc.state).toBe("ready");
  });

  it("captures sessionId from init event", async () => {
    const { PersistentProcess } = await import("./persistent-process.js");

    const proc = new PersistentProcess({
      model: "claude-sonnet-4-6",
      workDir: "/tmp/test",
      maxBudgetUsd: 5,
    });

    emitInit(mockProc, "sess-abc-123");
    await proc.ready;
    expect(proc.sessionId).toBe("sess-abc-123");
  });

  it("sendPrompt writes JSON line to stdin", async () => {
    const { PersistentProcess } = await import("./persistent-process.js");

    const proc = new PersistentProcess({
      model: "claude-sonnet-4-6",
      workDir: "/tmp/test",
      maxBudgetUsd: 5,
    });

    emitInit(mockProc);
    await proc.ready;

    const writeSpy = vi.spyOn(mockProc.stdin, "write");
    const resultPromise = proc.sendPrompt("hello world");

    await flush();

    expect(writeSpy).toHaveBeenCalledWith(
      expect.stringContaining('"type":"user"')
    );
    expect(writeSpy).toHaveBeenCalledWith(
      expect.stringContaining('"content":"hello world"')
    );

    // Resolve the result
    emitResult(mockProc, { text: "hi" });
    await resultPromise;
  });

  it("sendPrompt returns parsed result from stream-json events", async () => {
    const { PersistentProcess } = await import("./persistent-process.js");

    const proc = new PersistentProcess({
      model: "claude-sonnet-4-6",
      workDir: "/tmp/test",
      maxBudgetUsd: 5,
    });

    emitInit(mockProc);
    await proc.ready;

    const resultPromise = proc.sendPrompt("test");
    await flush();

    emitResult(mockProc, {
      text: "the answer",
      sessionId: "sess-42",
      costUsd: 0.05,
      durationMs: 500,
    });

    const result = await resultPromise;
    expect(result.text).toBe("the answer");
    expect(result.sessionId).toBe("sess-42");
    expect(result.totalCostUsd).toBe(0.05);
    expect(result.durationMs).toBe(500);
    expect(result.isError).toBe(false);
  });

  it("sendPrompt transitions busy→ready after result", async () => {
    const { PersistentProcess } = await import("./persistent-process.js");

    const proc = new PersistentProcess({
      model: "claude-sonnet-4-6",
      workDir: "/tmp/test",
      maxBudgetUsd: 5,
    });

    emitInit(mockProc);
    await proc.ready;
    expect(proc.state).toBe("ready");

    const resultPromise = proc.sendPrompt("test");
    await flush();
    expect(proc.state).toBe("busy");

    emitResult(mockProc);
    await resultPromise;
    expect(proc.state).toBe("ready");
  });

  it("supports multiple sequential prompts (multi-turn)", async () => {
    const { PersistentProcess } = await import("./persistent-process.js");

    const proc = new PersistentProcess({
      model: "claude-sonnet-4-6",
      workDir: "/tmp/test",
      maxBudgetUsd: 5,
    });

    emitInit(mockProc);
    await proc.ready;

    // First prompt
    const p1 = proc.sendPrompt("first");
    await flush();
    emitResult(mockProc, { text: "response 1" });
    const r1 = await p1;
    expect(r1.text).toBe("response 1");

    // Second prompt — same process
    const p2 = proc.sendPrompt("second");
    await flush();
    emitResult(mockProc, { text: "response 2" });
    const r2 = await p2;
    expect(r2.text).toBe("response 2");

    // Process should NOT have been killed
    expect(mockProc.kill).not.toHaveBeenCalled();
  });

  it("interrupt sends control_request to stdin", async () => {
    const { PersistentProcess } = await import("./persistent-process.js");

    const proc = new PersistentProcess({
      model: "claude-sonnet-4-6",
      workDir: "/tmp/test",
      maxBudgetUsd: 5,
    });

    emitInit(mockProc);
    await proc.ready;

    const writeSpy = vi.spyOn(mockProc.stdin, "write");
    proc.interrupt();

    expect(writeSpy).toHaveBeenCalledWith(
      expect.stringContaining('"subtype":"interrupt"')
    );
  });

  it("sendPrompt rejects if process not ready", async () => {
    const { PersistentProcess } = await import("./persistent-process.js");

    const proc = new PersistentProcess({
      model: "claude-sonnet-4-6",
      workDir: "/tmp/test",
      maxBudgetUsd: 5,
    });

    // Don't emit init — still in 'starting' state
    await expect(proc.sendPrompt("hello")).rejects.toThrow();
  });

  it("sendPrompt rejects if already busy", async () => {
    const { PersistentProcess } = await import("./persistent-process.js");

    const proc = new PersistentProcess({
      model: "claude-sonnet-4-6",
      workDir: "/tmp/test",
      maxBudgetUsd: 5,
    });

    emitInit(mockProc);
    await proc.ready;

    // Start first prompt (don't resolve it)
    proc.sendPrompt("first");
    await flush();

    // Second prompt while busy should reject
    await expect(proc.sendPrompt("second")).rejects.toThrow();

    // Clean up: resolve first prompt
    emitResult(mockProc);
  });

  it("handles process crash during startup", async () => {
    const { PersistentProcess } = await import("./persistent-process.js");

    const proc = new PersistentProcess({
      model: "claude-sonnet-4-6",
      workDir: "/tmp/test",
      maxBudgetUsd: 5,
    });

    expect(proc.state).toBe("starting");

    // Process exits before init
    mockProc.emit("close", 1);

    // The ready promise should reject
    await expect(proc.ready).rejects.toThrow("Process exited during startup");
    expect(proc.state).toBe("dead");
  });

  it("handles process crash mid-response", async () => {
    const { PersistentProcess } = await import("./persistent-process.js");

    const proc = new PersistentProcess({
      model: "claude-sonnet-4-6",
      workDir: "/tmp/test",
      maxBudgetUsd: 5,
    });

    emitInit(mockProc);
    await proc.ready;

    const resultPromise = proc.sendPrompt("test");
    await flush();

    // Process crashes before result
    mockProc.emit("close", 1);

    const result = await resultPromise;
    expect(result.isError).toBe(true);
    expect(proc.state).toBe("dead");
  });

  it("sendPrompt respects timeout", async () => {
    const { PersistentProcess } = await import("./persistent-process.js");

    vi.useFakeTimers();

    const proc = new PersistentProcess({
      model: "claude-sonnet-4-6",
      workDir: "/tmp/test",
      maxBudgetUsd: 5,
    });

    emitInit(mockProc);
    await proc.ready;

    const resultPromise = proc.sendPrompt("test", { timeoutMs: 5000 });

    // Advance past timeout
    vi.advanceTimersByTime(6000);

    const result = await resultPromise;
    expect(result.isError).toBe(true);
    expect(result.isTimeout).toBe(true);

    vi.useRealTimers();
  });

  it("sendPrompt respects abort signal", async () => {
    const { PersistentProcess } = await import("./persistent-process.js");

    const proc = new PersistentProcess({
      model: "claude-sonnet-4-6",
      workDir: "/tmp/test",
      maxBudgetUsd: 5,
    });

    emitInit(mockProc);
    await proc.ready;

    const controller = new AbortController();
    const writeSpy = vi.spyOn(mockProc.stdin, "write");

    const resultPromise = proc.sendPrompt("test", { signal: controller.signal });
    await flush();

    controller.abort();
    await flush();

    // Should have sent interrupt control message
    const interruptCall = writeSpy.mock.calls.find((c) =>
      String(c[0]).includes("interrupt")
    );
    expect(interruptCall).toBeTruthy();

    // Emit a result so the promise resolves (interrupt triggers a result from CLI)
    emitResult(mockProc, { text: "cancelled", isError: true });
    const result = await resultPromise;
    expect(result.isError).toBe(true);
  });
});

describe("ProcessManager", () => {
  let mockProc: ReturnType<typeof mockChildProcess>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockProc = mockChildProcess();
    const { spawn } = await import("node:child_process");
    (spawn as ReturnType<typeof vi.fn>).mockImplementation(() => {
      const p = mockChildProcess();
      // Auto-emit init after a tick
      setTimeout(() => emitInit(p), 5);
      return p;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("getOrCreate spawns new process for unknown userId", async () => {
    const { ProcessManager } = await import("./persistent-process.js");
    const { spawn } = await import("node:child_process");

    const manager = new ProcessManager({
      model: "claude-sonnet-4-6",
      workDir: "/tmp/test",
      maxBudgetUsd: 5,
    });

    const proc = await manager.getOrCreate(123);
    expect(proc).toBeDefined();
    expect(proc.state).toBe("ready");
    expect(spawn).toHaveBeenCalled();
  });

  it("getOrCreate returns existing process for known userId", async () => {
    const { ProcessManager } = await import("./persistent-process.js");
    const { spawn } = await import("node:child_process");

    const manager = new ProcessManager({
      model: "claude-sonnet-4-6",
      workDir: "/tmp/test",
      maxBudgetUsd: 5,
    });

    const proc1 = await manager.getOrCreate(123);
    const proc2 = await manager.getOrCreate(123);
    expect(proc1).toBe(proc2);
    // spawn should only be called once
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("getOrCreate respawns if model changed", async () => {
    const { ProcessManager } = await import("./persistent-process.js");
    const { spawn } = await import("node:child_process");

    const manager = new ProcessManager({
      model: "claude-sonnet-4-6",
      workDir: "/tmp/test",
      maxBudgetUsd: 5,
    });

    const proc1 = await manager.getOrCreate(123, "claude-sonnet-4-6");
    const proc2 = await manager.getOrCreate(123, "claude-opus-4-6");
    expect(proc1).not.toBe(proc2);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("getOrCreate respawns if process is dead", async () => {
    const { ProcessManager } = await import("./persistent-process.js");
    const { spawn } = await import("node:child_process");

    const manager = new ProcessManager({
      model: "claude-sonnet-4-6",
      workDir: "/tmp/test",
      maxBudgetUsd: 5,
    });

    const proc1 = await manager.getOrCreate(123);
    // Simulate death
    proc1.kill();
    await flush();

    const proc2 = await manager.getOrCreate(123);
    expect(proc2).not.toBe(proc1);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("reset kills process for userId", async () => {
    const { ProcessManager } = await import("./persistent-process.js");

    const manager = new ProcessManager({
      model: "claude-sonnet-4-6",
      workDir: "/tmp/test",
      maxBudgetUsd: 5,
    });

    const proc = await manager.getOrCreate(123);
    expect(proc.state).toBe("ready");

    manager.reset(123);
    expect(proc.state).toBe("dead");
  });

  it("resetAll kills all processes", async () => {
    const { ProcessManager } = await import("./persistent-process.js");

    const manager = new ProcessManager({
      model: "claude-sonnet-4-6",
      workDir: "/tmp/test",
      maxBudgetUsd: 5,
    });

    const proc1 = await manager.getOrCreate(123);
    const proc2 = await manager.getOrCreate(456);

    manager.resetAll();
    expect(proc1.state).toBe("dead");
    expect(proc2.state).toBe("dead");
  });

  it("idle reaper kills expired processes", async () => {
    vi.useFakeTimers();

    const { ProcessManager } = await import("./persistent-process.js");

    const manager = new ProcessManager({
      model: "claude-sonnet-4-6",
      workDir: "/tmp/test",
      maxBudgetUsd: 5,
      idleTimeoutMs: 60_000, // 1 minute
    });

    const createPromise = manager.getOrCreate(123);
    // Advance to fire the mock's setTimeout(() => emitInit(p), 5)
    await vi.advanceTimersByTimeAsync(10);
    const proc = await createPromise;
    expect(proc.state).toBe("ready");

    // Advance past idle timeout + reaper interval (reaper checks every 60s)
    await vi.advanceTimersByTimeAsync(120_000);

    expect(proc.state).toBe("dead");
  });
});

describe("PersistentProcess activity events", () => {
  let mockProc: ReturnType<typeof mockChildProcess>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockProc = mockChildProcess();
    const { spawn } = await import("node:child_process");
    (spawn as ReturnType<typeof vi.fn>).mockReturnValue(mockProc);
  });

  it("fires onActivity callback when tool_use is detected in stream", async () => {
    const { PersistentProcess } = await import("./persistent-process.js");

    const activities: Array<{ tool?: string; text?: string }> = [];
    const proc = new PersistentProcess({
      model: "claude-sonnet-4-6",
      workDir: "/tmp/test",
      maxBudgetUsd: 5,
      onActivity: (event) => activities.push(event),
    });

    emitInit(mockProc);
    await proc.ready;

    const resultPromise = proc.sendPrompt("test");
    await flush();

    // Emit an assistant message with a tool_use content block
    mockProc.stdout.push(
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", name: "Bash" }],
        },
        session_id: "sess-1",
      }) + "\n"
    );
    await flush();

    expect(activities.length).toBeGreaterThanOrEqual(1);
    expect(activities.some((a) => a.tool === "Bash")).toBe(true);

    emitResult(mockProc);
    await resultPromise;
  });

  it("fires onActivity with text for assistant text blocks", async () => {
    const { PersistentProcess } = await import("./persistent-process.js");

    const activities: Array<{ tool?: string; text?: string }> = [];
    const proc = new PersistentProcess({
      model: "claude-sonnet-4-6",
      workDir: "/tmp/test",
      maxBudgetUsd: 5,
      onActivity: (event) => activities.push(event),
    });

    emitInit(mockProc);
    await proc.ready;

    const resultPromise = proc.sendPrompt("test");
    await flush();

    mockProc.stdout.push(
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Let me check that for you." }],
        },
        session_id: "sess-1",
      }) + "\n"
    );
    await flush();

    expect(activities.some((a) => a.text === "Let me check that for you.")).toBe(true);

    emitResult(mockProc);
    await resultPromise;
  });

  it("does not fire onActivity when no callback is set", async () => {
    const { PersistentProcess } = await import("./persistent-process.js");

    // No onActivity callback — should not throw
    const proc = new PersistentProcess({
      model: "claude-sonnet-4-6",
      workDir: "/tmp/test",
      maxBudgetUsd: 5,
    });

    emitInit(mockProc);
    await proc.ready;

    const resultPromise = proc.sendPrompt("test");
    await flush();

    // Emit tool_use — should not throw even without callback
    mockProc.stdout.push(
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", name: "Read" }],
        },
        session_id: "sess-1",
      }) + "\n"
    );
    await flush();

    emitResult(mockProc);
    await resultPromise;
  });
});

describe("Long-running orchestrator", () => {
  let mockProc: ReturnType<typeof mockChildProcess>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockProc = mockChildProcess();
    const { spawn } = await import("node:child_process");
    (spawn as ReturnType<typeof vi.fn>).mockReturnValue(mockProc);
  });

  it("auto-interrupts after maxRunMs exceeded", async () => {
    vi.useFakeTimers();

    const { PersistentProcess } = await import("./persistent-process.js");

    const proc = new PersistentProcess({
      model: "claude-sonnet-4-6",
      workDir: "/tmp/test",
      maxBudgetUsd: 5,
    });

    emitInit(mockProc);
    await proc.ready;

    const writeSpy = vi.spyOn(mockProc.stdin, "write");

    // Send prompt with a 5-minute max run time
    const resultPromise = proc.sendPrompt("complex task", { maxRunMs: 5 * 60 * 1000 });

    // Advance past maxRunMs
    vi.advanceTimersByTime(5 * 60 * 1000 + 1000);

    // Should have sent an interrupt
    const interruptCall = writeSpy.mock.calls.find((c) =>
      String(c[0]).includes("interrupt")
    );
    expect(interruptCall).toBeTruthy();

    // Emit result after interrupt
    emitResult(mockProc, { text: "interrupted", isError: true });
    const result = await resultPromise;
    expect(result.isError).toBe(true);

    vi.useRealTimers();
  });
});
