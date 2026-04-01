import { existsSync, mkdirSync } from "node:fs";

export interface RetellConfig {
  apiKey: string;
  phoneNumber: string; // E.164 format (e.g. "+14157774444")
  agentId: string; // Base Retell agent ID
  voiceId?: string; // Override default voice
}

export interface Config {
  telegram: {
    botToken: string;
    allowedUsers: number[];
  };
  server: {
    port: number;
  };
  claude: {
    model: string;
    maxTurns: number;
    maxBudgetUsd: number;
    workDir: string;
    agentTimeoutMs: number;
  };
  memoryDir: string;
  owntracksToken?: string;
  gatewayApiToken?: string;
  retell?: RetellConfig;
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

export function loadConfig(): Config {
  const memoryDir =
    process.env["MEMORY_DIR"] ?? "/home/ubuntu/.claude-agent/memory";
  const workDir =
    process.env["CLAUDE_WORK_DIR"] ?? "/home/ubuntu/workspace";

  // Ensure directories exist
  for (const dir of [memoryDir, workDir]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  const allowedUsers = (process.env["TELEGRAM_ALLOWED_USERS"] ?? "")
    .split(",")
    .filter(Boolean)
    .map(Number)
    .filter((n) => !Number.isNaN(n));

  if (allowedUsers.length === 0) {
    throw new Error(
      "TELEGRAM_ALLOWED_USERS must be set (comma-separated Telegram user IDs)"
    );
  }

  // Retell voice calling config (optional — feature disabled if RETELL_API_KEY not set)
  let retell: RetellConfig | undefined;
  const retellApiKey = process.env["RETELL_API_KEY"];
  if (retellApiKey) {
    retell = {
      apiKey: retellApiKey,
      phoneNumber: requireEnv("RETELL_PHONE_NUMBER"),
      agentId: requireEnv("RETELL_AGENT_ID"),
      voiceId: process.env["RETELL_VOICE_ID"],
    };
  }

  return {
    telegram: {
      botToken: requireEnv("TELEGRAM_BOT_TOKEN"),
      allowedUsers,
    },
    server: {
      port: Number(process.env["PORT"] ?? "8080"),
    },
    claude: {
      model: process.env["CLAUDE_MODEL"] ?? "claude-opus-4-6",
      maxTurns: Number(process.env["CLAUDE_MAX_TURNS"] ?? "25"),
      maxBudgetUsd: Number(process.env["CLAUDE_MAX_BUDGET_USD"] ?? "5"),
      workDir,
      agentTimeoutMs: Number(process.env["CLAUDE_AGENT_TIMEOUT_MS"] ?? "600000"),
    },
    memoryDir,
    owntracksToken: process.env["OWNTRACKS_TOKEN"],
    gatewayApiToken: process.env["GATEWAY_API_TOKEN"],
    retell,
  };
}
