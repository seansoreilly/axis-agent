import { randomUUID, timingSafeEqual } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Fastify from "fastify";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import type { Agent } from "./agent.js";
import type { Scheduler, ScheduledTask } from "./scheduler.js";
import { info, error as logError } from "./logger.js";
import { errorMessage } from "./utils.js";
import type { JobService } from "./jobs.js";
import { metrics } from "./metrics.js";
import { type SqliteStore } from "./persistence.js";
import type { VoiceService } from "./voice.js";
import type { HealthWatchdog } from "./watchdog.js";
import { buildConsentUrl, exchangeCodeForTokens, writeGwsCredentials, testGwsToken } from "./gws-auth.js";

/** Timing-safe string comparison to prevent timing attacks on token validation. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

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
  agent: Pick<Agent, "run">;
  scheduler: Pick<Scheduler, "add" | "remove" | "list" | "runNow">;
  jobs?: JobService;
  store?: SqliteStore;
  workDir?: string;
  owntracksToken?: string;
  gatewayApiToken?: string;
  voiceService?: VoiceService;
  onInboundSms?: (from: string, body: string) => void;
  watchdog?: HealthWatchdog;
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
    status: opts.watchdog?.getStatus().status ?? "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    checks: opts.watchdog?.getStatus().checks,
  }));

  // --- Protected routes (bearer auth when GATEWAY_API_TOKEN is set) ---
  app.register(async function protectedRoutes(protectedApp) {
    const gatewayApiToken = opts.gatewayApiToken;
    if (gatewayApiToken) {
      protectedApp.addHook("onRequest", async (request, reply) => {
        const auth = request.headers.authorization ?? "";
        if (!auth.startsWith("Bearer ") || !safeEqual(auth.slice(7), gatewayApiToken)) {
          return reply.status(401).send({ error: "unauthorized" });
        }
      });
    } else {
      logError("gateway", "GATEWAY_API_TOKEN not set — all protected routes will reject requests. Set this env var to enable the gateway API.");
      protectedApp.addHook("onRequest", async (_request, reply) => {
        return reply.status(403).send({ error: "gateway API token not configured" });
      });
    }

    protectedApp.post<{ Body: WebhookBody }>("/webhook", {
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    }, async (request, reply) => {
      const { prompt, sessionId } = request.body;
      const correlationId = randomUUID();

      if (!prompt || typeof prompt !== "string") {
        return reply.status(400).send({ error: "prompt is required" });
      }

      metrics.increment("gateway.webhook.requests");

      if (jobs) {
        // Async: enqueue and return job ID immediately — client polls /admin/jobs
        const job = jobs.enqueuePromptJob({ prompt, sessionId, source: "webhook" });
        return reply.status(202).send({ jobId: job.id, status: "queued", correlationId });
      }

      // Fallback: direct execution (no job service)
      const result = await agent.run(prompt, { sessionId, correlationId });
      return {
        text: result.text,
        sessionId: result.sessionId,
        durationMs: result.durationMs,
        totalCostUsd: result.totalCostUsd,
        isError: result.isError,
        correlationId,
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

      try {
        scheduler.add(task);
      } catch (err) {
        const message = errorMessage(err);
        return reply.status(400).send({ error: message });
      }
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
        const message = errorMessage(err);
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

    // --- Google Workspace OAuth re-auth flow ---

    protectedApp.get("/admin/gws-status", async () => {
      const status = await testGwsToken();
      return status;
    });

    protectedApp.get("/admin/gws-auth", async (_request, reply) => {
      const consentUrl = buildConsentUrl();
      const status = await testGwsToken();
      reply.header("Content-Type", "text/html");
      return `<!DOCTYPE html>
<html><head><title>gws OAuth</title>
<style>body{font-family:system-ui;max-width:600px;margin:40px auto;padding:0 20px}
.status{padding:12px;border-radius:6px;margin:16px 0}
.valid{background:#d4edda;color:#155724}.invalid{background:#f8d7da;color:#721c24}
input[type=text]{width:100%;padding:8px;box-sizing:border-box;font-family:monospace}
button{padding:8px 16px;margin-top:8px;cursor:pointer}</style></head>
<body>
<h2>Google Workspace OAuth</h2>
<div class="status ${status.valid ? "valid" : "invalid"}">
Token status: <strong>${status.valid ? "Valid" : "Invalid"}</strong>
${status.error ? `<br><small>${status.error}</small>` : ""}
</div>
${status.valid ? "<p>Token is working. No action needed.</p>" : `
<h3>Re-authenticate</h3>
<ol>
<li><a href="${consentUrl}" target="_blank">Click here to open Google consent</a></li>
<li>Approve access, then copy the <code>code=</code> value from the redirect URL</li>
<li>Paste it below and submit</li>
</ol>
<form method="POST" action="/admin/gws-auth">
<input type="text" name="code" placeholder="Paste authorization code here" required />
<br><button type="submit">Exchange &amp; Save Token</button>
</form>`}
</body></html>`;
    });

    protectedApp.post<{ Body: { code?: string } }>("/admin/gws-auth", async (request, reply) => {
      const code = request.body?.code?.trim();
      if (!code) {
        return reply.status(400).send({ error: "code is required" });
      }

      try {
        const { refreshToken } = await exchangeCodeForTokens(code);
        writeGwsCredentials(refreshToken);
        const status = await testGwsToken();

        if (!status.valid) {
          return reply.status(500).send({ error: "Token saved but verification failed", details: status.error });
        }

        info("gateway", "gws OAuth token refreshed successfully via gateway");

        reply.header("Content-Type", "text/html");
        return `<!DOCTYPE html>
<html><head><title>gws OAuth</title>
<style>body{font-family:system-ui;max-width:600px;margin:40px auto;padding:0 20px}
.success{padding:12px;border-radius:6px;background:#d4edda;color:#155724}</style></head>
<body>
<h2>Google Workspace OAuth</h2>
<div class="success"><strong>Token refreshed and verified successfully.</strong></div>
<p><a href="/admin/gws-auth">Back to status</a></p>
</body></html>`;
      } catch (err) {
        const message = errorMessage(err);
        logError("gateway", `gws OAuth exchange failed: ${message}`);
        return reply.status(400).send({ error: message });
      }
    });

    // Form-urlencoded parser (needed by /admin/gws-auth POST and Twilio SMS)
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

    // Twilio inbound SMS webhook (only if callback is configured)
    if (opts.onInboundSms) {
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
  if (owntracksToken && opts.workDir) {
    app.post<{ Body: OwnTracksLocation }>("/owntracks", async (request, reply) => {
      // Accept Bearer token OR HTTP Basic auth (OwnTracks iOS uses Basic)
      const auth = request.headers.authorization ?? "";
      let authenticated = false;
      if (auth.startsWith("Bearer ")) {
        authenticated = safeEqual(auth.slice(7), owntracksToken);
      } else if (auth.startsWith("Basic ")) {
        const decoded = Buffer.from(auth.slice(6), "base64").toString();
        const password = decoded.split(":").slice(1).join(":");
        authenticated = safeEqual(password, owntracksToken);
      }
      if (!authenticated) {
        return reply.status(401).send({ error: "unauthorized" });
      }

      const body = request.body;
      if (!body || body._type !== "location" || typeof body.lat !== "number" || typeof body.lon !== "number") {
        return reply.status(400).send([]);
      }

      // Reject timestamps too far in the future (>5 min) or too stale (>24h)
      const nowSecs = Date.now() / 1000;
      if (body.tst > nowSecs + 300 || body.tst < nowSecs - 86400) {
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

      const finalPath = join(opts.workDir!, "current-location.json");
      const tmpPath = finalPath + ".tmp";
      writeFileSync(tmpPath, JSON.stringify(location));
      renameSync(tmpPath, finalPath);
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
