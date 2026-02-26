import TelegramBot from "node-telegram-bot-api";
import type { Agent, AgentResult } from "./agent.js";
import type { Memory } from "./memory.js";
import type { Scheduler } from "./scheduler.js";
import { info, error as logError } from "./logger.js";

const MAX_MESSAGE_LENGTH = 4096;
const ACK_DELAY_MS = 3000; // Send initial ack after 3s if still processing
const STATUS_UPDATE_INTERVAL_MS = 60_000; // Update status every 60s
const RESPONSE_TIME_HISTORY = 20; // Track last N response times for ETA

const VALID_MODELS: Record<string, string> = {
  opus: "claude-opus-4-6",
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5-20251001",
};

function sanitizeKey(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, "");
}

interface UserState {
  lastPrompt?: string;
  lastChatId?: number;
  modelOverride?: string;
  totalCostUsd: number;
  requestCount: number;
  abortController?: AbortController;
}

export class TelegramIntegration {
  private bot: TelegramBot;
  private botToken: string;
  private agent: Agent;
  private memory: Memory;
  private scheduler?: Scheduler;
  private allowedUsers: Set<number>;
  private userSessions: Map<number, string> = new Map();
  private processingUsers: Set<number> = new Set();
  private responseTimes: number[] = []; // Recent response durations in ms
  private userState: Map<number, UserState> = new Map();

  constructor(
    botToken: string,
    allowedUsers: number[],
    agent: Agent,
    memory: Memory,
    scheduler?: Scheduler
  ) {
    this.bot = new TelegramBot(botToken, { polling: true });
    this.botToken = botToken;
    this.agent = agent;
    this.memory = memory;
    this.scheduler = scheduler;
    this.allowedUsers = new Set(allowedUsers);
  }

  private getState(userId: number): UserState {
    let state = this.userState.get(userId);
    if (!state) {
      state = { totalCostUsd: 0, requestCount: 0 };
      this.userState.set(userId, state);
    }
    return state;
  }

  start(): void {
    this.bot.on("message", (msg) => {
      this.handleMessage(msg).catch((err) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        logError("telegram", `Failed to handle message: ${errMsg}`);
      });
    });

    this.bot.on("callback_query", (query) => {
      this.handleCallbackQuery(query).catch((err) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        logError("telegram", `Failed to handle callback: ${errMsg}`);
      });
    });

    info("telegram", "Bot started (polling mode)");
  }

  private getEtaText(): string {
    if (this.responseTimes.length === 0) {
      return "typically 30-90 seconds";
    }
    const avg = this.responseTimes.reduce((a, b) => a + b, 0) / this.responseTimes.length;
    const seconds = Math.round(avg / 1000);
    if (seconds < 60) return `~${seconds}s`;
    const minutes = Math.round(seconds / 60);
    return `~${minutes} min`;
  }

  private recordResponseTime(ms: number): void {
    this.responseTimes.push(ms);
    if (this.responseTimes.length > RESPONSE_TIME_HISTORY) {
      this.responseTimes.shift();
    }
  }

  private formatElapsed(startMs: number): string {
    const elapsed = Math.round((Date.now() - startMs) / 1000);
    if (elapsed < 60) return `${elapsed}s`;
    const min = Math.floor(elapsed / 60);
    const sec = elapsed % 60;
    return `${min}m ${sec}s`;
  }

  /**
   * Sends an initial ack after ACK_DELAY_MS, then edits it every 60s with status.
   * Returns a cleanup function. The ack is deleted when cleanup is called.
   */
  private startProgressUpdates(
    chatId: number,
    startTime: number
  ): { stop: () => Promise<void> } {
    let ackMessageId: number | undefined;
    let stopped = false;
    let updateInterval: ReturnType<typeof setInterval> | undefined;

    // Send initial ack after a short delay (skip if response comes fast)
    const ackTimeout = setTimeout(async () => {
      if (stopped) return;
      try {
        const eta = this.getEtaText();
        const sent = await this.bot.sendMessage(
          chatId,
          `Working on it... ETA: ${eta}`
        );
        ackMessageId = sent.message_id;

        // Start editing the message every 60s
        updateInterval = setInterval(async () => {
          if (stopped || !ackMessageId) return;
          const elapsed = this.formatElapsed(startTime);
          try {
            await this.bot.editMessageText(
              `Still working... (${elapsed} elapsed)`,
              { chat_id: chatId, message_id: ackMessageId }
            );
          } catch {
            // Edit can fail if message was already deleted
          }
        }, STATUS_UPDATE_INTERVAL_MS);
      } catch {
        // Non-critical — just skip the ack
      }
    }, ACK_DELAY_MS);

    return {
      stop: async () => {
        stopped = true;
        clearTimeout(ackTimeout);
        if (updateInterval) clearInterval(updateInterval);
        // Delete the progress message
        if (ackMessageId) {
          try {
            await this.bot.deleteMessage(chatId, ackMessageId);
          } catch {
            // Already deleted or permissions issue — ignore
          }
        }
      },
    };
  }

  private isAuthorized(userId: number): boolean {
    if (this.allowedUsers.size === 0) return false;
    return this.allowedUsers.has(userId);
  }

  private async downloadFile(fileId: string): Promise<string | null> {
    try {
      const file = await this.bot.getFile(fileId);
      if (!file.file_path) return null;
      const fileUrl = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
      const response = await fetch(fileUrl);
      return await response.text();
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logError("telegram", `Failed to download file: ${errMsg}`);
      return null;
    }
  }

  private async downloadFileBuffer(fileId: string): Promise<{ buffer: Buffer; path: string } | null> {
    try {
      const file = await this.bot.getFile(fileId);
      if (!file.file_path) return null;
      const fileUrl = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
      const response = await fetch(fileUrl);
      const buffer = Buffer.from(await response.arrayBuffer());
      return { buffer, path: file.file_path };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logError("telegram", `Failed to download file: ${errMsg}`);
      return null;
    }
  }

  private async handleMessage(msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;

    // Handle text messages and file uploads (caption is text for file messages)
    let text = msg.text ?? msg.caption ?? "";

    // If a document is attached, download it and prepend its content
    if (msg.document) {
      const content = await this.downloadFile(msg.document.file_id);
      if (content) {
        const fileName = msg.document.file_name ?? "uploaded_file";
        text = `[File: ${fileName}]\n\`\`\`\n${content}\n\`\`\`\n\n${text}`.trim();
      }
    }

    // Handle photo messages — download largest version and describe as image context
    if (msg.photo && msg.photo.length > 0) {
      const largest = msg.photo[msg.photo.length - 1];
      const downloaded = await this.downloadFileBuffer(largest.file_id);
      if (downloaded) {
        const ext = downloaded.path.split(".").pop() ?? "jpg";
        // Save temporarily so the agent can read it with the Read tool
        const tmpPath = `/tmp/telegram_photo_${Date.now()}.${ext}`;
        const { writeFileSync } = await import("node:fs");
        writeFileSync(tmpPath, downloaded.buffer);
        text = `[Photo uploaded: ${tmpPath}]\nThe user sent a photo. Use the Read tool to view it at the path above.\n\n${text}`.trim();
      }
      if (!text) text = "What's in this image?";
    }

    // Handle voice messages — download and save for the agent to process
    if (msg.voice) {
      const downloaded = await this.downloadFileBuffer(msg.voice.file_id);
      if (downloaded) {
        const tmpPath = `/tmp/telegram_voice_${Date.now()}.ogg`;
        const { writeFileSync } = await import("node:fs");
        writeFileSync(tmpPath, downloaded.buffer);
        text = `[Voice message: ${tmpPath}, duration: ${msg.voice.duration}s]\nThe user sent a voice message. Use the Bash tool to transcribe or process it.\n\n${text}`.trim();
      }
      if (!text) text = "Please process this voice message.";
    }

    // Handle inline reply context — prepend the replied-to message
    if (msg.reply_to_message && msg.reply_to_message.from?.id !== msg.from?.id) {
      const repliedText = msg.reply_to_message.text ?? "";
      if (repliedText) {
        text = `[Replying to: "${repliedText.slice(0, 500)}"]\n\n${text}`;
      }
    }

    if (!userId || !text) return;

    if (!this.isAuthorized(userId)) {
      await this.bot.sendMessage(chatId, "Unauthorized.");
      return;
    }

    if (text.startsWith("/")) {
      await this.handleCommand(chatId, userId, text);
      return;
    }

    await this.runAgent(chatId, userId, text);
  }

  private async runAgent(
    chatId: number,
    userId: number,
    text: string
  ): Promise<void> {
    // Prevent concurrent agent runs for the same user
    if (this.processingUsers.has(userId)) {
      await this.bot.sendMessage(
        chatId,
        "Still working on your previous message. Please wait."
      );
      return;
    }

    const state = this.getState(userId);
    state.lastPrompt = text;
    state.lastChatId = chatId;

    this.processingUsers.add(userId);
    const startTime = Date.now();
    const abortController = new AbortController();
    state.abortController = abortController;

    // Send typing indicator every 4 seconds until we're done
    const typingInterval = setInterval(() => {
      this.bot.sendChatAction(chatId, "typing").catch(() => {});
    }, 4000);
    await this.bot.sendChatAction(chatId, "typing");

    // Start progress updates (ack after 3s, status every 60s)
    const progress = this.startProgressUpdates(chatId, startTime);

    try {
      // Check in-memory first, then fall back to persisted session (survives restarts)
      let sessionId = this.userSessions.get(userId);
      if (!sessionId) {
        const persisted = this.memory.getLastSession(userId);
        if (persisted) {
          sessionId = persisted.sessionId;
          info("telegram", `Restored session ${sessionId} for user ${userId} from disk`);
        }
      }

      const model = state.modelOverride;
      let result = await this.agent.run(text, {
        sessionId,
        model,
        signal: abortController.signal,
      });

      // If the run failed with a session, retry without it (stale session recovery)
      if (result.isError && sessionId && !abortController.signal.aborted) {
        info("telegram", `Retrying without session for user ${userId} (stale session)`);
        this.userSessions.delete(userId);
        result = await this.agent.run(text, { model, signal: abortController.signal });
      }

      if (result.sessionId) {
        this.userSessions.set(userId, result.sessionId);
      }

      this.memory.recordSession(result.sessionId, userId, text);
      this.recordResponseTime(Date.now() - startTime);

      // Track cost
      state.totalCostUsd += result.totalCostUsd;
      state.requestCount++;

      await progress.stop();
      await this.sendResponse(chatId, result.text, result);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logError("telegram", `Agent run failed for user ${userId}: ${errMsg}`);
      await progress.stop();
      await this.bot.sendMessage(
        chatId,
        "Something went wrong processing your message. Please try again."
      );
    } finally {
      clearInterval(typingInterval);
      this.processingUsers.delete(userId);
      state.abortController = undefined;
    }
  }

  private async handleCallbackQuery(
    query: TelegramBot.CallbackQuery
  ): Promise<void> {
    const userId = query.from.id;
    const chatId = query.message?.chat.id;
    const data = query.data;

    if (!chatId || !data) {
      await this.bot.answerCallbackQuery(query.id);
      return;
    }

    if (!this.isAuthorized(userId)) {
      await this.bot.answerCallbackQuery(query.id, { text: "Unauthorized" });
      return;
    }

    await this.bot.answerCallbackQuery(query.id);

    if (data === "retry") {
      const state = this.getState(userId);
      if (state.lastPrompt) {
        await this.runAgent(chatId, userId, state.lastPrompt);
      } else {
        await this.bot.sendMessage(chatId, "No previous message to retry.");
      }
    } else if (data === "new_session") {
      this.userSessions.delete(userId);
      await this.bot.sendMessage(chatId, "Session cleared. Starting fresh.");
    } else if (data.startsWith("model:")) {
      const modelKey = data.substring(6);
      const state = this.getState(userId);
      if (modelKey === "default") {
        state.modelOverride = undefined;
        await this.bot.sendMessage(chatId, "Switched to default model.");
      } else if (VALID_MODELS[modelKey]) {
        state.modelOverride = VALID_MODELS[modelKey];
        await this.bot.sendMessage(chatId, `Switched to ${modelKey}.`);
      }
    }
  }

  private async handleCommand(
    chatId: number,
    userId: number,
    text: string
  ): Promise<void> {
    // Strip @botname suffix from commands (e.g. /status@mybot -> /status)
    const spaceIndex = text.indexOf(" ");
    const rawCommand = spaceIndex > 0 ? text.substring(0, spaceIndex) : text;
    const command = rawCommand.split("@")[0];
    const argText = spaceIndex > 0 ? text.substring(spaceIndex + 1) : "";

    switch (command) {
      case "/start":
        await this.bot.sendMessage(
          chatId,
          "Claude Agent is ready. Send me any message and I will process it with Claude.\n\n" +
            "Commands:\n" +
            "/new - Start fresh session\n" +
            "/cancel - Cancel current request\n" +
            "/retry - Re-run last prompt\n" +
            "/model - Switch Claude model\n" +
            "/cost - Show usage costs\n" +
            "/schedule - Manage scheduled tasks\n" +
            "/tasks - List scheduled tasks\n" +
            "/remember - Store a fact\n" +
            "/forget - Remove a fact\n" +
            "/memories - List all facts\n" +
            "/status - Show bot status"
        );
        break;

      case "/new":
        this.userSessions.delete(userId);
        await this.bot.sendMessage(chatId, "Session cleared. Starting fresh.");
        break;

      case "/cancel": {
        const state = this.getState(userId);
        if (state.abortController && this.processingUsers.has(userId)) {
          state.abortController.abort();
          await this.bot.sendMessage(chatId, "Cancelling current request...");
        } else {
          await this.bot.sendMessage(chatId, "Nothing to cancel.");
        }
        break;
      }

      case "/retry": {
        const state = this.getState(userId);
        if (!state.lastPrompt) {
          await this.bot.sendMessage(chatId, "No previous message to retry.");
          return;
        }
        await this.runAgent(chatId, userId, state.lastPrompt);
        break;
      }

      case "/model": {
        const modelKey = argText.trim().toLowerCase();
        const state = this.getState(userId);
        if (!modelKey) {
          const current = state.modelOverride
            ? Object.entries(VALID_MODELS).find(([, v]) => v === state.modelOverride)?.[0] ?? state.modelOverride
            : "default (sonnet)";
          await this.bot.sendMessage(chatId, `Current model: ${current}`, {
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "Opus", callback_data: "model:opus" },
                  { text: "Sonnet", callback_data: "model:sonnet" },
                  { text: "Haiku", callback_data: "model:haiku" },
                ],
                [{ text: "Reset to default", callback_data: "model:default" }],
              ],
            },
          });
          return;
        }
        if (modelKey === "default" || modelKey === "reset") {
          state.modelOverride = undefined;
          await this.bot.sendMessage(chatId, "Switched to default model.");
        } else if (VALID_MODELS[modelKey]) {
          state.modelOverride = VALID_MODELS[modelKey];
          await this.bot.sendMessage(chatId, `Switched to ${modelKey}.`);
        } else {
          await this.bot.sendMessage(
            chatId,
            `Unknown model. Options: ${Object.keys(VALID_MODELS).join(", ")}, default`
          );
        }
        break;
      }

      case "/cost": {
        const state = this.getState(userId);
        await this.bot.sendMessage(
          chatId,
          [
            `Total cost: $${state.totalCostUsd.toFixed(4)}`,
            `Requests: ${state.requestCount}`,
            state.requestCount > 0
              ? `Avg cost/request: $${(state.totalCostUsd / state.requestCount).toFixed(4)}`
              : "",
          ]
            .filter(Boolean)
            .join("\n")
        );
        break;
      }

      case "/schedule": {
        if (!this.scheduler) {
          await this.bot.sendMessage(chatId, "Scheduler not available.");
          return;
        }
        await this.handleScheduleCommand(chatId, argText);
        break;
      }

      case "/tasks": {
        if (!this.scheduler) {
          await this.bot.sendMessage(chatId, "Scheduler not available.");
          return;
        }
        const tasks = this.scheduler.list();
        if (tasks.length === 0) {
          await this.bot.sendMessage(chatId, "No scheduled tasks.");
        } else {
          const list = tasks
            .map(
              (t) =>
                `${t.enabled ? "+" : "-"} *${t.name}* (${t.id})\n  Schedule: \`${t.schedule}\`\n  Prompt: ${t.prompt.slice(0, 80)}${t.prompt.length > 80 ? "..." : ""}`
            )
            .join("\n\n");
          await this.bot.sendMessage(chatId, `Scheduled tasks:\n\n${list}`, {
            parse_mode: "Markdown",
          }).catch(() =>
            this.bot.sendMessage(chatId, `Scheduled tasks:\n\n${list}`)
          );
        }
        break;
      }

      case "/remember": {
        const eqIndex = argText.indexOf("=");
        if (eqIndex < 1) {
          await this.bot.sendMessage(chatId, "Usage: /remember key=value");
          return;
        }
        const key = sanitizeKey(argText.substring(0, eqIndex).trim());
        const value = argText.substring(eqIndex + 1).trim();
        if (!key || !value) {
          await this.bot.sendMessage(chatId, "Both key and value are required.");
          return;
        }
        this.memory.setFact(key, value);
        await this.bot.sendMessage(chatId, `Remembered: ${key}`);
        break;
      }

      case "/forget": {
        const key = sanitizeKey(argText.trim());
        if (this.memory.deleteFact(key)) {
          await this.bot.sendMessage(chatId, `Forgot: ${key}`);
        } else {
          await this.bot.sendMessage(chatId, `No memory found for: ${key}`);
        }
        break;
      }

      case "/memories": {
        const facts = this.memory.getAllFacts();
        const entries = Object.entries(facts);
        if (entries.length === 0) {
          await this.bot.sendMessage(chatId, "No memories stored.");
        } else {
          const list = entries.map(([k, v]) => `- ${k}: ${v}`).join("\n");
          await this.bot.sendMessage(chatId, `Memories:\n${list}`);
        }
        break;
      }

      case "/status": {
        const state = this.getState(userId);
        const model = state.modelOverride
          ? Object.entries(VALID_MODELS).find(([, v]) => v === state.modelOverride)?.[0] ?? "custom"
          : "default";
        await this.bot.sendMessage(
          chatId,
          [
            `Uptime: ${Math.floor(process.uptime())}s`,
            `Active sessions: ${this.userSessions.size}`,
            `Memories: ${Object.keys(this.memory.getAllFacts()).length}`,
            `Model: ${model}`,
            `Session cost: $${state.totalCostUsd.toFixed(4)}`,
            this.scheduler
              ? `Scheduled tasks: ${this.scheduler.list().length}`
              : "",
          ]
            .filter(Boolean)
            .join("\n")
        );
        break;
      }

      default:
        await this.bot.sendMessage(
          chatId,
          "Commands: /new /cancel /retry /model /cost /schedule /tasks /remember /forget /memories /status"
        );
    }
  }

  private async handleScheduleCommand(
    chatId: number,
    argText: string
  ): Promise<void> {
    if (!this.scheduler) return;

    const parts = argText.trim().split(/\s+/);
    const subcommand = parts[0]?.toLowerCase();

    if (!subcommand || subcommand === "help") {
      await this.bot.sendMessage(
        chatId,
        "Schedule commands:\n" +
          "/schedule add <id> <cron> <prompt> - Add a task\n" +
          "/schedule remove <id> - Remove a task\n" +
          "/schedule enable <id> - Enable a task\n" +
          "/schedule disable <id> - Disable a task\n\n" +
          'Example: /schedule add morning "0 9 * * *" Give me a morning briefing'
      );
      return;
    }

    if (subcommand === "add") {
      // /schedule add <id> <cron-in-quotes> <prompt>
      const rest = argText.substring(argText.indexOf("add") + 4).trim();
      const idMatch = rest.match(/^(\S+)\s+/);
      if (!idMatch) {
        await this.bot.sendMessage(chatId, "Usage: /schedule add <id> <cron> <prompt>");
        return;
      }
      const id = sanitizeKey(idMatch[1]);
      const afterId = rest.substring(idMatch[0].length);

      // Parse cron: either quoted or first 5 space-separated tokens
      let cronExpr: string;
      let prompt: string;
      const quoteMatch = afterId.match(/^"([^"]+)"\s+(.*)/s);
      if (quoteMatch) {
        cronExpr = quoteMatch[1];
        prompt = quoteMatch[2];
      } else {
        // Try 5-part cron
        const cronParts = afterId.split(/\s+/);
        if (cronParts.length < 6) {
          await this.bot.sendMessage(
            chatId,
            'Usage: /schedule add <id> "<cron>" <prompt>\nQuote the cron expression, e.g. "0 9 * * *"'
          );
          return;
        }
        cronExpr = cronParts.slice(0, 5).join(" ");
        prompt = cronParts.slice(5).join(" ");
      }

      try {
        this.scheduler.add({
          id,
          name: id,
          schedule: cronExpr,
          prompt,
          enabled: true,
        });
        await this.bot.sendMessage(chatId, `Scheduled task "${id}" with cron: ${cronExpr}`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await this.bot.sendMessage(chatId, `Failed: ${errMsg}`);
      }
      return;
    }

    if (subcommand === "remove" || subcommand === "delete") {
      const id = sanitizeKey(parts[1] ?? "");
      if (!id) {
        await this.bot.sendMessage(chatId, "Usage: /schedule remove <id>");
        return;
      }
      if (this.scheduler.remove(id)) {
        await this.bot.sendMessage(chatId, `Removed task: ${id}`);
      } else {
        await this.bot.sendMessage(chatId, `Task not found: ${id}`);
      }
      return;
    }

    if (subcommand === "enable" || subcommand === "disable") {
      const id = sanitizeKey(parts[1] ?? "");
      if (!id) {
        await this.bot.sendMessage(chatId, `Usage: /schedule ${subcommand} <id>`);
        return;
      }
      const tasks = this.scheduler.list();
      const task = tasks.find((t) => t.id === id);
      if (!task) {
        await this.bot.sendMessage(chatId, `Task not found: ${id}`);
        return;
      }
      task.enabled = subcommand === "enable";
      try {
        this.scheduler.add(task); // Re-add with updated enabled state
        await this.bot.sendMessage(
          chatId,
          `Task "${id}" ${subcommand === "enable" ? "enabled" : "disabled"}.`
        );
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await this.bot.sendMessage(chatId, `Failed: ${errMsg}`);
      }
      return;
    }

    await this.bot.sendMessage(chatId, "Unknown subcommand. Try /schedule help");
  }

  private async sendResponse(
    chatId: number,
    text: string,
    result?: AgentResult
  ): Promise<void> {
    // Build inline keyboard buttons
    const buttons: TelegramBot.InlineKeyboardButton[][] = [
      [
        { text: "Retry", callback_data: "retry" },
        { text: "New session", callback_data: "new_session" },
      ],
    ];

    const sendOpts: TelegramBot.SendMessageOptions = {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: buttons },
    };

    const sendPlainOpts: TelegramBot.SendMessageOptions = {
      reply_markup: { inline_keyboard: buttons },
    };

    // Append cost info as a subtle footer
    let footer = "";
    if (result && result.totalCostUsd > 0) {
      const dur = result.durationMs < 60000
        ? `${Math.round(result.durationMs / 1000)}s`
        : `${Math.round(result.durationMs / 60000)}m`;
      footer = `\n\n_${dur} | $${result.totalCostUsd.toFixed(4)}_`;
    }

    const fullText = text + footer;

    if (fullText.length <= MAX_MESSAGE_LENGTH) {
      await this.bot.sendMessage(chatId, fullText, sendOpts).catch(
        () => this.bot.sendMessage(chatId, text + footer, sendPlainOpts)
      );
      return;
    }

    const chunks: string[] = [];
    let remaining = fullText;
    while (remaining.length > 0) {
      if (remaining.length <= MAX_MESSAGE_LENGTH) {
        chunks.push(remaining);
        break;
      }

      let splitAt = remaining.lastIndexOf("\n", MAX_MESSAGE_LENGTH);
      if (splitAt < MAX_MESSAGE_LENGTH / 2) {
        splitAt = MAX_MESSAGE_LENGTH;
      }

      chunks.push(remaining.substring(0, splitAt));
      remaining = remaining.substring(splitAt);
    }

    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      const opts = isLast ? sendOpts : { parse_mode: "Markdown" as const };
      const plainOpts = isLast ? sendPlainOpts : {};
      await this.bot.sendMessage(chatId, chunks[i], opts).catch(
        () => this.bot.sendMessage(chatId, chunks[i], plainOpts)
      );
    }
  }

  async sendNotification(userId: number, message: string): Promise<void> {
    await this.bot.sendMessage(userId, message);
  }

  stop(): void {
    this.bot.stopPolling();
    info("telegram", "Bot stopped");
  }
}
