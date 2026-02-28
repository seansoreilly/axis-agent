import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentResult } from "./agent.js";
import type { Fact } from "./memory.js";

// Shared mock bot instance — captured when TelegramBot constructor is called
let mockBotInstance: Record<string, ReturnType<typeof vi.fn>>;

vi.mock("node-telegram-bot-api", () => {
  return {
    default: vi.fn().mockImplementation(function () {
      mockBotInstance = {
        on: vi.fn(),
        sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
        sendChatAction: vi.fn().mockResolvedValue({}),
        deleteMessage: vi.fn().mockResolvedValue({}),
        editMessageText: vi.fn().mockResolvedValue({}),
        answerCallbackQuery: vi.fn().mockResolvedValue({}),
        stopPolling: vi.fn(),
        getFile: vi.fn().mockResolvedValue({ file_path: "photos/test.jpg" }),
      };
      return mockBotInstance;
    }),
  };
});

// Let microtask queue drain so fire-and-forget async handlers complete
const flush = () => new Promise((r) => setTimeout(r, 10));

function makeAgent(runImpl?: (...args: unknown[]) => unknown) {
  return {
    run: runImpl
      ? vi.fn().mockImplementation(runImpl)
      : vi.fn().mockResolvedValue({
          text: "hello",
          sessionId: "sess-1",
          durationMs: 100,
          totalCostUsd: 0.01,
          isError: false,
        } satisfies AgentResult),
    generateSummary: vi.fn().mockResolvedValue(null),
    shouldSummarize: vi.fn().mockReturnValue(false),
  };
}

function makeFact(value: string, category = "general" as const): Fact {
  const now = new Date().toISOString();
  return { value, category, createdAt: now, updatedAt: now, lastAccessedAt: now };
}

function makeMemory() {
  return {
    recordSession: vi.fn(),
    updateSessionSummary: vi.fn(),
    setFact: vi.fn(),
    deleteFact: vi.fn(),
    getAllFacts: vi.fn().mockReturnValue({} as Record<string, Fact>),
    getFact: vi.fn(),
    getLastSession: vi.fn().mockReturnValue(undefined),
    getLastSessionSummary: vi.fn().mockReturnValue(undefined),
    getContext: vi.fn().mockReturnValue(""),
    getStats: vi.fn().mockReturnValue({ totalFacts: 0, byCategory: {} }),
  };
}

function makeScheduler() {
  return {
    add: vi.fn(),
    remove: vi.fn().mockReturnValue(true),
    list: vi.fn().mockReturnValue([]),
    stopAll: vi.fn(),
  };
}

function makeMsg(text: string, userId = 123) {
  return { chat: { id: 456 }, from: { id: userId }, text };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (msg: any) => void;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CallbackHandler = (query: any) => void;

async function createBot(agent?: ReturnType<typeof makeAgent>) {
  const { TelegramIntegration } = await import("./telegram.js");

  const a = agent ?? makeAgent();
  const m = makeMemory();
  const s = makeScheduler();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bot = new TelegramIntegration("token", [123], a as any, m as any, s as any);
  bot.start();

  const handler = mockBotInstance.on.mock.calls.find(
    (c: unknown[]) => c[0] === "message"
  )?.[1] as Handler;

  const callbackHandler = mockBotInstance.on.mock.calls.find(
    (c: unknown[]) => c[0] === "callback_query"
  )?.[1] as CallbackHandler;

  return { bot, agent: a, memory: m, scheduler: s, botInstance: mockBotInstance, handler, callbackHandler };
}

describe("TelegramIntegration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends error message to user when agent.run throws", async () => {
    const agent = makeAgent(() => Promise.reject(new Error("SDK crash")));
    const { handler, botInstance } = await createBot(agent);

    handler(makeMsg("hello"));
    await flush();

    const errorMsg = botInstance.sendMessage.mock.calls.find((c: unknown[]) =>
      String(c[1]).includes("Something went wrong")
    );
    expect(errorMsg).toBeTruthy();
  });

  it("rejects concurrent messages from same user", async () => {
    let resolveFirst!: (v: AgentResult) => void;
    const firstPromise = new Promise<AgentResult>((resolve) => {
      resolveFirst = resolve;
    });

    const agent = makeAgent();
    agent.run.mockReturnValueOnce(firstPromise);

    const { handler, botInstance } = await createBot(agent);

    // Start first message (will block on the unresolved promise)
    handler(makeMsg("first"));
    await flush();

    // Send second message while first is processing
    handler(makeMsg("second"));
    await flush();

    // User should be told to wait
    const waitMsg = botInstance.sendMessage.mock.calls.find((c: unknown[]) =>
      String(c[1]).includes("Still working")
    );
    expect(waitMsg).toBeTruthy();

    // Agent.run should only have been called once
    expect(agent.run).toHaveBeenCalledTimes(1);

    // Clean up — resolve first
    resolveFirst({
      text: "done",
      sessionId: "sess-1",
      durationMs: 100,
      totalCostUsd: 0.01,
      isError: false,
    });
    await flush();
  });

  it("retries without session on stale session error", async () => {
    const agent = makeAgent();
    const { handler, botInstance } = await createBot(agent);

    // First call stores a session
    agent.run.mockResolvedValueOnce({
      text: "first",
      sessionId: "old-sess",
      durationMs: 50,
      totalCostUsd: 0.01,
      isError: false,
    });
    handler(makeMsg("setup"));
    await flush();

    // Now set up stale -> retry sequence
    agent.run.mockReset();
    agent.run
      .mockResolvedValueOnce({
        text: "Error: stale",
        sessionId: "",
        durationMs: 10,
        totalCostUsd: 0,
        isError: true,
      })
      .mockResolvedValueOnce({
        text: "recovered",
        sessionId: "new-sess",
        durationMs: 100,
        totalCostUsd: 0.01,
        isError: false,
      });

    handler(makeMsg("after stale"));
    await flush();

    // Agent should have been called twice
    expect(agent.run).toHaveBeenCalledTimes(2);
    // First call has the stale session
    expect(agent.run.mock.calls[0][1]).toMatchObject({ sessionId: "old-sess" });
    // Retry has model, signal, and userId but no session
    expect(agent.run.mock.calls[1][1]).not.toHaveProperty("sessionId");

    // User gets the recovered response
    const recovered = botInstance.sendMessage.mock.calls.filter((c: unknown[]) =>
      String(c[1]).includes("recovered")
    );
    expect(recovered.length).toBe(1);
  });

  it("repeats typing indicator during long agent runs", async () => {
    vi.useFakeTimers();

    let resolveRun!: (v: AgentResult) => void;
    const runPromise = new Promise<AgentResult>((resolve) => {
      resolveRun = resolve;
    });

    const agent = makeAgent();
    agent.run.mockReturnValue(runPromise);

    const { handler, botInstance } = await createBot(agent);

    handler(makeMsg("long task"));
    await vi.advanceTimersByTimeAsync(1);

    // Initial typing action
    expect(botInstance.sendChatAction).toHaveBeenCalledTimes(1);

    // Advance 4s — interval fires
    await vi.advanceTimersByTimeAsync(4000);
    expect(botInstance.sendChatAction).toHaveBeenCalledTimes(2);

    // Another 4s
    await vi.advanceTimersByTimeAsync(4000);
    expect(botInstance.sendChatAction).toHaveBeenCalledTimes(3);

    // Resolve agent
    resolveRun({
      text: "done",
      sessionId: "sess-1",
      durationMs: 8000,
      totalCostUsd: 0.02,
      isError: false,
    });
    await vi.advanceTimersByTimeAsync(1);

    // No more typing after resolution
    const countAfter = botInstance.sendChatAction.mock.calls.length;
    await vi.advanceTimersByTimeAsync(4000);
    expect(botInstance.sendChatAction).toHaveBeenCalledTimes(countAfter);

    vi.useRealTimers();
  });

  it("unlocks user after agent error so they can send again", async () => {
    const agent = makeAgent();
    agent.run
      .mockRejectedValueOnce(new Error("crash"))
      .mockResolvedValueOnce({
        text: "works now",
        sessionId: "sess-2",
        durationMs: 50,
        totalCostUsd: 0.01,
        isError: false,
      });

    const { handler, botInstance } = await createBot(agent);

    // First message crashes
    handler(makeMsg("crash me"));
    await flush();

    // Second message should work — not rejected as "still working"
    handler(makeMsg("try again"));
    await flush();

    const waitMsg = botInstance.sendMessage.mock.calls.find((c: unknown[]) =>
      String(c[1]).includes("Still working")
    );
    expect(waitMsg).toBeUndefined();
    expect(agent.run).toHaveBeenCalledTimes(2);
  });

  it("rejects unauthorized users", async () => {
    const { handler, botInstance } = await createBot();

    handler(makeMsg("hello", 999));
    await flush();

    const unauth = botInstance.sendMessage.mock.calls.find((c: unknown[]) =>
      String(c[1]).includes("Unauthorized")
    );
    expect(unauth).toBeTruthy();
  });

  it("/cancel aborts a running request", async () => {
    let resolveRun!: (v: AgentResult) => void;
    const runPromise = new Promise<AgentResult>((resolve) => {
      resolveRun = resolve;
    });

    const agent = makeAgent();
    agent.run.mockReturnValueOnce(runPromise);

    const { handler, botInstance } = await createBot(agent);

    // Start a long-running request
    handler(makeMsg("long task"));
    await flush();

    // Cancel it
    handler(makeMsg("/cancel"));
    await flush();

    const cancelMsg = botInstance.sendMessage.mock.calls.find((c: unknown[]) =>
      String(c[1]).includes("Cancelling")
    );
    expect(cancelMsg).toBeTruthy();

    // Resolve so test cleans up
    resolveRun({
      text: "cancelled",
      sessionId: "sess-1",
      durationMs: 100,
      totalCostUsd: 0,
      isError: true,
    });
    await flush();
  });

  it("/cancel with nothing running says nothing to cancel", async () => {
    const { handler, botInstance } = await createBot();

    handler(makeMsg("/cancel"));
    await flush();

    const msg = botInstance.sendMessage.mock.calls.find((c: unknown[]) =>
      String(c[1]).includes("Nothing to cancel")
    );
    expect(msg).toBeTruthy();
  });

  it("/retry re-runs the last prompt", async () => {
    const agent = makeAgent();
    const { handler } = await createBot(agent);

    // First message
    handler(makeMsg("original prompt"));
    await flush();

    // Retry
    handler(makeMsg("/retry"));
    await flush();

    expect(agent.run).toHaveBeenCalledTimes(2);
    // Both calls should have the same prompt
    expect(agent.run.mock.calls[0][0]).toBe("original prompt");
    expect(agent.run.mock.calls[1][0]).toBe("original prompt");
  });

  it("/retry with no previous message gives error", async () => {
    const { handler, botInstance } = await createBot();

    handler(makeMsg("/retry"));
    await flush();

    const msg = botInstance.sendMessage.mock.calls.find((c: unknown[]) =>
      String(c[1]).includes("No previous message")
    );
    expect(msg).toBeTruthy();
  });

  it("/model sets model override", async () => {
    const agent = makeAgent();
    const { handler, botInstance } = await createBot(agent);

    handler(makeMsg("/model opus"));
    await flush();

    const switchMsg = botInstance.sendMessage.mock.calls.find((c: unknown[]) =>
      String(c[1]).includes("Switched to opus")
    );
    expect(switchMsg).toBeTruthy();

    // Now send a message — it should use opus model
    handler(makeMsg("test with opus"));
    await flush();

    const runCall = agent.run.mock.calls[0];
    expect(runCall[1]).toMatchObject({ model: "claude-opus-4-6" });
  });

  it("/model with no args shows current model with buttons", async () => {
    const { handler, botInstance } = await createBot();

    handler(makeMsg("/model"));
    await flush();

    const msg = botInstance.sendMessage.mock.calls.find((c: unknown[]) =>
      String(c[1]).includes("Current model")
    );
    expect(msg).toBeTruthy();
    // Should include inline keyboard
    expect(msg[2]).toHaveProperty("reply_markup");
  });

  it("/cost shows accumulated costs", async () => {
    const agent = makeAgent();
    const { handler, botInstance } = await createBot(agent);

    // Make a request first to accumulate cost
    handler(makeMsg("hello"));
    await flush();

    handler(makeMsg("/cost"));
    await flush();

    const costMsg = botInstance.sendMessage.mock.calls.find((c: unknown[]) =>
      String(c[1]).includes("Total cost")
    );
    expect(costMsg).toBeTruthy();
  });

  it("/tasks lists scheduled tasks", async () => {
    const { handler, botInstance, scheduler } = await createBot();

    scheduler.list.mockReturnValue([
      { id: "morning", name: "morning", schedule: "0 9 * * *", prompt: "briefing", enabled: true },
    ]);

    handler(makeMsg("/tasks"));
    await flush();

    const tasksMsg = botInstance.sendMessage.mock.calls.find((c: unknown[]) =>
      String(c[1]).includes("morning")
    );
    expect(tasksMsg).toBeTruthy();
  });

  it("/schedule add creates a task", async () => {
    const { handler, botInstance, scheduler } = await createBot();

    handler(makeMsg('/schedule add morning "0 9 * * *" Give me a briefing'));
    await flush();

    expect(scheduler.add).toHaveBeenCalledWith({
      id: "morning",
      name: "morning",
      schedule: "0 9 * * *",
      prompt: "Give me a briefing",
      enabled: true,
    });

    const msg = botInstance.sendMessage.mock.calls.find((c: unknown[]) =>
      String(c[1]).includes("Scheduled task")
    );
    expect(msg).toBeTruthy();
  });

  it("/schedule remove deletes a task", async () => {
    const { handler, botInstance, scheduler } = await createBot();

    handler(makeMsg("/schedule remove morning"));
    await flush();

    expect(scheduler.remove).toHaveBeenCalledWith("morning");
    const msg = botInstance.sendMessage.mock.calls.find((c: unknown[]) =>
      String(c[1]).includes("Removed task")
    );
    expect(msg).toBeTruthy();
  });

  it("callback query retry re-runs last prompt", async () => {
    const agent = makeAgent();
    const { handler, callbackHandler } = await createBot(agent);

    // Send a message first
    handler(makeMsg("hello world"));
    await flush();

    // Trigger retry callback
    callbackHandler({
      id: "cb-1",
      from: { id: 123 },
      message: { chat: { id: 456 } },
      data: "retry",
    });
    await flush();

    expect(agent.run).toHaveBeenCalledTimes(2);
    expect(agent.run.mock.calls[1][0]).toBe("hello world");
  });

  it("callback query model switch changes model", async () => {
    const agent = makeAgent();
    const { handler, callbackHandler, botInstance } = await createBot(agent);

    // Switch to haiku via callback
    callbackHandler({
      id: "cb-2",
      from: { id: 123 },
      message: { chat: { id: 456 } },
      data: "model:haiku",
    });
    await flush();

    const switchMsg = botInstance.sendMessage.mock.calls.find((c: unknown[]) =>
      String(c[1]).includes("Switched to haiku")
    );
    expect(switchMsg).toBeTruthy();

    // Send message — should use haiku
    handler(makeMsg("quick question"));
    await flush();

    expect(agent.run.mock.calls[0][1]).toMatchObject({
      model: "claude-haiku-4-5-20251001",
    });
  });

  it("response includes inline buttons", async () => {
    const { handler, botInstance } = await createBot();

    handler(makeMsg("hello"));
    await flush();

    // Find the response message (not the command responses)
    const responseMsg = botInstance.sendMessage.mock.calls.find(
      (c: unknown[]) =>
        String(c[1]).includes("hello") &&
        (c[2] as Record<string, unknown>)?.reply_markup
    );
    expect(responseMsg).toBeTruthy();
  });

  it("/status includes model and memory stats", async () => {
    const { handler, botInstance, memory } = await createBot();

    memory.getStats.mockReturnValue({
      totalFacts: 5,
      byCategory: { personal: 2, work: 3 },
    });

    handler(makeMsg("/status"));
    await flush();

    const statusMsg = botInstance.sendMessage.mock.calls.find((c: unknown[]) =>
      String(c[1]).includes("Model:")
    );
    expect(statusMsg).toBeTruthy();
    expect(String(statusMsg[1])).toContain("5");
  });

  it("/memories shows categorized facts with timestamps", async () => {
    const { handler, botInstance, memory } = await createBot();

    memory.getAllFacts.mockReturnValue({
      name: makeFact("Sean", "personal"),
      "project-x": makeFact("React app", "work"),
    });
    memory.getStats.mockReturnValue({
      totalFacts: 2,
      byCategory: { personal: 1, work: 1 },
    });

    handler(makeMsg("/memories"));
    await flush();

    const msg = botInstance.sendMessage.mock.calls.find((c: unknown[]) =>
      String(c[1]).includes("Memories")
    );
    expect(msg).toBeTruthy();
    expect(String(msg[1])).toContain("2 total");
  });

  it("passes userId to agent.run", async () => {
    const agent = makeAgent();
    const { handler } = await createBot(agent);

    handler(makeMsg("hello"));
    await flush();

    expect(agent.run.mock.calls[0][1]).toMatchObject({ userId: 123 });
  });

  it("passes cost to recordSession", async () => {
    const agent = makeAgent();
    const { handler, memory } = await createBot(agent);

    handler(makeMsg("hello"));
    await flush();

    expect(memory.recordSession).toHaveBeenCalledWith(
      "sess-1",
      123,
      "hello",
      { totalCostUsd: 0.01 }
    );
  });

  it("triggers summary for expensive sessions", async () => {
    const agent = makeAgent();
    agent.shouldSummarize.mockReturnValue(true);
    agent.generateSummary.mockResolvedValue("- Did stuff\n- Made decisions");

    const { handler, memory } = await createBot(agent);

    handler(makeMsg("complex task"));
    await flush();

    expect(agent.shouldSummarize).toHaveBeenCalled();
    // Give the fire-and-forget summary time to complete
    await flush();
    expect(agent.generateSummary).toHaveBeenCalledWith("sess-1");
  });

  it("/new actually prevents session resumption on next message", async () => {
    const agent = makeAgent();
    const { handler } = await createBot(agent);

    // First message establishes a session
    handler(makeMsg("hello"));
    await flush();
    expect(agent.run.mock.calls[0][1].sessionId).toBeUndefined();

    // Second message should resume the session
    handler(makeMsg("follow up"));
    await flush();
    expect(agent.run.mock.calls[1][1]).toMatchObject({ sessionId: "sess-1" });

    // /new clears the session
    handler(makeMsg("/new"));
    await flush();

    // Next message should NOT have a sessionId
    handler(makeMsg("fresh start"));
    await flush();
    expect(agent.run.mock.calls[2][1].sessionId).toBeUndefined();
  });

  it("new_session callback prevents session resumption", async () => {
    const agent = makeAgent();
    const { handler, callbackHandler } = await createBot(agent);

    // Establish a session
    handler(makeMsg("hello"));
    await flush();

    // Click "New session" button
    callbackHandler({
      id: "cb-new",
      from: { id: 123 },
      message: { chat: { id: 456 } },
      data: "new_session",
    });
    await flush();

    // Next message should NOT have a sessionId
    handler(makeMsg("fresh"));
    await flush();
    expect(agent.run.mock.calls[1][1].sessionId).toBeUndefined();
  });

  it("does not record session with empty sessionId", async () => {
    const agent = makeAgent();
    agent.run.mockResolvedValueOnce({
      text: "The agent encountered an error. Please try again or start a /new session.",
      sessionId: "",
      durationMs: 10,
      totalCostUsd: 0,
      isError: true,
    });

    const { handler, memory } = await createBot(agent);

    handler(makeMsg("fail"));
    await flush();

    expect(memory.recordSession).not.toHaveBeenCalled();
  });

  it("shows meaningful error when SDK returns empty errors array", async () => {
    const agent = makeAgent();
    // Simulate what happens when agent.ts gets an empty errors array:
    // it now returns a meaningful message instead of "Error: "
    agent.run.mockResolvedValueOnce({
      text: "The agent encountered an error. Please try again or start a /new session.",
      sessionId: "",
      durationMs: 10,
      totalCostUsd: 0,
      isError: true,
    });

    const { handler, botInstance } = await createBot(agent);

    handler(makeMsg("trigger error"));
    await flush();

    const errorMsg = botInstance.sendMessage.mock.calls.find((c: unknown[]) =>
      String(c[1]).includes("encountered an error")
    );
    expect(errorMsg).toBeTruthy();
    // Should NOT show bare "Error: " with nothing after
    const bareError = botInstance.sendMessage.mock.calls.find((c: unknown[]) =>
      String(c[1]).match(/^Error:\s*$/)
    );
    expect(bareError).toBeUndefined();
  });

  it("handles reply context from replied messages", async () => {
    const agent = makeAgent();
    const { handler } = await createBot(agent);

    handler({
      chat: { id: 456 },
      from: { id: 123 },
      text: "expand on this",
      reply_to_message: {
        text: "The previous bot response was about cats",
        from: { id: 999 }, // different user (the bot)
      },
    });
    await flush();

    // The prompt should include the replied-to context
    const prompt = agent.run.mock.calls[0][0] as string;
    expect(prompt).toContain("Replying to:");
    expect(prompt).toContain("previous bot response");
  });
});
