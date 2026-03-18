import { info } from "./logger.js";

/**
 * Blocked command patterns — commands that the agent should never execute.
 * Each entry is a regex pattern matched against the full command string.
 */
const BLOCKED_COMMAND_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
  { pattern: /\brm\s+(-[^\s]*\s+)*-rf\s+\/\s*$/,   description: "rm -rf /" },
  { pattern: /\brm\s+(-[^\s]*\s+)*-rf\s+\/\*\s*$/,  description: "rm -rf /*" },
  { pattern: /\bshutdown\b/,                          description: "shutdown" },
  { pattern: /\breboot\b/,                            description: "reboot" },
  { pattern: /\binit\s+0\b/,                          description: "init 0" },
  { pattern: /\bsystemctl\s+(halt|poweroff|reboot)\b/, description: "systemctl halt/poweroff/reboot" },
  { pattern: /\bmkfs\b/,                              description: "mkfs (format filesystem)" },
  { pattern: /\bdd\s.*\bof=\/dev\/[sh]d/,             description: "dd to block device" },
  { pattern: /:(){ :\|:& };:/,                        description: "fork bomb" },
  { pattern: /\bchmod\s+(-[^\s]+\s+)*777\s+\//,       description: "chmod 777 on root paths" },
  { pattern: /\biptables\s+-F\b/,                     description: "iptables flush (drops firewall rules)" },
  { pattern: /\bcurl\b.*\|\s*(sudo\s+)?bash\b/,       description: "curl | bash (remote code execution)" },
  { pattern: /\bwget\b.*\|\s*(sudo\s+)?bash\b/,       description: "wget | bash (remote code execution)" },
];

/**
 * Sensitive file patterns — files that must never be read or displayed to users.
 * These contain secrets (API keys, tokens, passwords) that should not be leaked.
 */
const SENSITIVE_FILE_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
  { pattern: /\.env$/,                                description: ".env files (contain API keys and tokens)" },
  { pattern: /\.env\.\w+$/,                           description: ".env.* files (contain secrets)" },
  { pattern: /credentials\.json$/,                    description: "credentials.json (OAuth/API credentials)" },
  { pattern: /\.credentials\.json$/,                  description: ".credentials.json (OAuth tokens)" },
  { pattern: /service.account.*\.json$/i,             description: "service account key files" },
  { pattern: /app_password.*\.json$/i,                description: "app password files" },
  { pattern: /\.pem$/,                                description: "PEM key files" },
  { pattern: /id_rsa$|id_ed25519$/,                   description: "SSH private keys" },
  { pattern: /token.*\.json$/i,                       description: "token files" },
];

/**
 * Check if a command matches any blocked pattern.
 * Returns the description of the matched rule, or null if allowed.
 */
export function checkBlockedCommand(command: string): string | null {
  for (const { pattern, description } of BLOCKED_COMMAND_PATTERNS) {
    if (pattern.test(command)) {
      return description;
    }
  }
  return null;
}

/**
 * Check if a file path matches any sensitive file pattern.
 * Returns the description of the matched rule, or null if allowed.
 */
export function checkSensitiveFile(filePath: string): string | null {
  for (const { pattern, description } of SENSITIVE_FILE_PATTERNS) {
    if (pattern.test(filePath)) {
      return description;
    }
  }
  return null;
}

/**
 * Build a policy constraints section for injection into the agent system prompt.
 * This provides soft enforcement — the agent is instructed to avoid these patterns.
 */
export function buildPolicyPromptSection(): string {
  const lines = [
    "## Security Policies",
    "",
    "The following commands are BLOCKED and must never be executed:",
    "",
  ];
  for (const { description } of BLOCKED_COMMAND_PATTERNS) {
    lines.push(`- ${description}`);
  }
  lines.push("");
  lines.push("The following files are SENSITIVE and must never be read, displayed, or shared:");
  lines.push("");
  for (const { description } of SENSITIVE_FILE_PATTERNS) {
    lines.push(`- ${description}`);
  }
  lines.push("");
  lines.push("If asked to show contents of sensitive files (.env, credentials, keys, tokens), REFUSE and explain that these contain secrets that cannot be disclosed. Never cat, read, or display the contents of these files in responses.");
  lines.push("");
  lines.push("Do not attempt to bypass these restrictions. If a task requires a blocked operation, explain why it cannot be done and suggest a safe alternative.");
  return lines.join("\n");
}

/** Log that a blocked command was attempted. */
export function logBlockedCommand(source: string, command: string, rule: string): void {
  info("policy", `BLOCKED ${source}: "${command}" matched rule: ${rule}`);
}
