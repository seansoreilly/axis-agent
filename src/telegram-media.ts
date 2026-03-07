import { writeFileSync } from "node:fs";
import TelegramBot from "node-telegram-bot-api";
import { error as logError } from "./logger.js";

export class TelegramMediaService {
  constructor(
    private readonly bot: TelegramBot,
    private readonly botToken: string
  ) {}

  async downloadText(fileId: string): Promise<string | null> {
    try {
      const file = await this.bot.getFile(fileId);
      if (!file.file_path) return null;
      const response = await fetch(this.fileUrl(file.file_path));
      return await response.text();
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logError("telegram", `Failed to download file: ${errMsg}`);
      return null;
    }
  }

  async downloadBuffer(fileId: string): Promise<{ buffer: Buffer; path: string } | null> {
    try {
      const file = await this.bot.getFile(fileId);
      if (!file.file_path) return null;
      const response = await fetch(this.fileUrl(file.file_path));
      const buffer = Buffer.from(await response.arrayBuffer());
      return { buffer, path: file.file_path };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logError("telegram", `Failed to download file: ${errMsg}`);
      return null;
    }
  }

  saveTemp(prefix: string, ext: string, buffer: Buffer): string {
    const tmpPath = `/tmp/${prefix}_${Date.now()}.${ext}`;
    writeFileSync(tmpPath, buffer);
    return tmpPath;
  }

  private fileUrl(path: string): string {
    return `https://api.telegram.org/file/bot${this.botToken}/${path}`;
  }
}
