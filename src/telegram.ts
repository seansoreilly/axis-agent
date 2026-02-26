import TelegramBot from "node-telegram-bot-api";
import type { Agent } from "./agent.js";
import type { Memory } from "./memory.js";
import { info, error as logError } from "./logger.js";

const MAX_MESSAGE_LENGTH = 4096;

function sanitizeKey(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, "");
}

export class TelegramIntegration {
  private bot: TelegramBot;
  private agent: Agent;
  private memory: Memory;
  private allowedUsers: Set<number>;
  private userSessions: Map<number, string> = new Map();

  constructor(
    botToken: string,
    allowedUsers: number[],
    agent: Agent,
    memory: Memory
  ) {
    this.bot = new TelegramBot(botToken, { polling: true });
    this.agent = agent;
    this.memory = memory;
    this.allowedUsers = new Set(allowedUsers);
  }

  start(): void {
    this.bot.on("message", (msg) => {
      this.handleMessage(msg).catch((err) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        logError("telegram", `Failed to handle message: ${errMsg}`);
      });
    });

    info("telegram", "Bot started (polling mode)");
  }

  private isAuthorized(userId: number): boolean {
    if (this.allowedUsers.size === 0) return false;
    return this.allowedUsers.has(userId);
  }

  private async handleMessage(msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    const text = msg.text;

    if (!userId || !text) return;

    if (!this.isAuthorized(userId)) {
      await this.bot.sendMessage(chatId, "Unauthorized.");
      return;
    }

    if (text.startsWith("/")) {
      await this.handleCommand(chatId, userId, text);
      return;
    }

    await this.bot.sendChatAction(chatId, "typing");

    const sessionId = this.userSessions.get(userId);
    const result = await this.agent.run(text, { sessionId });

    if (result.sessionId) {
      this.userSessions.set(userId, result.sessionId);
    }

    this.memory.recordSession(result.sessionId, userId, text);

    await this.sendResponse(chatId, result.text);
  }

  private async handleCommand(
    chatId: number,
    userId: number,
    text: string
  ): Promise<void> {
    const spaceIndex = text.indexOf(" ");
    const command = spaceIndex > 0 ? text.substring(0, spaceIndex) : text;
    const argText = spaceIndex > 0 ? text.substring(spaceIndex + 1) : "";

    switch (command) {
      case "/start":
        await this.bot.sendMessage(
          chatId,
          "Claude Agent is ready. Send me any message and I will process it with Claude."
        );
        break;

      case "/new":
        this.userSessions.delete(userId);
        await this.bot.sendMessage(chatId, "Session cleared. Starting fresh.");
        break;

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

      case "/status":
        await this.bot.sendMessage(
          chatId,
          [
            `Uptime: ${Math.floor(process.uptime())}s`,
            `Active sessions: ${this.userSessions.size}`,
            `Memories: ${Object.keys(this.memory.getAllFacts()).length}`,
          ].join("\n")
        );
        break;

      default:
        await this.bot.sendMessage(
          chatId,
          "Commands: /new /remember /forget /memories /status"
        );
    }
  }

  private async sendResponse(chatId: number, text: string): Promise<void> {
    if (text.length <= MAX_MESSAGE_LENGTH) {
      await this.bot.sendMessage(chatId, text, { parse_mode: "Markdown" }).catch(
        () => this.bot.sendMessage(chatId, text)
      );
      return;
    }

    const chunks: string[] = [];
    let remaining = text;
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

    for (const chunk of chunks) {
      await this.bot.sendMessage(chatId, chunk, { parse_mode: "Markdown" }).catch(
        () => this.bot.sendMessage(chatId, chunk)
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
