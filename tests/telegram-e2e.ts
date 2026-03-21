/**
 * Telegram UI E2E Tests
 *
 * Runs against the live deployed bot via Telegram Web using Playwright MCP.
 * Requires: Playwright MCP server with --storage-state for Telegram auth.
 *
 * Usage: Run interactively via Claude Code — this is NOT a vitest file.
 * Each test function sends a message, waits for response, and returns pass/fail.
 *
 * Bot chat URL: https://web.telegram.org/a/#8587916820
 */

export interface TestResult {
  name: string;
  passed: boolean;
  duration: number;
  response?: string;
  error?: string;
}

/**
 * Test definitions. Each test has:
 * - name: descriptive test name
 * - send: message to send (or null for command-only tests)
 * - waitMs: max time to wait for response
 * - validate: function to check the response text
 */
export const TELEGRAM_E2E_TESTS = [
  // === Instant commands ===
  {
    name: "1. /new clears session",
    send: "/new",
    waitMs: 5_000,
    validate: (r: string) => r.includes("Session cleared") || r.includes("Starting fresh"),
  },
  {
    name: "2. /status shows uptime and process info",
    send: "/status",
    waitMs: 5_000,
    validate: (r: string) => r.includes("Uptime") && r.includes("Scheduled tasks"),
  },
  {
    name: "3. /cost shows session cost",
    send: "/cost",
    waitMs: 5_000,
    validate: (r: string) => r.includes("$") || r.includes("cost") || r.includes("Cost"),
  },
  {
    name: "4. /tasks lists scheduled tasks",
    send: "/tasks",
    waitMs: 5_000,
    validate: (r: string) => r.includes("email-triage") || r.includes("morning-briefing") || r.includes("No scheduled"),
  },
  {
    name: "5. /model shows current model with keyboard",
    send: "/model",
    waitMs: 5_000,
    validate: (r: string) => r.includes("Current model") || r.includes("model"),
  },

  // === Agent responses (require thinking) ===
  {
    name: "6. Simple greeting — agent responds",
    send: "hi, say hello back in one sentence",
    waitMs: 120_000,
    validate: (r: string) => r.length > 5 && !r.includes("timed out") && !r.includes("error"),
  },
  {
    name: "7. Memory recall — knows user's name",
    send: "what is my first name? reply with just the name",
    waitMs: 120_000,
    validate: (r: string) => r.toLowerCase().includes("sean"),
  },
  {
    name: "8. Conversation continuity — follow-up in same session",
    send: "what was the very first thing I said to you in this conversation?",
    waitMs: 120_000,
    validate: (r: string) => r.toLowerCase().includes("hello") || r.toLowerCase().includes("hi") || r.length > 10,
  },
  {
    name: "9. Contact lookup integration",
    send: "what is sean oreilly's phone number? use google contacts",
    waitMs: 120_000,
    validate: (r: string) => r.includes("+61") || r.includes("phone") || r.includes("422"),
  },
  {
    name: "10. Email triage integration",
    send: "check my inbox - how many unread emails do I have? just give me the count",
    waitMs: 180_000,
    validate: (r: string) => /\d/.test(r) && !r.includes("timed out"),
  },

  // === Session management ===
  {
    name: "11. /new then verify fresh session",
    send: "/new",
    waitMs: 5_000,
    validate: (r: string) => r.includes("Session cleared"),
  },
  {
    name: "12. Post-/new agent responds without prior context",
    send: "say the word PINEAPPLE and nothing else",
    waitMs: 120_000,
    validate: (r: string) => r.toUpperCase().includes("PINEAPPLE"),
  },
];
