import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { VapiConfig } from "./config.js";
import type { Memory } from "./memory.js";
import { info, error as logError } from "./logger.js";

export interface VoiceCallRequest {
  phoneNumber: string; // E.164 format
  context?: string; // Purpose/instructions for the call
  recipientName?: string; // Name of person being called
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
      const callBody = this.buildCallBody(
        request,
        systemPrompt,
        firstMessage,
        voiceId
      );
      const response = await fetch(`${VAPI_BASE}/call`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(callBody),
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

  private buildCallBody(
    request: VoiceCallRequest,
    systemPrompt: string,
    firstMessage: string | undefined,
    voiceId: string
  ): Record<string, unknown> {
    const isIvr = request.context?.toLowerCase().includes("ivr") ||
      request.context?.toLowerCase().includes("menu") ||
      request.context?.toLowerCase().includes("automated");

    const modelConfig = {
      provider: "openai",
      model: "gpt-4o-mini",
      toolIds: [this.config.dtmfToolId],
      tools: [{ type: "endCall" }],
      messages: [{ role: "system", content: systemPrompt }],
    };

    const voiceConfig = { provider: "cartesia", voiceId };

    const assistantConfig: Record<string, unknown> = {
      firstMessageMode: firstMessage
        ? "assistant-speaks-first"
        : "assistant-speaks-first-with-model-generated-message",
      ...(firstMessage ? { firstMessage } : {}),
      model: modelConfig,
      voice: voiceConfig,
      silenceTimeoutSeconds: isIvr ? 15 : 30,
      maxDurationSeconds: 300,
      backgroundSound: "off",
      startSpeakingPlan: {
        waitSeconds: 0.2,
        smartEndpointingEnabled: true,
        transcriptionEndpointingPlan: {
          onPunctuationSeconds: 0.1,
          onNoPunctuationSeconds: 0.8,
          onNumberSeconds: 0.3,
        },
      },
      stopSpeakingPlan: {
        numWords: 2,
        backoffSeconds: 1,
      },
    };

    // Always use inline transient assistant for full dynamic control
    return {
      phoneNumberId: this.config.phoneNumberId,
      customer: { number: request.phoneNumber },
      assistant: assistantConfig,
    };
  }

  private buildVoicePrompt(request: VoiceCallRequest): string {
    const parts: string[] = [];

    if (this.soulMd) {
      parts.push(
        "# Personality",
        this.soulMd,
        "",
        "Adapt the above personality for a phone call.",
        ""
      );
    }

    const ownerName = process.env["OWNER_NAME"] ?? "";
    parts.push(
      "You are a personal AI assistant on a quick phone call.",
      ownerName ? `You are calling on behalf of ${ownerName}.` : "",
      request.recipientName ? `You are calling ${request.recipientName}.` : "",
      "",
      "# Opening",
      "Your FIRST message must combine a brief greeting with your question — do NOT greet and then wait.",
      ownerName
        ? `Example: "Hi ${request.recipientName ?? "there"}, calling on behalf of ${ownerName}. What time are you heading to the hospital?"`
        : `Example: "Hi ${request.recipientName ?? "there"}. What time are you heading to the hospital?"`,
      ""
    );

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
      "# How to talk",
      "- Be casual and quick, like texting but out loud",
      "- One sentence per turn, two max",
      "- Use words like gotcha, cool, right, sounds good",
      "- Match their energy",
      "",
      "# Flow",
      "1. Ask the question right away",
      "2. When they answer, confirm AND say bye in the SAME response, then immediately call endCall",
      '3. Example good response: "Gotcha, 3pm. Thanks, bye!" [endCall]',
      "4. Do NOT confirm in one message and then say goodbye in a separate message",
      "",
      "# Rules",
      "- Never ask 'how are you'",
      "- Never say goodbye or thanks more than once",
      "- Always combine your farewell with the endCall in ONE turn — no separate goodbye turn",
      "- If they say bye first, just respond with a quick bye and endCall immediately",
      "- If they seem confused about who's calling, briefly explain you're an AI assistant calling on behalf of the owner",
      "- Never mention that you're an AI unless directly asked"
    );

    return parts.join("\n");
  }

  private buildGreeting(request: VoiceCallRequest): string | undefined {
    const ownerName = process.env["OWNER_NAME"] ?? "";
    const hi = request.recipientName ? `Hi ${request.recipientName}` : "Hi there";
    const behalf = ownerName ? `, calling on behalf of ${ownerName}` : "";

    // For calls with context, return undefined to let the LLM generate
    // a combined greeting + question (avoids pause between intro and question)
    if (request.context) return undefined;

    if (request.context?.toLowerCase().includes("remind")) {
      return `${hi}${behalf}. Quick reminder call.`;
    }
    return `${hi}${behalf}.`;
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
