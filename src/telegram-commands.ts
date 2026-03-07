import type TelegramBot from "node-telegram-bot-api";
import type { Agent } from "./agent.js";
import type { Memory } from "./memory.js";
import type { Scheduler } from "./scheduler.js";

export interface TelegramCommandContext {
  bot: TelegramBot;
  memory: Memory;
  scheduler?: Scheduler;
  agent: Agent;
}

export interface TelegramCommandHandler {
  name: string;
  description: string;
}

export const TELEGRAM_COMMANDS: TelegramCommandHandler[] = [
  { name: "/new", description: "Start fresh session" },
  { name: "/cancel", description: "Cancel current request" },
  { name: "/retry", description: "Re-run last prompt" },
  { name: "/model", description: "Switch Claude model" },
  { name: "/cost", description: "Show usage costs" },
  { name: "/schedule", description: "Manage scheduled tasks" },
  { name: "/tasks", description: "List scheduled tasks" },
  { name: "/remember", description: "Store a fact" },
  { name: "/forget", description: "Remove a fact" },
  { name: "/memories", description: "List all facts" },
  { name: "/status", description: "Show bot status" },
  { name: "/post", description: "Create a Facebook post with recent photos" },
];

export function renderCommandHelp(): string {
  return TELEGRAM_COMMANDS.map((command) => `${command.name} - ${command.description}`).join("\n");
}
