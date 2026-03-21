import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { IdentityManager } from "./identity.js";

describe("IdentityManager", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `identity-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("load()", () => {
    it("loads single SOUL.md without header (backward compat)", async () => {
      writeFileSync(join(tmpDir, "SOUL.md"), "I am a helpful agent.");
      const mgr = new IdentityManager(tmpDir);
      const ctx = await mgr.load();

      expect(ctx.files).toHaveLength(1);
      expect(ctx.files[0].name).toBe("SOUL");
      expect(ctx.files[0].content).toBe("I am a helpful agent.");
      expect(ctx.composed).toBe("I am a helpful agent.");
    });

    it("loads multiple files with headers", async () => {
      writeFileSync(join(tmpDir, "SOUL.md"), "Soul content");
      writeFileSync(join(tmpDir, "USER.md"), "User content");
      const mgr = new IdentityManager(tmpDir);
      const ctx = await mgr.load();

      expect(ctx.files).toHaveLength(2);
      expect(ctx.composed).toBe("## SOUL\nSoul content\n\n## USER\nUser content");
    });

    it("skips missing files gracefully", async () => {
      writeFileSync(join(tmpDir, "SOUL.md"), "Soul content");
      writeFileSync(join(tmpDir, "TOOLS.md"), "Tools content");
      // USER.md is missing
      const mgr = new IdentityManager(tmpDir);
      const ctx = await mgr.load();

      expect(ctx.files).toHaveLength(2);
      expect(ctx.files[0].name).toBe("SOUL");
      expect(ctx.files[1].name).toBe("TOOLS");
      expect(ctx.composed).toBe("## SOUL\nSoul content\n\n## TOOLS\nTools content");
    });

    it("returns empty context when no files exist", async () => {
      const mgr = new IdentityManager(tmpDir);
      const ctx = await mgr.load();

      expect(ctx.files).toHaveLength(0);
      expect(ctx.composed).toBe("");
    });

    it("preserves file order (SOUL, USER, TOOLS)", async () => {
      // Write in reverse order to ensure load respects priority, not filesystem order
      writeFileSync(join(tmpDir, "TOOLS.md"), "Tools");
      writeFileSync(join(tmpDir, "USER.md"), "User");
      writeFileSync(join(tmpDir, "SOUL.md"), "Soul");
      const mgr = new IdentityManager(tmpDir);
      const ctx = await mgr.load();

      expect(ctx.files.map((f) => f.name)).toEqual(["SOUL", "USER", "TOOLS"]);
    });
  });

  describe("has()", () => {
    it("returns true for existing file", async () => {
      writeFileSync(join(tmpDir, "SOUL.md"), "content");
      const mgr = new IdentityManager(tmpDir);
      expect(await mgr.has("SOUL.md")).toBe(true);
    });

    it("returns false for missing file", async () => {
      const mgr = new IdentityManager(tmpDir);
      expect(await mgr.has("SOUL.md")).toBe(false);
    });
  });

  describe("read()", () => {
    it("returns content for existing file", async () => {
      writeFileSync(join(tmpDir, "USER.md"), "User preferences");
      const mgr = new IdentityManager(tmpDir);
      const file = await mgr.read("USER.md");

      expect(file).toBeDefined();
      expect(file?.name).toBe("USER");
      expect(file?.content).toBe("User preferences");
      expect(file?.path).toBe(join(tmpDir, "USER.md"));
    });

    it("returns undefined for missing file", async () => {
      const mgr = new IdentityManager(tmpDir);
      const file = await mgr.read("TOOLS.md");
      expect(file).toBeUndefined();
    });
  });

  describe("write()", () => {
    it("creates new file", async () => {
      const mgr = new IdentityManager(tmpDir);
      await mgr.write("TOOLS.md", "New tools content");

      const content = readFileSync(join(tmpDir, "TOOLS.md"), "utf-8");
      expect(content).toBe("New tools content");
    });

    it("overwrites existing file", async () => {
      writeFileSync(join(tmpDir, "SOUL.md"), "Old content");
      const mgr = new IdentityManager(tmpDir);
      await mgr.write("SOUL.md", "New content");

      const content = readFileSync(join(tmpDir, "SOUL.md"), "utf-8");
      expect(content).toBe("New content");
    });

    it("rejects unknown filenames", async () => {
      const mgr = new IdentityManager(tmpDir);
      await expect(mgr.write("RANDOM.md", "content")).rejects.toThrow();
    });
  });

  describe("listExisting()", () => {
    it("returns only files that exist", async () => {
      writeFileSync(join(tmpDir, "SOUL.md"), "soul");
      writeFileSync(join(tmpDir, "TOOLS.md"), "tools");
      const mgr = new IdentityManager(tmpDir);
      const existing = await mgr.listExisting();

      expect(existing).toEqual(["SOUL.md", "TOOLS.md"]);
    });
  });
});
