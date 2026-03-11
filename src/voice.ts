import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { VapiConfig } from "./config.js";
import type { SqliteStore } from "./persistence.js";
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
  private readonly memory: SqliteStore;
  private readonly onCallStatus?: CallStatusCallback;
  private activeCalls: Map<string, ActiveCall> = new Map();
  private soulMd: string | null = null;

  constructor(
    vapiConfig: VapiConfig,
    memory: SqliteStore,
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

  private isIvrCall(request: VoiceCallRequest): boolean {
    const ctx = request.context?.toLowerCase() ?? "";
    return ["ivr", "menu", "automated", "support", "demo", "hotline", "after-hours", "helpline", "switchboard", "test line", "voicemail", "phone tree", "press"].some(
      (kw) => ctx.includes(kw)
    );
  }

  private buildCallBody(
    request: VoiceCallRequest,
    systemPrompt: string,
    firstMessage: string | undefined,
    voiceId: string
  ): Record<string, unknown> {
    const isIvr = this.isIvrCall(request);

    const modelConfig = {
      provider: "openai",
      model: "gpt-4o-mini",
      toolIds: [this.config.dtmfToolId],
      tools: [{ type: "endCall" }],
      messages: [{ role: "system", content: systemPrompt }],
    };

    const voiceConfig = { provider: "cartesia", voiceId };

    // IVR calls: wait for the system to speak first, be patient with turn-taking
    // Human calls: speak first, fast turn-taking
    const assistantConfig: Record<string, unknown> = {
      firstMessageMode: isIvr
        ? "assistant-waits-for-user"
        : firstMessage
          ? "assistant-speaks-first"
          : "assistant-speaks-first-with-model-generated-message",
      ...(firstMessage && !isIvr ? { firstMessage } : {}),
      model: modelConfig,
      voice: voiceConfig,
      silenceTimeoutSeconds: isIvr ? 45 : 30,
      maxDurationSeconds: 300,
      backgroundSound: "off",
      voicemailDetection: {
        provider: "vapi",
        beepMaxAwaitSeconds: 12,
        backoffPlan: {
          maxRetries: 5,
          startAtSeconds: 2,
          frequencySeconds: 2.5,
        },
      },
      startSpeakingPlan: {
        waitSeconds: isIvr ? 1.5 : 0.2,
        smartEndpointingEnabled: !isIvr,
        ...(isIvr
          ? {
              transcriptionEndpointingPlan: {
                onPunctuationSeconds: 2.0,
                onNoPunctuationSeconds: 2.5,
                onNumberSeconds: 1.5,
              },
            }
          : {
              transcriptionEndpointingPlan: {
                onPunctuationSeconds: 0.1,
                onNoPunctuationSeconds: 0.8,
                onNumberSeconds: 0.7,
              },
            }),
      },
      stopSpeakingPlan: {
        numWords: isIvr ? 8 : 2,
        backoffSeconds: isIvr ? 3 : 1,
        acknowledgementPhrases: [
          "yeah", "uh-huh", "mm-hmm", "okay", "right",
          "got it", "sure", "yep", "mhm",
        ],
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
    const isIvr = this.isIvrCall(request);
    const parts: string[] = [];

    // Only inject SOUL.md for human calls — IVR calls need a focused, short prompt
    if (this.soulMd && !isIvr) {
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
      "You are a personal AI assistant on a phone call.",
      ownerName ? `You are calling on behalf of ${ownerName}.` : "",
      request.recipientName ? `You are calling ${request.recipientName}.` : "",
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

    if (isIvr) {
      parts.push(
        "# IVR / Automated System Rules",
        "You are calling an automated phone system or support line.",
        "",
        "## Critical: LISTEN FIRST",
        "- Wait for the system to finish speaking before you respond",
        "- Do NOT speak over the system — let it complete its full message",
        "- Do NOT dump all your information at once",
        "- Answer ONLY what is asked, one question at a time",
        "",
        "## How to interact",
        "- When asked your name, just say your name",
        "- When asked for a number, just say the number",
        "- When asked to describe your issue, give a brief 1-sentence summary",
        "- When given menu options, listen to ALL options, then choose the best one",
        "- When the system says 'press 1 for X, press 2 for Y', you MUST use the DTMF tool to press the key",
        "- To press a key, call the DTMF tool with the digit (e.g. '1', '2', '3')",
        "- If no menu option matches your purpose, press 0 for operator or say 'representative'",
        "- If asked to hold, stay silent and wait",
        "",
        "## Information to provide when asked",
        ownerName ? `- Name: ${ownerName}` : "",
        "- Give details from the Call Purpose section above when relevant",
        "- For callback number, use the Known Facts if available, otherwise make up a plausible one",
        "- Make up reasonable placeholder details if asked for something not in the context (e.g. account number)",
        "",
        "## Ending",
        "- When the system says goodbye or the interaction is complete, say a SINGLE quick goodbye and call endCall IMMEDIATELY in the SAME turn",
        '- Example: "Thanks, goodbye!" → endCall',
        "- Do NOT wait for their response after saying goodbye — call endCall right away",
        "- NEVER say goodbye more than once — one farewell + endCall, that's it",
        "- If transferred to hold music or silence for more than 10 seconds, stay on the line",
        "",
        "## If transferred to a human",
        "- Re-introduce yourself briefly when the new person picks up",
        "- State your purpose again concisely",
        "- Answer their questions as you would in a normal call",
      );
    } else {
      parts.push(
        "# Opening",
        "Your FIRST message must combine a brief greeting with your question — do NOT greet and then wait.",
        ownerName
          ? `Example: "Hi ${request.recipientName ?? "there"}, calling on behalf of ${ownerName}. What time are you heading to the hospital?"`
          : `Example: "Hi ${request.recipientName ?? "there"}. What time are you heading to the hospital?"`,
        "",
        "# How to talk",
        "- Be casual and quick, like texting but out loud",
        "- One sentence per turn, two max",
        "- Use words like gotcha, cool, right, sounds good",
        "- Match their energy",
        "",
        "# Flow",
        "1. Ask the question right away",
        "2. When they answer, respond with EXACTLY this pattern: '[confirm their answer], thanks, bye!' then call endCall",
        "",
        "## Response template (FOLLOW THIS EXACTLY):",
        '- They say "7:30" → You say: "Gotcha, 7:30. Thanks, bye!" → endCall',
        '- They say "Tuesday" → You say: "Cool, Tuesday. Thanks, bye!" → endCall',
        '- They say "yes" → You say: "Great, sounds good. Thanks, bye!" → endCall',
        '- They say "at the park" → You say: "Right, the park. Thanks, bye!" → endCall',
        "",
        "WRONG (never do this):",
        '- Just saying "Goodbye" without confirming their answer',
        '- Saying "OK" then waiting, then saying "bye" in a separate turn',
        "",
        "# Ending the call",
        "- ALWAYS call the endCall tool immediately after your farewell — same turn, no delay",
        "- If they say bye first, respond with a quick bye AND call endCall",
        "",
        "# Rules",
        "- Never ask 'how are you'",
        "- Never say goodbye or thanks more than once",
        "- If they seem confused about who's calling, briefly explain you're an AI assistant calling on behalf of the owner",
        "- Never mention that you're an AI unless directly asked",
        "",
        "# If put on hold or transferred",
        "- If put on hold, wait silently",
        "- If transferred to someone new, re-introduce yourself and state your purpose briefly",
        "",
        "# If you reach voicemail",
        `- Leave a brief message: "${ownerName || "Hi"} asked me to call. ${request.context ? "It's about: " + request.context.slice(0, 80) + "." : ""} Please call back when you can."`,
        "- Then call endCall immediately",
      );
    }

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
