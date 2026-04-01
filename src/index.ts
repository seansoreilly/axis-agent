import { join } from "node:path";
import { loadConfig } from "./config.js";
import { Agent } from "./agent.js";
import { Scheduler } from "./scheduler.js";
import { TelegramIntegration } from "./telegram.js";
import { createGateway } from "./gateway.js";
import { info, error as logError } from "./logger.js";
import { errorMessage } from "./utils.js";
import { ensureValidToken, startTokenRefreshTimer } from "./auth.js";
import { SqliteStore } from "./persistence.js";
import { JobService } from "./jobs.js";
import { metrics } from "./metrics.js";
import { preflight } from "./preflight.js";
import { IdentityManager } from "./identity.js";
import { TranscriptLogger } from "./transcript.js";
import { ReflectionService } from "./reflection.js";
import type { VoiceService as VoiceServiceType } from "./voice.js";

async function main(): Promise<void> {
  info("main", "Starting Axis Agent...");

  // Ensure OAuth token is valid before starting
  const tokenOk = await ensureValidToken();
  if (!tokenOk) {
    logError("main", "OAuth token refresh failed — agent may not work until credentials are renewed");
  }

  const config = loadConfig();

  // Run preflight health checks (non-fatal — logs warnings for failures)
  const preflightResult = await preflight({
    memoryDir: config.memoryDir,
    workDir: config.claude.workDir,
    telegramBotToken: config.telegram.botToken,
  });
  if (!preflightResult.ok) {
    logError("main", "Preflight checks had failures — continuing with degraded functionality");
  }

  const store = new SqliteStore(config.memoryDir);
  const identity = new IdentityManager(config.claude.workDir);
  const transcriptLogger = new TranscriptLogger(join(config.memoryDir, "transcripts"));
  const agent = new Agent(config, store, identity);
  const jobs = new JobService({ store, agent });

  const reflectionStorePath = join(config.memoryDir, "reflections.jsonl");
  const reflection = new ReflectionService({
    reflectAgent: async (prompt: string) => {
      const result = await agent.run(prompt, { timeoutMs: 30_000 });
      return { text: result.text, isError: result.isError };
    },
    storePath: reflectionStorePath,
  });

  // Set up scheduler with Telegram notifications (created before telegram so we can pass it)
  let telegram: TelegramIntegration;
  const primaryUser = config.telegram.allowedUsers[0];
  const scheduler = new Scheduler(
    agent,
    (taskId, result) => {
      if (primaryUser && telegram) {
        telegram
          .sendNotification(
            primaryUser,
            `Scheduled task [${taskId}]:\n${result}`
          )
          .catch((err) => {
            const msg = errorMessage(err);
            logError("scheduler", `Failed to send notification: ${msg}`);
          });
      }
    },
    config.memoryDir,
    jobs
  );

  // Set up voice calling (optional — disabled if RETELL_API_KEY not set)
  let voiceService: VoiceServiceType | undefined;
  if (config.retell) {
    const { VoiceService } = await import("./voice.js");
    voiceService = new VoiceService(config.retell, (callId, status, result) => {
      if (primaryUser && telegram) {
        let msg: string;
        if (status === "completed") {
          const duration = result?.durationSeconds ?? 0;
          const lines = [`Call ${callId} completed (${duration}s)`];
          if (result?.transcript?.length) {
            lines.push("", "Transcript:");
            for (const entry of result.transcript) {
              const speaker = entry.role === "assistant" ? "Agent" : "Caller";
              lines.push(`${speaker}: ${entry.text}`);
            }
          }
          msg = lines.join("\n");
        } else if (status === "failed") {
          msg = `Call ${callId} failed: ${result?.error ?? "unknown"}`;
        } else {
          msg = `Call ${callId}: ${status}`;
        }
        telegram
          .sendNotification(primaryUser, msg)
          .catch((err) => {
            const errMsg = errorMessage(err);
            logError("voice", `Failed to send call notification: ${errMsg}`);
          });
      }
    });
    info("main", "Voice calling enabled");
  }

  // Set up Telegram integration (with scheduler and voice service)
  telegram = new TelegramIntegration(
    config.telegram.botToken,
    config.telegram.allowedUsers,
    agent,
    store,
    config.claude.workDir,
    scheduler,
    voiceService,
    transcriptLogger,
    reflection,
  );

  // Start Telegram bot
  telegram.start();

  // Start HTTP gateway
  const gateway = await createGateway({
    port: config.server.port,
    agent,
    scheduler,
    jobs,
    store,
    workDir: config.claude.workDir,
    owntracksToken: config.owntracksToken,
    gatewayApiToken: config.gatewayApiToken,
    voiceService,
    onInboundSms: (from, body) => {
      if (primaryUser && telegram) {
        telegram
          .sendNotification(primaryUser, `📱 SMS from ${from}:\n${body}`)
          .catch((err) => {
            const msg = errorMessage(err);
            logError("gateway", `Failed to forward SMS notification: ${msg}`);
          });
      }
    },
  });

  // Recover any stuck jobs from a previous crash
  const recoveredCount = jobs.recoverStuckJobs();
  if (recoveredCount > 0) {
    info("main", `Recovered ${recoveredCount} stuck job(s) at startup`);
  }

  // Periodically check for stuck jobs (every 5 minutes)
  const stuckJobInterval = setInterval(() => {
    const count = jobs.recoverStuckJobs();
    if (count > 0) {
      info("main", `Recovered ${count} stuck job(s)`);
    }
  }, 5 * 60 * 1000);

  // Start periodic token refresh (every 30 minutes)
  const tokenRefreshTimer = startTokenRefreshTimer();
  metrics.setGauge("service.started", Date.now());

  info("main", "All systems running.");

  // Graceful shutdown
  const shutdown = (): void => {
    info("main", "Shutting down...");
    clearInterval(stuckJobInterval);
    clearInterval(tokenRefreshTimer);
    telegram.stop();
    scheduler.stopAll();
    agent.shutdown();
    gateway.close().finally(() => process.exit(0));
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  const msg = errorMessage(err);
  logError("main", `Fatal: ${msg}`);
  process.exit(1);
});
