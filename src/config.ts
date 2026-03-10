import { existsSync, mkdirSync } from "node:fs";

export interface VapiConfig {
  apiKey: string;
  phoneNumberId: string;
  assistantId?: string;
  dtmfToolId: string;
  ttsVoiceId?: string;
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
  };
  memoryDir: string;
  owntracksToken?: string;
  gatewayApiToken?: string;
  vapi?: VapiConfig;
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
    .map(Number);

  if (allowedUsers.length === 0) {
    throw new Error(
      "TELEGRAM_ALLOWED_USERS must be set (comma-separated Telegram user IDs)"
    );
  }

  // Vapi voice calling config (optional — feature disabled if VAPI_API_KEY not set)
  let vapi: VapiConfig | undefined;
  const vapiApiKey = process.env["VAPI_API_KEY"];
  if (vapiApiKey) {
    vapi = {
      apiKey: vapiApiKey,
      phoneNumberId: requireEnv("VAPI_PHONE_NUMBER_ID"),
      assistantId: process.env["VAPI_ASSISTANT_ID"],
      dtmfToolId: requireEnv("VAPI_DTMF_TOOL_ID"),
      ttsVoiceId: process.env["CARTESIA_VOICE_ID"],
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
      model: process.env["CLAUDE_MODEL"] ?? "claude-haiku-4-5-20251001",
      maxTurns: Number(process.env["CLAUDE_MAX_TURNS"] ?? "25"),
      maxBudgetUsd: Number(process.env["CLAUDE_MAX_BUDGET_USD"] ?? "5"),
      workDir,
    },
    memoryDir,
    owntracksToken: process.env["OWNTRACKS_TOKEN"],
    gatewayApiToken: process.env["GATEWAY_API_TOKEN"],
    vapi,
  };
}
