import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("logger", () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  describe("info()", () => {
    it("writes JSON to stdout", async () => {
      const { info } = await import("./logger.js");
      info("test-component", "hello world");

      expect(stdoutSpy).toHaveBeenCalledOnce();
      const output = stdoutSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output.trim());
      expect(parsed).toMatchObject({
        app: "axis-agent",
        level: "info",
        component: "test-component",
        message: "hello world",
      });
      expect(parsed.timestamp).toBeDefined();
    });
  });

  describe("error()", () => {
    it("writes JSON to stderr", async () => {
      const { error } = await import("./logger.js");
      error("test-component", "something broke");

      expect(stderrSpy).toHaveBeenCalled();
      const output = stderrSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output.trim());
      expect(parsed).toMatchObject({
        app: "axis-agent",
        level: "error",
        component: "test-component",
        message: "something broke",
      });
    });
  });

  describe("createLogger()", () => {
    it("returns bound info/error that include correlationId", async () => {
      const { createLogger } = await import("./logger.js");
      const log = createLogger("req-123");

      log.info("mycomp", "test message");
      expect(stdoutSpy).toHaveBeenCalled();
      const infoOutput = JSON.parse((stdoutSpy.mock.calls.at(-1)![0] as string).trim());
      expect(infoOutput.correlationId).toBe("req-123");
      expect(infoOutput.component).toBe("mycomp");
      expect(infoOutput.message).toBe("test message");

      log.error("mycomp", "bad thing");
      expect(stderrSpy).toHaveBeenCalled();
      const errorOutput = JSON.parse((stderrSpy.mock.calls.at(-1)![0] as string).trim());
      expect(errorOutput.correlationId).toBe("req-123");
    });

    it("omits correlationId when not provided", async () => {
      const { createLogger } = await import("./logger.js");
      const log = createLogger();

      log.info("comp", "no correlation");
      const output = JSON.parse((stdoutSpy.mock.calls.at(-1)![0] as string).trim());
      expect(output.correlationId).toBeUndefined();
    });
  });
});
