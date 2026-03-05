import Fastify from "fastify";
import type { Agent } from "./agent.js";
import type { Memory } from "./memory.js";
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

interface OwnTracksLocation {
  _type: string;
  lat: number;
  lon: number;
  tst: number;
  acc?: number;
  alt?: number;
  vel?: number;
  batt?: number;
  conn?: string;
  [key: string]: unknown;
}

interface TwilioSmsBody {
  From?: string;
  To?: string;
  Body?: string;
  MessageSid?: string;
  [key: string]: string | undefined;
}

interface GatewayOptions {
  port: number;
  agent: Agent;
  scheduler: Scheduler;
  memory?: Memory;
  owntracksToken?: string;
  onInboundSms?: (from: string, body: string) => void;
}

export async function createGateway(
  opts: GatewayOptions
): Promise<ReturnType<typeof Fastify>> {
  const { port, agent, scheduler, memory, owntracksToken } = opts;
  const app = Fastify({ bodyLimit: 10_240 });

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

  // Twilio inbound SMS webhook (only if callback is configured)
  if (opts.onInboundSms) {
    app.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "string" },
      (_req, body, done) => {
        const params = new URLSearchParams(body as string);
        const result: Record<string, string> = {};
        params.forEach((value, key) => { result[key] = value; });
        done(null, result);
      }
    );

    app.post<{ Body: TwilioSmsBody }>("/twilio/inbound-sms", async (request, reply) => {
      const from = request.body?.From ?? "unknown";
      const body = request.body?.Body ?? "";
      info("gateway", `Inbound SMS from ${from}: ${body}`);
      opts.onInboundSms!(from, body);
      reply.header("Content-Type", "text/xml");
      return "<Response/>";
    });

    info("gateway", "Twilio inbound SMS endpoint enabled at /twilio/inbound-sms");
  }

  // OwnTracks location ingestion (only if token is configured)
  if (owntracksToken && memory) {
    app.post<{ Body: OwnTracksLocation }>("/owntracks", async (request, reply) => {
      // Accept Bearer token OR HTTP Basic auth (OwnTracks iOS uses Basic)
      const auth = request.headers.authorization ?? "";
      let authenticated = false;
      if (auth.startsWith("Bearer ")) {
        authenticated = auth.slice(7) === owntracksToken;
      } else if (auth.startsWith("Basic ")) {
        const decoded = Buffer.from(auth.slice(6), "base64").toString();
        const password = decoded.split(":").slice(1).join(":");
        authenticated = password === owntracksToken;
      }
      if (!authenticated) {
        return reply.status(401).send({ error: "unauthorized" });
      }

      const body = request.body;
      if (!body || body._type !== "location" || typeof body.lat !== "number" || typeof body.lon !== "number") {
        return reply.status(400).send([]);
      }

      const utcTimestamp = new Date(body.tst * 1000);
      const location = {
        lat: body.lat,
        lon: body.lon,
        accuracy: body.acc,
        altitude: body.alt,
        velocity: body.vel,
        battery: body.batt,
        connection: body.conn,
        timestamp: utcTimestamp.toISOString(),
        localTime: utcTimestamp.toLocaleString("en-AU", { timeZone: "Australia/Melbourne", dateStyle: "medium", timeStyle: "short" }),
        receivedAt: new Date().toISOString(),
      };

      memory.setFact("current-location", JSON.stringify(location), "personal");
      info("gateway", `Location updated: ${body.lat},${body.lon} (acc: ${body.acc ?? "?"}m)`);

      return [];
    });
    info("gateway", "OwnTracks endpoint enabled");
  }

  await app.listen({ port, host: "0.0.0.0" });
  info("gateway", `Listening on 0.0.0.0:${port}`);

  return app;
}
