import TelegramBot from "node-telegram-bot-api";

const ACK_DELAY_MS = 3000;
const STATUS_UPDATE_INTERVAL_MS = 60_000;
const LONG_RUNNING_WARNING_MS = 5 * 60 * 1000;

export class TelegramProgressReporter {
  constructor(
    private readonly bot: TelegramBot,
    private readonly getEtaText: () => string,
    private readonly formatElapsed: (startMs: number) => string
  ) {}

  start(chatId: number, startTime: number): { stop: () => Promise<void> } {
    let ackMessageId: number | undefined;
    let stopped = false;
    let updateInterval: ReturnType<typeof setInterval> | undefined;

    const ackTimeout = setTimeout(async () => {
      if (stopped) return;
      try {
        const sent = await this.bot.sendMessage(chatId, `Working on it... ETA: ${this.getEtaText()}`);
        ackMessageId = sent.message_id;

        updateInterval = setInterval(async () => {
          if (stopped || !ackMessageId) return;
          try {
            const elapsedMs = Date.now() - startTime;
            const elapsedText = this.formatElapsed(startTime);
            const text = elapsedMs >= LONG_RUNNING_WARNING_MS
              ? `Still working... (${elapsedText} elapsed) — taking longer than usual. /cancel to abort.`
              : `Still working... (${elapsedText} elapsed)`;
            await this.bot.editMessageText(
              text,
              { chat_id: chatId, message_id: ackMessageId }
            );
          } catch {
            // Ignore edit races.
          }
        }, STATUS_UPDATE_INTERVAL_MS);
      } catch {
        // Ignore ack failures.
      }
    }, ACK_DELAY_MS);

    return {
      stop: async () => {
        stopped = true;
        clearTimeout(ackTimeout);
        if (updateInterval) clearInterval(updateInterval);
        if (ackMessageId) {
          try {
            await this.bot.deleteMessage(chatId, ackMessageId);
          } catch {
            // Ignore delete races.
          }
        }
      },
    };
  }
}
