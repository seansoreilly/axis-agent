import Fastify from "fastify";
import type { Agent } from "./agent.js";
import type { Scheduler, ScheduledTask } from "./scheduler.js";
import { info } from "./logger.js";

interface WebhookBody {
  prompt: string;
  sessionId?: string;
}

interface ScheduleBody {
  id: string;
  name: string;
  schedule: string;
  prompt: string;
  enabled?: boolean;
}

export async function createGateway(
  port: number,
  agent: Agent,
  scheduler: Scheduler
): Promise<ReturnType<typeof Fastify>> {
  const app = Fastify();

  app.get("/health", async () => ({
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  }));

  app.post<{ Body: WebhookBody }>("/webhook", async (request, reply) => {
    const { prompt, sessionId } = request.body;

    if (!prompt || typeof prompt !== "string") {
      return reply.status(400).send({ error: "prompt is required" });
    }

    const result = await agent.run(prompt, { sessionId });

    return {
      text: result.text,
      sessionId: result.sessionId,
      durationMs: result.durationMs,
      totalCostUsd: result.totalCostUsd,
      isError: result.isError,
    };
  });

  app.get("/tasks", async () => ({
    tasks: scheduler.list(),
  }));

  app.post<{ Body: ScheduleBody }>("/tasks", async (request, reply) => {
    const { id, name, schedule, prompt, enabled } = request.body;

    if (!id || !name || !schedule || !prompt) {
      return reply
        .status(400)
        .send({ error: "id, name, schedule, and prompt are required" });
    }

    const task: ScheduledTask = {
      id,
      name,
      schedule,
      prompt,
      enabled: enabled ?? true,
    };

    scheduler.add(task);
    return { ok: true, task };
  });

  app.delete<{ Params: { id: string } }>("/tasks/:id", async (request, reply) => {
    const removed = scheduler.remove(request.params.id);
    if (!removed) {
      return reply.status(404).send({ error: "task not found" });
    }
    return { ok: true };
  });

  await app.listen({ port, host: "0.0.0.0" });
  info("gateway", `Listening on port ${port}`);

  return app;
}
