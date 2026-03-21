import { readFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";

export interface IdentityFile {
  name: string;
  path: string;
  content: string;
}

export interface IdentityContext {
  files: IdentityFile[];
  composed: string;
}

export class IdentityManager {
  private static readonly IDENTITY_FILES = [
    "SOUL.md",
    "USER.md",
    "TOOLS.md",
  ] as const;

  constructor(private readonly workDir: string) {}

  async load(): Promise<IdentityContext> {
    const files: IdentityFile[] = [];

    for (const filename of IdentityManager.IDENTITY_FILES) {
      const file = await this.read(filename);
      if (file) {
        files.push(file);
      }
    }

    let composed: string;
    if (files.length === 0) {
      composed = "";
    } else if (files.length === 1) {
      composed = files[0].content;
    } else {
      composed = files
        .map((f) => `## ${f.name}\n${f.content}`)
        .join("\n\n");
    }

    return { files, composed };
  }

  async has(filename: string): Promise<boolean> {
    try {
      await access(join(this.workDir, filename));
      return true;
    } catch {
      return false;
    }
  }

  async read(filename: string): Promise<IdentityFile | undefined> {
    const filePath = join(this.workDir, filename);
    try {
      const content = await readFile(filePath, "utf-8");
      const name = filename.replace(/\.md$/, "");
      return { name, path: filePath, content };
    } catch {
      return undefined;
    }
  }

  async write(filename: string, content: string): Promise<void> {
    const valid: readonly string[] = IdentityManager.IDENTITY_FILES;
    if (!valid.includes(filename)) {
      throw new Error(
        `Unknown identity file: ${filename}. Must be one of: ${valid.join(", ")}`,
      );
    }
    await writeFile(join(this.workDir, filename), content, "utf-8");
  }

  async listExisting(): Promise<string[]> {
    const existing: string[] = [];
    for (const filename of IdentityManager.IDENTITY_FILES) {
      if (await this.has(filename)) {
        existing.push(filename);
      }
    }
    return existing;
  }
}
