import { loadConfig } from "./config.js";
import { Agent } from "./agent.js";
import { Memory } from "./memory.js";
import { Scheduler } from "./scheduler.js";
import { TelegramIntegration } from "./telegram.js";
import { createGateway } from "./gateway.js";
import { info, error as logError } from "./logger.js";

async function main(): Promise<void> {
  info("main", "Starting Claude Code Agent...");

  const config = loadConfig();
  const memory = new Memory(config.memoryDir);
  const agent = new Agent(config, memory);

  // Set up Telegram integration
  const telegram = new TelegramIntegration(
    config.telegram.botToken,
    config.telegram.allowedUsers,
    agent,
    memory
  );

  // Set up scheduler with Telegram notifications
  const primaryUser = config.telegram.allowedUsers[0];
  const scheduler = new Scheduler(agent, (taskId, result) => {
    if (primaryUser) {
      telegram
        .sendNotification(primaryUser, `Scheduled task [${taskId}]:\n${result}`)
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          logError("scheduler", `Failed to send notification: ${msg}`);
        });
    }
  });

  // Start Telegram bot
  telegram.start();

  // Start HTTP gateway
  await createGateway(config.server.port, agent, scheduler);

  info("main", "All systems running.");

  // Graceful shutdown
  const shutdown = (): void => {
    info("main", "Shutting down...");
    telegram.stop();
    scheduler.stopAll();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  logError("main", `Fatal: ${msg}`);
  process.exit(1);
});
