import TelegramBot from "node-telegram-bot-api";
import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Agent, AgentResult } from "./agent.js";
import type { SqliteStore } from "./persistence.js";
import type { Scheduler } from "./scheduler.js";
import type { VoiceService } from "./voice.js";
import { info, error as logError } from "./logger.js";
import { TelegramMediaService } from "./telegram-media.js";
import { TelegramProgressReporter } from "./telegram-progress.js";
import { renderCommandHelp } from "./telegram-commands.js";
import { metrics } from "./metrics.js";

const MAX_MESSAGE_LENGTH = 4096;
const RESPONSE_TIME_HISTORY = 20; // Track last N response times for ETA
const MAX_QUEUE_SIZE = 5;

// Telegram Bot API Location fields missing from @types/node-telegram-bot-api
interface TelegramLocation {
  latitude: number;
  longitude: number;
  horizontal_accuracy?: number;
  heading?: number;
  live_period?: number;
}

const VALID_MODELS: Record<string, string> = {
  opus: "claude-opus-4-6",
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5-20251001",
};

function sanitizeKey(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, "");
}

interface UserLocation {
  latitude: number;
  longitude: number;
  horizontalAccuracy?: number;
  heading?: number;
  timestamp: number;
  isLive: boolean;
  liveMessageId?: number; // Track which message carries the live session
}

interface UserState {
  lastPrompt?: string;
  lastChatId?: number;
  modelOverride?: string;
  totalCostUsd: number;
  requestCount: number;
  abortController?: AbortController;
  recentPhotos: Array<{ path: string; timestamp: number }>;
  tempFiles: string[];
  currentLocation?: UserLocation;
  messageQueue: Array<{ chatId: number; text: string }>;
  currentTaskStartMs?: number;
}

export class TelegramIntegration {
  private bot: TelegramBot;
  private botToken: string;
  private agent: Agent;
  private store: SqliteStore;
  private workDir: string;
  private scheduler?: Scheduler;
  private voiceService?: VoiceService;
  private allowedUsers: Set<number>;
  private userSessions: Map<number, string> = new Map();
  private processingUsers: Set<number> = new Set();
  private responseTimes: number[] = []; // Recent response durations in ms
  private userState: Map<number, UserState> = new Map();
  private media: TelegramMediaService;
  private progressReporter: TelegramProgressReporter;

  constructor(
    botToken: string,
    allowedUsers: number[],
    agent: Agent,
    store: SqliteStore,
    workDir: string,
    scheduler?: Scheduler,
    voiceService?: VoiceService
  ) {
    this.bot = new TelegramBot(botToken, { polling: true });
    this.botToken = botToken;
    this.agent = agent;
    this.store = store;
    this.workDir = workDir;
    this.scheduler = scheduler;
    this.voiceService = voiceService;
    this.allowedUsers = new Set(allowedUsers);
    this.media = new TelegramMediaService(this.bot, botToken);
    this.progressReporter = new TelegramProgressReporter(
      this.bot,
      () => this.getEtaText(),
      (startMs) => this.formatElapsed(startMs)
    );
  }

  private getState(userId: number): UserState {
    let state = this.userState.get(userId);
    if (!state) {
      state = { totalCostUsd: 0, requestCount: 0, recentPhotos: [], tempFiles: [], messageQueue: [] };
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

    // Live location updates arrive as edited messages
    this.bot.on("edited_message", (msg) => {
      this.handleLocationUpdate(msg).catch((err) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        logError("telegram", `Failed to handle edited message: ${errMsg}`);
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

  private isAuthorized(userId: number): boolean {
    if (this.allowedUsers.size === 0) return false;
    return this.allowedUsers.has(userId);
  }

  private async handleMessage(msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;

    // Handle text messages and file uploads (caption is text for file messages)
    let text = msg.text ?? msg.caption ?? "";

    // If a document is attached, download it and prepend its content
    if (msg.document) {
      const content = await this.media.downloadText(msg.document.file_id);
      if (content) {
        const fileName = msg.document.file_name ?? "uploaded_file";
        text = `[File: ${fileName}]\n\`\`\`\n${content}\n\`\`\`\n\n${text}`.trim();
      }
    }

    // Handle photo messages — download largest version and describe as image context
    if (msg.photo && msg.photo.length > 0) {
      const largest = msg.photo[msg.photo.length - 1];
      const downloaded = await this.media.downloadBuffer(largest.file_id);
      if (downloaded) {
        const ext = downloaded.path.split(".").pop() ?? "jpg";
        const tmpPath = this.media.saveTemp("telegram_photo", ext, downloaded.buffer);
        const state = this.getState(userId!);
        state.tempFiles.push(tmpPath);
        state.recentPhotos.push({ path: tmpPath, timestamp: Date.now() });
        const thirtyMinAgo = Date.now() - 30 * 60 * 1000;
        state.recentPhotos = state.recentPhotos
          .filter(p => p.timestamp > thirtyMinAgo)
          .slice(-10);
        const captionHint = text ? `\nUser caption: "${text}"` : "";
        text = `[Photo uploaded: ${tmpPath}]\nThe user sent a photo. Use the Read tool to view it at the path above. If the image contains text, extract it verbatim. Note: Telegram compresses photos — if OCR quality is poor, ask the user to resend using "Send as File" for lossless quality.${captionHint}`.trim();
      }
      if (!text) text = "What's in this image?";
    }

    // Handle voice messages — download and save for the agent to process
    if (msg.voice) {
      const downloaded = await this.media.downloadBuffer(msg.voice.file_id);
      if (downloaded) {
        const tmpPath = this.media.saveTemp("telegram_voice", "ogg", downloaded.buffer);
        const state = this.getState(userId!);
        state.tempFiles.push(tmpPath);
        text = `[Voice message: ${tmpPath}, duration: ${msg.voice.duration}s]\nThe user sent a voice message. Use the Bash tool to transcribe or process it.\n\n${text}`.trim();
      }
      if (!text) text = "Please process this voice message.";
    }

    // Handle location sharing (one-off or live location start)
    if (msg.location) {
      const rawLoc = msg.location as TelegramLocation;
      const loc: UserLocation = {
        latitude: rawLoc.latitude,
        longitude: rawLoc.longitude,
        horizontalAccuracy: rawLoc.horizontal_accuracy,
        heading: rawLoc.heading,
        timestamp: Date.now(),
        isLive: !!rawLoc.live_period,
        liveMessageId: rawLoc.live_period ? msg.message_id : undefined,
      };
      if (userId) {
        const state = this.getState(userId);
        state.currentLocation = loc;
        this.persistLocation(loc);
        const liveLabel = loc.isLive ? " (live)" : "";
        info("telegram", `Location${liveLabel} from user ${userId}: ${loc.latitude}, ${loc.longitude}`);
      }
      if (!text) {
        // Pure location share with no caption — acknowledge silently, don't run agent
        await this.bot.sendMessage(chatId, loc.isLive
          ? `Live location tracking started. I'll keep your position updated.`
          : `Location received: ${loc.latitude.toFixed(4)}, ${loc.longitude.toFixed(4)}`);
        return;
      }
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
      metrics.increment("telegram.unauthorized");
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
    // Queue message if agent is already busy for this user
    if (this.processingUsers.has(userId)) {
      const state = this.getState(userId);
      if (state.messageQueue.length >= MAX_QUEUE_SIZE) {
        await this.bot.sendMessage(
          chatId,
          `Queue full (${MAX_QUEUE_SIZE} pending). Wait for the current task or /cancel it.`
        );
        return;
      }
      state.messageQueue.push({ chatId, text });
      const pos = state.messageQueue.length;
      const elapsed = state.currentTaskStartMs
        ? this.formatElapsed(state.currentTaskStartMs)
        : "?";
      const currentPrompt = state.lastPrompt
        ? state.lastPrompt.slice(0, 80) + (state.lastPrompt.length > 80 ? "..." : "")
        : "unknown";
      await this.bot.sendMessage(
        chatId,
        `⏳ Currently working on: "${currentPrompt}"\n` +
          `Elapsed: ${elapsed}\n\n` +
          `Your message is queued (${pos} pending). I'll get to it next.`
      );
      return;
    }

    const state = this.getState(userId);
    state.lastPrompt = text;
    state.lastChatId = chatId;

    this.processingUsers.add(userId);
    metrics.setGauge("telegram.processing_users", this.processingUsers.size);
    const startTime = Date.now();
    state.currentTaskStartMs = startTime;
    const abortController = new AbortController();
    state.abortController = abortController;

    // Send typing indicator every 4 seconds until we're done
    const typingInterval = setInterval(() => {
      this.bot.sendChatAction(chatId, "typing").catch(() => {});
    }, 4000);
    await this.bot.sendChatAction(chatId, "typing");

    // Start progress updates (ack after 3s, status every 60s)
    const progress = this.progressReporter.start(chatId, startTime);

    try {
      // Use in-memory session if available, otherwise restore from SQLite (survives restarts)
      const sessionId = this.userSessions.get(userId) ?? this.store.getRecentSession(userId)?.sessionId;

      const model = state.modelOverride;
      const toolNames: Record<string, string> = {
        Bash: "running command", Read: "reading file", Write: "writing file",
        Edit: "editing file", Glob: "searching files", Grep: "searching code",
        WebSearch: "searching web", WebFetch: "fetching page", Task: "delegating task",
      };
      const onActivity = (event: { tool?: string; text?: string }): void => {
        if (event.tool) {
          const friendly = event.tool.startsWith("mcp__") ? `using ${event.tool.split("__")[1]}` : toolNames[event.tool] ?? `using ${event.tool}`;
          progress.setActivity(friendly);
        }
      };
      let result = await this.agent.run(text, {
        sessionId,
        model,
        signal: abortController.signal,
        userId,
        onActivity,
      });

      // If the run failed with a session, retry without it (stale session recovery)
      if (result.isError && sessionId && !abortController.signal.aborted) {
        info("telegram", `Retrying without session for user ${userId} (stale session)`);
        this.userSessions.delete(userId);
        result = await this.agent.run(text, { model, signal: abortController.signal, userId, onActivity });
      }

      if (result.sessionId) {
        this.userSessions.set(userId, result.sessionId);
      }

      // Only record sessions with valid session IDs (for analytics, not resumption)
      if (result.sessionId) {
        this.store.recordSession(result.sessionId, userId, text, {
          totalCostUsd: result.totalCostUsd,
        });
      }
      this.recordResponseTime(Date.now() - startTime);

      // Track cost
      state.totalCostUsd += result.totalCostUsd;
      state.requestCount++;
      metrics.increment("telegram.requests.completed");

      await progress.stop();
      await this.sendResponse(chatId, result.text, result);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logError("telegram", `Agent run failed for user ${userId}: ${errMsg}`);
      metrics.increment("telegram.requests.failed");
      await progress.stop();

      let userMessage: string;
      if (/timeout|ETIMEDOUT|timed out/i.test(errMsg)) {
        userMessage = "Request timed out. Try a shorter request or start a /new session.";
      } else if (/rate limit|429|529|overloaded/i.test(errMsg)) {
        userMessage = "Rate limited. Please wait a few minutes and try again.";
      } else if (/ECONNRESET|ECONNREFUSED|socket hang up/i.test(errMsg)) {
        userMessage = "Connection error — usually temporary, please retry.";
      } else {
        userMessage = "Something went wrong processing your message. Please try again.";
      }

      await this.bot.sendMessage(chatId, userMessage, {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "Retry", callback_data: "retry" },
              { text: "New session", callback_data: "new_session" },
            ],
          ],
        },
      });
    } finally {
      clearInterval(typingInterval);
      this.processingUsers.delete(userId);
      metrics.setGauge("telegram.processing_users", this.processingUsers.size);
      state.abortController = undefined;
      state.currentTaskStartMs = undefined;

      // Clean up temp files (photos, voice messages)
      for (const tmpPath of state.tempFiles) {
        try { unlinkSync(tmpPath); } catch { /* already deleted */ }
      }
      state.tempFiles = [];

      // Drain queued messages — batch into a single prompt
      this.drainQueue(userId).catch((err) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        logError("telegram", `Failed to drain queue for user ${userId}: ${errMsg}`);
      });
    }
  }

  /**
   * Drain queued messages for a user by batching them into a single agent run.
   * Called after the current run finishes (in the finally block).
   */
  private async drainQueue(userId: number): Promise<void> {
    const state = this.getState(userId);
    if (state.messageQueue.length === 0) return;

    // Take all queued messages and clear the queue
    const queued = state.messageQueue.splice(0);
    const chatId = queued[queued.length - 1].chatId;

    // Batch into a single prompt
    let batchedText: string;
    if (queued.length === 1) {
      batchedText = queued[0].text;
    } else {
      batchedText = queued
        .map((m, i) => `[Message ${i + 1}]: ${m.text}`)
        .join("\n\n");
    }

    info("telegram", `Draining ${queued.length} queued message(s) for user ${userId}`);
    await this.runAgent(chatId, userId, batchedText);
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
      const state = this.getState(userId);
      state.messageQueue = [];
      this.userSessions.delete(userId);
      await this.bot.sendMessage(chatId, "Session cleared. Starting fresh.");
    } else if (data.startsWith("model:")) {
      const modelKey = data.substring(6);
      const state = this.getState(userId);
      if (modelKey === "default") {
        state.modelOverride = undefined;
        this.agent.resetSession(userId);
        await this.bot.sendMessage(chatId, "Switched to default model.");
      } else if (VALID_MODELS[modelKey]) {
        state.modelOverride = VALID_MODELS[modelKey];
        this.agent.resetSession(userId);
        await this.bot.sendMessage(chatId, `Switched to ${modelKey}.`);
      }
    }
  }

  /** Handle live location updates (arrive as edited_message events). */
  private async handleLocationUpdate(msg: TelegramBot.Message): Promise<void> {
    if (!msg.location || !msg.from?.id) return;
    const userId = msg.from.id;

    if (!this.isAuthorized(userId)) return;

    const state = this.getState(userId);
    const rawLoc = msg.location as TelegramLocation;
    const loc: UserLocation = {
      latitude: rawLoc.latitude,
      longitude: rawLoc.longitude,
      horizontalAccuracy: rawLoc.horizontal_accuracy,
      heading: rawLoc.heading,
      timestamp: Date.now(),
      isLive: true,
      liveMessageId: msg.message_id,
    };
    state.currentLocation = loc;
    this.persistLocation(loc);
  }

  /** Persist location to a JSON file so the agent can reference it. */
  private persistLocation(loc: UserLocation): void {
    const utcDate = new Date(loc.timestamp);
    const value = JSON.stringify({
      lat: loc.latitude,
      lon: loc.longitude,
      accuracy: loc.horizontalAccuracy,
      heading: loc.heading,
      live: loc.isLive,
      at: utcDate.toISOString(),
      localTime: utcDate.toLocaleString("en-AU", { timeZone: "Australia/Melbourne", dateStyle: "medium", timeStyle: "short" }),
    });
    writeFileSync(join(this.workDir, "current-location.json"), value);
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
            renderCommandHelp()
        );
        break;

      case "/new": {
        const state = this.getState(userId);
        const dropped = state.messageQueue.length;
        state.messageQueue = [];
        this.userSessions.delete(userId);
        this.agent.resetSession(userId);
        await this.bot.sendMessage(
          chatId,
          dropped > 0
            ? `Session cleared (${dropped} queued message${dropped > 1 ? "s" : ""} discarded). Starting fresh.`
            : "Session cleared. Starting fresh."
        );
        break;
      }

      case "/cancel": {
        const state = this.getState(userId);
        const dropped = state.messageQueue.length;
        state.messageQueue = [];
        if (state.abortController && this.processingUsers.has(userId)) {
          state.abortController.abort();
          await this.bot.sendMessage(
            chatId,
            dropped > 0
              ? `Cancelling current request and ${dropped} queued message${dropped > 1 ? "s" : ""}...`
              : "Cancelling current request..."
          );
        } else if (dropped > 0) {
          await this.bot.sendMessage(chatId, `Cleared ${dropped} queued message${dropped > 1 ? "s" : ""}.`);
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
          this.agent.resetSession(userId);
          await this.bot.sendMessage(chatId, "Switched to default model.");
        } else if (VALID_MODELS[modelKey]) {
          state.modelOverride = VALID_MODELS[modelKey];
          this.agent.resetSession(userId);
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

      case "/post": {
        const state = this.getState(userId);
        const thirtyMinAgo = Date.now() - 30 * 60 * 1000;
        const photos = state.recentPhotos.filter(p => p.timestamp > thirtyMinAgo);

        if (photos.length === 0) {
          await this.bot.sendMessage(
            chatId,
            "No recent photos found. Send one or more photos first, then use /post."
          );
          return;
        }

        const photoList = photos.map(p => p.path).join("\n");
        const userNotes = argText.trim();

        const melbourneTime = new Date().toLocaleString("en-AU", {
          timeZone: "Australia/Melbourne",
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          hour12: true,
        });

        const prompt = [
          "## Facebook Post Workflow",
          "",
          `Current Melbourne time: ${melbourneTime}`,
          "",
          "The user wants to create a Facebook post for their configured Facebook Page.",
          "Follow these steps IN ORDER:",
          "",
          "### Step 1: Analyze the photos",
          `The following ${photos.length} photo(s) were uploaded:`,
          photoList,
          "Use the Read tool to view each photo and understand what is shown.",
          "",
          "### Step 2: Check calendar for current event context",
          "Run: python3 /home/ubuntu/agent/.claude/skills/google-calendar/scripts/ical_fetch.py --days 1",
          "Check if the user is CURRENTLY AT an event (i.e. the event's start time has passed and end time hasn't).",
          "ONLY use event details (name, location, description) if the current time falls within an event's time range.",
          "If there is no current event, do NOT guess or assume location/event context — rely solely on the photos and user notes.",
          "",
          "### Step 3: Optimize photos for Facebook",
          "Optimize all photos in a single batch command (handles EXIF rotation, exposure, saturation, contrast, smart crop, sharpening).",
          `Use mode '${photos.length === 1 ? "single" : "multi"}' (single = 4:5 portrait 1080x1350, multi = 1:1 square 1080x1080).`,
          "Run this single command to process all photos at once:",
          `node /home/ubuntu/agent/.claude/skills/facebook/scripts/optimize_photo.mjs --mode ${photos.length === 1 ? "single" : "multi"} --batch '${JSON.stringify(photos.map((p, i) => ({ input: p.path, output: `/tmp/fb_post_${i + 1}.jpg` })))}'`,
          "Check the JSON output — each result shows adjustments made (brightness, saturation, contrast, crop). Report these to the user in Step 5.",
          "",
          "### Step 4: Generate post text",
          "Write engaging Facebook post text suitable for the page owner.",
          "Tone: warm, community-focused, professional but approachable.",
          "Only reference event/location details if confirmed from a current calendar event in Step 2.",
          "Do NOT use hashtags excessively (1-2 max if appropriate).",
          userNotes ? `\nUser's notes/context: ${userNotes}` : "",
          "",
          "### Step 5: Present for approval",
          "Show the user:",
          "- The generated post text",
          "- Confirm which photos will be posted (mention count)",
          "- Ask: 'Ready to post? Reply YES to publish, or tell me what to change.'",
          "",
          "DO NOT post to Facebook yet. Wait for explicit approval.",
          "When the user approves, run:",
          "python3 /home/ubuntu/agent/.claude/skills/facebook/scripts/post_photos.py --message 'THE_TEXT' --photos /tmp/fb_post_1.jpg /tmp/fb_post_2.jpg ...",
        ].join("\n");

        state.recentPhotos = [];
        await this.runAgent(chatId, userId, prompt);
        break;
      }

      case "/call": {
        if (!this.voiceService?.isAvailable()) {
          await this.bot.sendMessage(
            chatId,
            "Voice calling is not configured. Set VAPI_API_KEY and VAPI_PHONE_NUMBER_ID in .env"
          );
          return;
        }

        if (!argText.trim()) {
          await this.bot.sendMessage(
            chatId,
            "Usage: /call <name or +number> [context]\nExample: /call Sean Ask about dinner\nExample: /call +61412345678 Remind about the meeting"
          );
          return;
        }

        // Parse: first arg is phone number or contact name, rest is context
        const callParts = argText.trim().split(/\s+/);
        const firstArg = callParts[0];

        // If first arg is E.164, use it directly
        if (/^\+\d{7,15}$/.test(firstArg)) {
          const callContext = callParts.slice(1).join(" ") || undefined;
          await this.bot.sendMessage(chatId, `Calling ${firstArg}...`);
          try {
            const result = await this.voiceService.makeCall({
              phoneNumber: firstArg,
              context: callContext,
              userId,
            });
            if (result.status === "failed") {
              await this.bot.sendMessage(
                chatId,
                `Call failed: ${result.error ?? "unknown error"}`
              );
            }
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            await this.bot.sendMessage(chatId, `Call failed: ${errMsg}`);
          }
        } else {
          // Not a phone number — pass to agent for contact lookup + call
          await this.runAgent(chatId, userId, `Call ${argText.trim()}`);
        }
        break;
      }

      default:
        await this.bot.sendMessage(
          chatId,
          `Commands:\n${renderCommandHelp()}`
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
      let rateLimitNote = "";
      if (result.rateLimit) {
        const rl = result.rateLimit;
        if (rl.status === "allowed_warning") {
          const pct = Math.round((rl.utilization ?? 0) * 100);
          rateLimitNote = ` | ⚠️ ${pct}% usage`;
          if (rl.resetsAt) {
            const mins = Math.max(1, Math.round((rl.resetsAt - Date.now() / 1000) / 60));
            rateLimitNote += ` (resets ${mins}m)`;
          }
        } else if (rl.status === "rejected") {
          rateLimitNote = " | 🚫 rate limited";
          if (rl.resetsAt) {
            const mins = Math.max(1, Math.round((rl.resetsAt - Date.now() / 1000) / 60));
            rateLimitNote += ` (resets ${mins}m)`;
          }
        }
        if (rl.isUsingOverage) {
          rateLimitNote += " | 💸 overage";
        }
      }
      footer = `\n\n_${dur} | $${result.totalCostUsd.toFixed(4)}${rateLimitNote}_`;
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
