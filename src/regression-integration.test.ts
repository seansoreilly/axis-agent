/**
 * Integration tests — send real prompts through the Claude Agent SDK.
 * Skipped automatically when OAuth credentials are not available.
 *
 * Run explicitly: INTEGRATION=1 npx vitest run src/regression-integration.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";

const credentialsPath = join(homedir(), ".claude", ".credentials.json");
const hasCredentials = existsSync(credentialsPath);
const integrationEnabled = process.env["INTEGRATION"] === "1";

describe.skipIf(!hasCredentials || !integrationEnabled)(
  "Integration: real SDK calls",
  () => {
    let tmpDir: string;
    let memoryDir: string;
    let workDir: string;

    beforeEach(() => {
      tmpDir = join(tmpdir(), `integration-test-${Date.now()}`);
      memoryDir = join(tmpDir, "memory");
      workDir = join(tmpDir, "workspace");
      mkdirSync(memoryDir, { recursive: true });
      mkdirSync(workDir, { recursive: true });
    });

    afterEach(() => {
      if (existsSync(tmpDir)) {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    function makeConfig() {
      return {
        telegram: { botToken: "unused", allowedUsers: [1] },
        server: { port: 0 },
        claude: {
          model: "claude-haiku-4-5-20251001",
          maxTurns: 1,
          maxBudgetUsd: 0.02,
          workDir,
          agentTimeoutMs: 30000,
        },
        memoryDir,
      };
    }

    it("sends a simple prompt and gets a coherent response", { timeout: 60000 }, async () => {
      const { Agent } = await import("./agent.js");
      const { SqliteStore } = await import("./persistence.js");

      const store = new SqliteStore(memoryDir);
      const agent = new Agent(makeConfig(), store);

      const result = await agent.run("Reply with exactly: PONG", {
        timeoutMs: 30000,
      });

      expect(result.isError).toBe(false);
      expect(result.text).toBeTruthy();
      expect(result.text.toUpperCase()).toContain("PONG");
      expect(result.sessionId).toBeTruthy();
      expect(result.durationMs).toBeGreaterThan(0);
      expect(result.totalCostUsd).toBeGreaterThanOrEqual(0);
    });

    it("returns a session ID that can be used for resumption", { timeout: 120000 }, async () => {
      const { Agent } = await import("./agent.js");
      const { SqliteStore } = await import("./persistence.js");

      const store = new SqliteStore(memoryDir);
      const agent = new Agent(makeConfig(), store);

      const first = await agent.run("Remember the word FLAMINGO", {
        timeoutMs: 30000,
      });

      expect(first.isError).toBe(false);
      expect(first.sessionId).toBeTruthy();

      // Resume the session
      const second = await agent.run("What word did I ask you to remember?", {
        sessionId: first.sessionId,
        timeoutMs: 30000,
      });

      expect(second.isError).toBe(false);
      expect(second.text.toUpperCase()).toContain("FLAMINGO");
    });

    it("handles cancellation via AbortSignal", { timeout: 30000 }, async () => {
      const { Agent } = await import("./agent.js");
      const { SqliteStore } = await import("./persistence.js");

      const store = new SqliteStore(memoryDir);
      const agent = new Agent(makeConfig(), store);

      const controller = new AbortController();
      // Cancel almost immediately
      setTimeout(() => controller.abort(), 500);

      const result = await agent.run(
        "Write a very long essay about the history of computing",
        { signal: controller.signal, timeoutMs: 30000 },
      );

      expect(result.isError).toBe(true);
      expect(result.text).toContain("cancelled");
    });

    it("end-to-end: webhook → job → agent → response", { timeout: 120000 }, async () => {
      const { Agent } = await import("./agent.js");
      const { SqliteStore } = await import("./persistence.js");
      const { JobService } = await import("./jobs.js");
      const { Scheduler } = await import("./scheduler.js");
      const { createGateway } = await import("./gateway.js");

      const store = new SqliteStore(memoryDir);
      const agent = new Agent(makeConfig(), store);
      const jobs = new JobService({ store, agent });
      const scheduler = new Scheduler(agent, () => {}, memoryDir, jobs);
      const gatewayToken = "integration-token";

      const app = await createGateway({
        port: 0,
        agent,
        scheduler,
        jobs,
        store,
        gatewayApiToken: gatewayToken,
      });

      try {
        // Submit via webhook
        const webhook = await app.inject({
          method: "POST",
          url: "/webhook",
          headers: { authorization: `Bearer ${gatewayToken}` },
          payload: { prompt: "Reply with exactly: INTEGRATION_OK" },
        });

        expect(webhook.statusCode).toBe(202);
        const { jobId } = JSON.parse(webhook.body);

        // Wait for job to complete (poll)
        let job = store.getJob(jobId);
        const deadline = Date.now() + 60000;
        while (job && job.status !== "completed" && job.status !== "failed" && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 1000));
          job = store.getJob(jobId);
        }

        expect(job).toBeDefined();
        expect(job!.status).toBe("completed");
        expect(job!.resultText).toBeTruthy();
        expect(job!.resultText!.toUpperCase()).toContain("INTEGRATION_OK");
      } finally {
        scheduler.stopAll();
        await app.close();
      }
    });
  },
);
