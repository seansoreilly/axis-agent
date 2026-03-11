import Fastify from "fastify";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import type { Agent } from "./agent.js";
import type { Scheduler, ScheduledTask } from "./scheduler.js";
import { info } from "./logger.js";
import type { JobService } from "./jobs.js";
import { metrics } from "./metrics.js";
import { type SqliteStore } from "./persistence.js";
import type { VoiceService } from "./voice.js";

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

interface CallBody {
  phoneNumber: string;
  context?: string;
  recipientName?: string;
}

interface GatewayOptions {
  port: number;
  agent: Agent;
  scheduler: Scheduler;
  jobs?: JobService;
  store?: SqliteStore;
  owntracksToken?: string;
  gatewayApiToken?: string;
  voiceService?: VoiceService;
  onInboundSms?: (from: string, body: string) => void;
}

export async function createGateway(
  opts: GatewayOptions
): Promise<ReturnType<typeof Fastify>> {
  const { port, agent, scheduler, owntracksToken, jobs, store } = opts;
  const app = Fastify({ bodyLimit: 10_240 });

  // Security headers
  await app.register(helmet, { contentSecurityPolicy: false });

  // Global rate limit (60 req/min)
  await app.register(rateLimit, {
    max: 60,
    timeWindow: "1 minute",
  });

  // --- Public routes (no auth) ---
  app.get("/health", async () => ({
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  }));

  // --- Protected routes (bearer auth when GATEWAY_API_TOKEN is set) ---
  app.register(async function protectedRoutes(protectedApp) {
    const gatewayApiToken = opts.gatewayApiToken;
    if (gatewayApiToken) {
      protectedApp.addHook("onRequest", async (request, reply) => {
        const auth = request.headers.authorization ?? "";
        if (!auth.startsWith("Bearer ") || auth.slice(7) !== gatewayApiToken) {
          return reply.status(401).send({ error: "unauthorized" });
        }
      });
    }

    protectedApp.post<{ Body: WebhookBody }>("/webhook", {
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    }, async (request, reply) => {
      const { prompt, sessionId } = request.body;

      if (!prompt || typeof prompt !== "string") {
        return reply.status(400).send({ error: "prompt is required" });
      }

      metrics.increment("gateway.webhook.requests");

      if (jobs) {
        // Async: enqueue and return job ID immediately — client polls /admin/jobs
        const job = jobs.enqueuePromptJob({ prompt, sessionId, source: "webhook" });
        return reply.status(202).send({ jobId: job.id, status: "queued" });
      }

      // Fallback: direct execution (no job service)
      const result = await agent.run(prompt, { sessionId });
      return {
        text: result.text,
        sessionId: result.sessionId,
        durationMs: result.durationMs,
        totalCostUsd: result.totalCostUsd,
        isError: result.isError,
      };
    });

    protectedApp.get("/tasks", async () => ({
      tasks: scheduler.list(),
    }));

    protectedApp.post<{ Body: ScheduleBody }>("/tasks", async (request, reply) => {
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

    protectedApp.delete<{ Params: { id: string } }>("/tasks/:id", async (request, reply) => {
      const removed = scheduler.remove(request.params.id);
      if (!removed) {
        return reply.status(404).send({ error: "task not found" });
      }
      return { ok: true };
    });

    protectedApp.post<{ Params: { id: string } }>("/tasks/:id/run", async (request, reply) => {
      try {
        const jobId = scheduler.runNow(request.params.id);
        return { ok: true, jobId };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const status = message.includes("not found") ? 404 : 400;
        return reply.status(status).send({ error: message });
      }
    });

    // Voice calling endpoints (only if voice service is configured)
    if (opts.voiceService) {
      protectedApp.post<{ Body: CallBody }>("/calls", {
        config: { rateLimit: { max: 3, timeWindow: "1 minute" } },
      }, async (request, reply) => {
        const { phoneNumber, context, recipientName } = request.body;
        if (!phoneNumber || typeof phoneNumber !== "string") {
          return reply.status(400).send({ error: "phoneNumber is required" });
        }
        if (!/^\+\d{7,15}$/.test(phoneNumber)) {
          return reply.status(400).send({ error: "phoneNumber must be E.164 format" });
        }
        if (!opts.voiceService!.isAvailable()) {
          return reply.status(503).send({ error: "Voice service not available (SIP trunk not configured)" });
        }
        const result = await opts.voiceService!.makeCall({ phoneNumber, context, recipientName });
        return { callId: result.callId, status: result.status, error: result.error };
      });

      protectedApp.get("/calls/active", async () => ({
        calls: opts.voiceService!.listActiveCalls(),
      }));

      info("gateway", "Voice calling endpoints enabled at /calls");
    }

    protectedApp.get("/admin/status", async () => ({
      status: "ok",
      uptime: process.uptime(),
      metrics: metrics.snapshot(),
      tasks: scheduler.list().length,
      recentJobs: jobs?.listJobs(10) ?? [],
    }));

    protectedApp.get("/admin/jobs", async () => ({
      jobs: jobs?.listJobs(50) ?? [],
    }));

    protectedApp.get("/admin/events", async () => ({
      events: store?.listEvents(100) ?? [],
    }));

    protectedApp.get("/admin/metrics", async () => metrics.snapshot());

    // Twilio inbound SMS webhook (only if callback is configured)
    if (opts.onInboundSms) {
      protectedApp.addContentTypeParser(
        "application/x-www-form-urlencoded",
        { parseAs: "string" },
        (_req, body, done) => {
          const params = new URLSearchParams(body as string);
          const result: Record<string, string> = {};
          params.forEach((value, key) => { result[key] = value; });
          done(null, result);
        }
      );

      protectedApp.post<{ Body: TwilioSmsBody }>("/twilio/inbound-sms", async (request, reply) => {
        const from = request.body?.From ?? "unknown";
        const body = request.body?.Body ?? "";
        info("gateway", `Inbound SMS from ${from}: ${body}`);
        metrics.increment("gateway.twilio.inbound_sms");
        opts.onInboundSms!(from, body);
        reply.header("Content-Type", "text/xml");
        return "<Response/>";
      });

      info("gateway", "Twilio inbound SMS endpoint enabled at /twilio/inbound-sms");
    }
  }); // end protectedRoutes

  // OwnTracks location ingestion (own auth, outside protected routes)
  if (owntracksToken && store) {
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

      store.setFact("current-location", JSON.stringify(location), "personal");
      info("gateway", `Location updated: ${body.lat},${body.lon} (acc: ${body.acc ?? "?"}m)`);
      metrics.increment("gateway.owntracks.updates");

      return [];
    });
    info("gateway", "OwnTracks endpoint enabled");
  }

  await app.listen({ port, host: "0.0.0.0" });
  info("gateway", `Listening on 0.0.0.0:${port}`);

  return app;
}
