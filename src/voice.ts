import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { VapiConfig } from "./config.js";
import type { Memory } from "./memory.js";
import { info, error as logError } from "./logger.js";

export interface VoiceCallRequest {
  phoneNumber: string; // E.164 format
  context?: string; // Purpose/instructions for the call
  userId?: number; // Telegram user who initiated
}

export interface TranscriptEntry {
  role: "user" | "assistant";
  text: string;
  timestamp: number;
}

export interface VoiceCallResult {
  callId: string;
  phoneNumber: string;
  status: "ringing" | "in-progress" | "completed" | "failed";
  durationSeconds: number;
  error?: string;
  transcript?: TranscriptEntry[];
}

type CallStatusCallback = (
  callId: string,
  status: string,
  result?: VoiceCallResult
) => void;

interface ActiveCall {
  callId: string;
  vapiCallId: string;
  phoneNumber: string;
  userId?: number;
  startedAt: number;
}

interface VapiCallResponse {
  id: string;
  status: string;
  startedAt?: string;
  endedAt?: string;
  artifact?: {
    transcript?: string;
  };
}

const VAPI_BASE = "https://api.vapi.ai";

export class VoiceService {
  private readonly config: VapiConfig;
  private readonly memory: Memory;
  private readonly onCallStatus?: CallStatusCallback;
  private activeCalls: Map<string, ActiveCall> = new Map();
  private soulMd: string | null = null;

  constructor(
    vapiConfig: VapiConfig,
    memory: Memory,
    onCallStatus?: CallStatusCallback
  ) {
    this.config = vapiConfig;
    this.memory = memory;
    this.onCallStatus = onCallStatus;
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

  isAvailable(): boolean {
    return !!this.config.phoneNumberId;
  }

  getActiveCall(callId: string): ActiveCall | undefined {
    return this.activeCalls.get(callId);
  }

  listActiveCalls(): ActiveCall[] {
    return Array.from(this.activeCalls.values());
  }

  async makeCall(request: VoiceCallRequest): Promise<VoiceCallResult> {
    const callId = `call-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    info(
      "voice",
      `Initiating call ${callId} to ${request.phoneNumber}${request.context ? ` (${request.context.slice(0, 50)})` : ""}`
    );

    const systemPrompt = this.buildVoicePrompt(request);
    const firstMessage = this.buildGreeting(request);
    const voiceId =
      this.config.ttsVoiceId ?? "043cfc81-d69f-4bee-ae1e-7862cb358650"; // Australian Woman

    try {
      const response = await fetch(`${VAPI_BASE}/call`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          phoneNumberId: this.config.phoneNumberId,
          customer: { number: request.phoneNumber },
          assistant: {
            firstMessage,
            model: {
              provider: "openai",
              model: "gpt-4o-mini",
              messages: [{ role: "system", content: systemPrompt }],
            },
            transcriber: { provider: "deepgram", model: "nova-3" },
            voice: { provider: "cartesia", voiceId },
          },
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Vapi API error ${response.status}: ${body}`);
      }

      const vapiCall = (await response.json()) as VapiCallResponse;

      const activeCall: ActiveCall = {
        callId,
        vapiCallId: vapiCall.id,
        phoneNumber: request.phoneNumber,
        userId: request.userId,
        startedAt: Date.now(),
      };
      this.activeCalls.set(callId, activeCall);

      const result: VoiceCallResult = {
        callId,
        phoneNumber: request.phoneNumber,
        status: "ringing",
        durationSeconds: 0,
      };

      this.onCallStatus?.(callId, "ringing", result);

      // Monitor call completion in background
      this.monitorCall(callId).catch((err) => {
        logError("voice", `Call monitor error: ${err}`);
      });

      return result;
    } catch (err) {
      this.activeCalls.delete(callId);
      const errMsg = err instanceof Error ? err.message : String(err);
      logError("voice", `Failed to initiate call ${callId}: ${errMsg}`);

      const result: VoiceCallResult = {
        callId,
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

    if (this.soulMd) {
      parts.push(
        "# Personality",
        this.soulMd,
        "",
        "Adapt the above personality for a phone call. Speak naturally and conversationally.",
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

    if (request.context) {
      parts.push("# Call Purpose", request.context, "");
    }

    const coreContext = this.memory.getContext({
      categories: ["personal", "preference"],
    });
    if (coreContext) {
      parts.push("# Known Facts About the User", coreContext, "");
    }

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

  private parseTranscript(transcriptText: string): TranscriptEntry[] {
    const entries: TranscriptEntry[] = [];
    const lines = transcriptText.split("\n").filter(Boolean);
    for (const line of lines) {
      const match = line.match(/^(AI|User):\s*(.+)$/i);
      if (match) {
        entries.push({
          role: match[1].toLowerCase() === "ai" ? "assistant" : "user",
          text: match[2],
          timestamp: Date.now(),
        });
      }
    }
    return entries;
  }

  private async monitorCall(callId: string): Promise<void> {
    const activeCall = this.activeCalls.get(callId);
    if (!activeCall) return;

    const pollInterval = setInterval(async () => {
      try {
        const response = await fetch(
          `${VAPI_BASE}/call/${activeCall.vapiCallId}`,
          {
            headers: { Authorization: `Bearer ${this.config.apiKey}` },
          }
        );

        if (!response.ok) return; // transient error, keep polling

        const vapiCall = (await response.json()) as VapiCallResponse;

        if (vapiCall.status === "ended") {
          clearInterval(pollInterval);
          this.activeCalls.delete(callId);

          const durationSeconds = Math.round(
            (Date.now() - activeCall.startedAt) / 1000
          );

          const transcript = vapiCall.artifact?.transcript
            ? this.parseTranscript(vapiCall.artifact.transcript)
            : undefined;

          const result: VoiceCallResult = {
            callId,
            phoneNumber: activeCall.phoneNumber,
            status: "completed",
            durationSeconds,
            transcript,
          };

          info(
            "voice",
            `Call ${callId} completed (${durationSeconds}s, ${transcript?.length ?? 0} transcript entries)`
          );
          this.onCallStatus?.(callId, "completed", result);
        }
      } catch {
        // transient error, keep polling
      }
    }, 5000);

    // Safety timeout: clean up after 10 minutes
    setTimeout(() => {
      clearInterval(pollInterval);
      if (this.activeCalls.has(callId)) {
        this.activeCalls.delete(callId);
        info("voice", `Call ${callId} timed out`);
        this.onCallStatus?.(callId, "completed", {
          callId,
          phoneNumber: activeCall.phoneNumber,
          status: "completed",
          durationSeconds: 600,
        });
      }
    }, 600_000);
  }
}
