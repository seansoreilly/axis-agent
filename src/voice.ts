import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { AgentServer, ServerOptions } from "@livekit/agents";
import { AgentDispatchClient, RoomServiceClient } from "livekit-server-sdk";
import type { Config, LiveKitConfig } from "./config.js";
import type { Memory } from "./memory.js";
import { info, error as logError } from "./logger.js";

export interface VoiceCallRequest {
  phoneNumber: string; // E.164 format
  context?: string; // Purpose/instructions for the call
  userId?: number; // Telegram user who initiated
}

export interface VoiceCallResult {
  callId: string;
  roomName: string;
  phoneNumber: string;
  status: "initiating" | "ringing" | "connected" | "completed" | "failed";
  durationSeconds: number;
  error?: string;
}

type CallStatusCallback = (
  callId: string,
  status: string,
  result?: VoiceCallResult
) => void;

interface ActiveCall {
  callId: string;
  roomName: string;
  phoneNumber: string;
  userId?: number;
  startedAt: number;
}

export class VoiceService {
  private readonly lk: LiveKitConfig;
  private readonly memory: Memory;
  private readonly onCallStatus?: CallStatusCallback;
  private server?: AgentServer;
  private dispatchClient: AgentDispatchClient;
  private roomClient: RoomServiceClient;
  private activeCalls: Map<string, ActiveCall> = new Map();
  private soulMd: string | null = null;

  constructor(
    config: Config,
    memory: Memory,
    onCallStatus?: CallStatusCallback
  ) {
    if (!config.livekit) {
      throw new Error("LiveKit config is required for VoiceService");
    }
    this.lk = config.livekit;
    this.memory = memory;
    this.onCallStatus = onCallStatus;

    // HTTP URL for server SDK (convert wss:// to https://)
    const httpUrl = this.lk.url
      .replace("wss://", "https://")
      .replace("ws://", "http://");

    this.dispatchClient = new AgentDispatchClient(httpUrl, this.lk.apiKey, this.lk.apiSecret);
    this.roomClient = new RoomServiceClient(
      httpUrl,
      this.lk.apiKey,
      this.lk.apiSecret
    );

    // Load SOUL.md for voice personality
    this.soulMd = this.loadSoulMd();
  }

  private loadSoulMd(): string | null {
    const candidates = [
      resolve(process.cwd(), "SOUL.md"),
      resolve(process.cwd(), "..", "SOUL.md"),
    ];
    for (const path of candidates) {
      try {
        return readFileSync(path, "utf-8");
      } catch {
        // not found, try next
      }
    }
    return null;
  }

  async start(): Promise<void> {
    // Resolve the voice agent file path (compiled to dist/)
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const agentFile = resolve(thisDir, "voice-agent.js");

    const opts = new ServerOptions({
      agent: agentFile,
      wsURL: this.lk.url,
      apiKey: this.lk.apiKey,
      apiSecret: this.lk.apiSecret,
      agentName: "axis-voice-agent",
      numIdleProcesses: 1,
      logLevel: "warn",
    });

    // LiveKit agents SDK checks globalThis for a pino logger via well-known symbols.
    // Normally initializeLogger() is called by the CLI entrypoint, but we use AgentServer
    // directly, so we replicate the init here to avoid "logger not initialized" errors.
    const g = globalThis as Record<symbol, unknown>;
    const loggerKey = Symbol.for("@livekit/agents:logger");
    const optsKey = Symbol.for("@livekit/agents:loggerOptions");
    if (!g[loggerKey]) {
      g[optsKey] = { pretty: false, level: "info" };
      g[loggerKey] = pino(
        { level: "info", serializers: { error: pino.stdSerializers.err } },
        process.stdout,
      );
    }

    this.server = new AgentServer(opts);
    // run() blocks forever (WebSocket event loop) — fire-and-forget
    this.server.run().catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      logError("voice", `Agent worker crashed: ${msg}`);
    });
    info("voice", `Agent worker starting with ${this.lk.url}`);
  }

  async stop(): Promise<void> {
    if (this.server) {
      await this.server.close();
      info("voice", "Agent worker stopped");
    }
  }

  isAvailable(): boolean {
    return !!this.server && !!this.lk.sipTrunkId;
  }

  getActiveCall(callId: string): ActiveCall | undefined {
    return this.activeCalls.get(callId);
  }

  listActiveCalls(): ActiveCall[] {
    return Array.from(this.activeCalls.values());
  }

  async makeCall(request: VoiceCallRequest): Promise<VoiceCallResult> {
    if (!this.lk.sipTrunkId) {
      throw new Error(
        "SIP trunk not configured. Set LIVEKIT_SIP_TRUNK_ID in .env"
      );
    }

    const callId = `call-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const roomName = `voice-${callId}`;

    info(
      "voice",
      `Initiating call ${callId} to ${request.phoneNumber}${request.context ? ` (${request.context.slice(0, 50)})` : ""}`
    );

    // Build voice system prompt with personality and memory context
    const systemPrompt = this.buildVoicePrompt(request);
    const firstMessage = this.buildGreeting(request);

    try {
      // Create room with metadata for the agent (includes SIP trunk info so
      // the agent can dial out from within its entry function)
      const roomMetadata = JSON.stringify({
        systemPrompt,
        firstMessage,
        phoneNumber: request.phoneNumber,
        sipTrunkId: this.lk.sipTrunkId,
      });

      await this.roomClient.createRoom({
        name: roomName,
        metadata: roomMetadata,
        emptyTimeout: 30, // close room 30s after last participant leaves
        maxParticipants: 3, // agent + caller + observer
      });

      // Dispatch the agent to the room — the agent will join, then dial out via SIP
      await this.dispatchClient.createDispatch(roomName, "axis-voice-agent", {
        metadata: roomMetadata,
      });

      // Track the active call
      const activeCall: ActiveCall = {
        callId,
        roomName,
        phoneNumber: request.phoneNumber,
        userId: request.userId,
        startedAt: Date.now(),
      };
      this.activeCalls.set(callId, activeCall);

      const result: VoiceCallResult = {
        callId,
        roomName,
        phoneNumber: request.phoneNumber,
        status: "ringing",
        durationSeconds: 0,
      };

      this.onCallStatus?.(callId, "ringing", result);

      // Monitor call completion in background
      this.monitorCall(callId, roomName).catch((err) => {
        logError("voice", `Call monitor error: ${err}`);
      });

      return result;
    } catch (err) {
      this.activeCalls.delete(callId);
      const errMsg = err instanceof Error ? err.message : String(err);
      logError("voice", `Failed to initiate call ${callId}: ${errMsg}`);

      const result: VoiceCallResult = {
        callId,
        roomName,
        phoneNumber: request.phoneNumber,
        status: "failed",
        durationSeconds: 0,
        error: errMsg,
      };

      this.onCallStatus?.(callId, "failed", result);
      return result;
    }
  }

  private buildVoicePrompt(request: VoiceCallRequest): string {
    const parts: string[] = [];

    // Base personality from SOUL.md (condensed for voice)
    if (this.soulMd) {
      parts.push(
        "# Personality",
        "You are Axis Agent making a phone call. Speak naturally and conversationally.",
        "Keep responses short — this is a voice conversation, not text.",
        "Use simple sentences. Avoid markdown, bullet points, or formatting.",
        ""
      );
    } else {
      parts.push(
        "You are a helpful AI assistant making a phone call.",
        "Speak naturally and conversationally. Keep responses concise.",
        ""
      );
    }

    // Call purpose
    if (request.context) {
      parts.push(
        "# Call Purpose",
        request.context,
        ""
      );
    }

    // Inject relevant memory facts
    const coreContext = this.memory.getContext({
      categories: ["personal", "preference"],
    });
    if (coreContext) {
      parts.push("# Known Facts About the User", coreContext, "");
    }

    // Voice-specific instructions
    parts.push(
      "# Voice Conversation Rules",
      "- Speak naturally as if on a phone call",
      "- Keep responses to 1-2 sentences unless asked for detail",
      "- If the other person doesn't respond, wait a moment then ask if they're still there",
      "- End the call politely when the conversation purpose is fulfilled",
      "- Never mention that you're an AI unless directly asked"
    );

    return parts.join("\n");
  }

  private buildGreeting(request: VoiceCallRequest): string {
    if (request.context?.toLowerCase().includes("remind")) {
      return "Hi there, this is a quick reminder call.";
    }
    return "Hello, this is Axis Agent calling. How are you?";
  }

  private async monitorCall(
    callId: string,
    roomName: string
  ): Promise<void> {
    const activeCall = this.activeCalls.get(callId);
    if (!activeCall) return;

    // Poll room status until the call ends
    const pollInterval = setInterval(async () => {
      try {
        const rooms = await this.roomClient.listRooms([roomName]);
        if (rooms.length === 0) {
          // Room closed — call ended
          clearInterval(pollInterval);
          const durationSeconds = Math.round(
            (Date.now() - activeCall.startedAt) / 1000
          );
          this.activeCalls.delete(callId);

          const result: VoiceCallResult = {
            callId,
            roomName,
            phoneNumber: activeCall.phoneNumber,
            status: "completed",
            durationSeconds,
          };

          info(
            "voice",
            `Call ${callId} completed (${durationSeconds}s)`
          );
          this.onCallStatus?.(callId, "completed", result);
        }
      } catch {
        // Room service error — likely transient, keep polling
      }
    }, 5000);

    // Safety timeout: clean up after 10 minutes regardless
    setTimeout(() => {
      clearInterval(pollInterval);
      if (this.activeCalls.has(callId)) {
        this.activeCalls.delete(callId);
        info("voice", `Call ${callId} timed out`);
        this.onCallStatus?.(callId, "completed", {
          callId,
          roomName,
          phoneNumber: activeCall.phoneNumber,
          status: "completed",
          durationSeconds: 600,
        });
      }
    }, 600_000);
  }
}
