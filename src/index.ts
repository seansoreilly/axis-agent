import { loadConfig } from "./config.js";
import { Agent } from "./agent.js";
import { Memory } from "./memory.js";
import { Scheduler } from "./scheduler.js";
import { TelegramIntegration } from "./telegram.js";
import { createGateway } from "./gateway.js";
import { info, error as logError } from "./logger.js";
import { ensureValidToken, startTokenRefreshTimer } from "./auth.js";
import { SqliteStore } from "./persistence.js";
import { JobService } from "./jobs.js";
import { metrics } from "./metrics.js";

async function main(): Promise<void> {
  info("main", "Starting Claude Code Agent...");

  // Ensure OAuth token is valid before starting
  const tokenOk = await ensureValidToken();
  if (!tokenOk) {
    logError("main", "OAuth token refresh failed — agent may not work until credentials are renewed");
  }

  const config = loadConfig();
  const store = new SqliteStore(config.memoryDir);
  const memory = new Memory(config.memoryDir);
  const agent = new Agent(config, memory);
  const jobs = new JobService({ store, agent });

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
            const msg = err instanceof Error ? err.message : String(err);
            logError("scheduler", `Failed to send notification: ${msg}`);
          });
      }
    },
    config.memoryDir,
    jobs
  );

  // Set up Telegram integration (with scheduler reference)
  telegram = new TelegramIntegration(
    config.telegram.botToken,
    config.telegram.allowedUsers,
    agent,
    memory,
    scheduler
  );

  // Start Telegram bot
  telegram.start();

  // Start HTTP gateway
  const gateway = await createGateway({
    port: config.server.port,
    agent,
    scheduler,
    memory,
    jobs,
    store,
    owntracksToken: config.owntracksToken,
    onInboundSms: (from, body) => {
      if (primaryUser && telegram) {
        telegram
          .sendNotification(primaryUser, `📱 SMS from ${from}:\n${body}`)
          .catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            logError("gateway", `Failed to forward SMS notification: ${msg}`);
          });
      }
    },
  });

  // Start periodic token refresh (every 30 minutes)
  const tokenRefreshTimer = startTokenRefreshTimer();
  metrics.setGauge("service.started", Date.now());

  info("main", "All systems running.");

  // Graceful shutdown
  const shutdown = (): void => {
    info("main", "Shutting down...");
    clearInterval(tokenRefreshTimer);
    telegram.stop();
    scheduler.stopAll();
    gateway.close().finally(() => process.exit(0));
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  logError("main", `Fatal: ${msg}`);
  process.exit(1);
});
