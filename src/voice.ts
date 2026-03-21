import Retell from "retell-sdk";
import type { RetellConfig } from "./config.js";
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
  retellCallId: string;
  phoneNumber: string;
  userId?: number;
  startedAt: number;
}

export class VoiceService {
  private readonly config: RetellConfig;
  private readonly client: Retell;
  private readonly onCallStatus?: CallStatusCallback;
  private activeCalls: Map<string, ActiveCall> = new Map();

  constructor(
    retellConfig: RetellConfig,
    onCallStatus?: CallStatusCallback
  ) {
    this.config = retellConfig;
    this.client = new Retell({ apiKey: retellConfig.apiKey });
    this.onCallStatus = onCallStatus;
  }

  isAvailable(): boolean {
    return !!this.config.phoneNumber;
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

    try {
      const systemPrompt = this.buildVoicePrompt(request);
      const greeting = this.buildGreeting(request);

      const retellCall = await this.client.call.createPhoneCall({
        from_number: this.config.phoneNumber,
        to_number: request.phoneNumber,
        retell_llm_dynamic_variables: {
          system_prompt: systemPrompt,
          begin_message: greeting ?? "",
        },
        agent_override: {
          retell_llm: {
            model: "claude-4.6-sonnet",
            start_speaker: "user",
            begin_message: greeting ?? "",
          },
        },
      });

      const activeCall: ActiveCall = {
        callId,
        retellCallId: retellCall.call_id,
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

  private buildVoicePrompt(request: VoiceCallRequest): string {
    const isIvr = this.isIvrCall(request);
    const parts: string[] = [];

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
        "- When the system says 'press 1 for X, press 2 for Y', say the digit clearly",
        "- If no menu option matches your purpose, press 0 for operator or say 'representative'",
        "- If asked to hold, stay silent and wait",
        "",
        "## Information to provide when asked",
        ownerName ? `- Name: ${ownerName}` : "",
        "- Give details from the Call Purpose section above when relevant",
        "- For callback number, use a plausible number",
        "- Make up reasonable placeholder details if asked for something not in the context (e.g. account number)",
        "",
        "## Ending",
        "- When the system says goodbye or the interaction is complete, say a SINGLE quick goodbye and call end_call IMMEDIATELY in the SAME turn",
        '- Example: "Thanks, goodbye!" → end_call',
        "- Do NOT wait for their response after saying goodbye — call end_call right away",
        "- NEVER say goodbye more than once — one farewell + end_call, that's it",
        "- If transferred to hold music or silence for more than 10 seconds, stay on the line",
        "",
        "## If transferred to a human",
        "- Re-introduce yourself briefly when the new person picks up",
        "- State your purpose again concisely",
        "- Answer their questions as you would in a normal call",
      );
    } else {
      parts.push(
        "# Style",
        "Casual and brief. One or two sentences per turn. Match their energy.",
        "",
        "# Rules",
        "- Wait for the person to say hello, then greet them and ask your question",
        "- When they answer your question, repeat back what they said, say thanks, and call end_call",
        '  Example: they say "scrambled eggs" → you say "Gotcha, scrambled eggs. Thanks, bye!" then end_call',
        "- If you don't understand, ask ONE clarifying question",
        "- If the conversation loops or they keep repeating themselves, say bye and end_call",
        "- Never mention you're an AI unless asked directly",
        "",
        "# Voicemail",
        `If you reach voicemail: "${ownerName || "Hi"} asked me to call.${request.context ? " It's about: " + request.context.slice(0, 80) + "." : ""} Please call back when you can." Then end_call.`,
      );
    }

    return parts.join("\n");
  }

  private buildGreeting(request: VoiceCallRequest): string | undefined {
    // IVR: no first message, wait and listen
    if (this.isIvrCall(request)) return undefined;

    const ownerName = process.env["OWNER_NAME"] ?? "";
    const hi = request.recipientName ? `Hi ${request.recipientName}` : "Hi there";
    const behalf = ownerName ? `, calling on behalf of ${ownerName}` : "";

    if (!request.context) {
      return `${hi}${behalf}.`;
    }

    // Context is often an instruction ("Ask what they're having for breakfast").
    // Transform it into a natural spoken question for the firstMessage.
    // The raw context also goes into the system prompt as Call Purpose.
    const spoken = this.contextToQuestion(request.context);
    return `${hi}${behalf}. ${spoken}`;
  }

  /**
   * Transform instruction-style context into a natural spoken question.
   * "Ask what they are having for breakfast" → "What are you having for breakfast?"
   * "Remind them about the meeting at 3" → "Just a reminder about the meeting at 3."
   * "What time is dinner?" → "What time is dinner?" (already a question, pass through)
   */
  private contextToQuestion(context: string): string {
    let q = context.trim();

    // If it already starts with a question word, it's likely already phrased as a question
    if (/^(what|when|where|who|why|how|is|are|do|does|can|could|will|would|did|have|has)\b/i.test(q)) {
      if (!/[.!?]$/.test(q)) q += "?";
      return q;
    }

    // Strip instruction prefixes and adjust pronouns
    const askMatch = q.match(/^ask\s+(?:them\s+)?(.+)$/i);
    if (askMatch) {
      q = askMatch[1];
      // Pronoun swap: third person → second person
      q = q.replace(/\b(what|where|when|how|why)\s+their\s+(\w+)\s+are\b/gi, (_m, w, n) => `${w} are your ${n}`);
      q = q.replace(/\b(what|where|when|how|why)\s+they\s+are\b/gi, (_m, w) => `${w} are you`);
      q = q.replace(/\b(what|where|when|how|why)\s+they(?:'re|\s+were)\b/gi, (_m, w) => `${w} were you`);
      q = q.replace(/\bthey are\b/gi, "you are");
      q = q.replace(/\bthey're\b/gi, "you're");
      q = q.replace(/\bthey\b/gi, "you");
      q = q.replace(/\bthem\b/gi, "you");
      q = q.replace(/\btheir\b/gi, "your");
      // "if you need..." → "Do you need..."
      if (/^if\s+you\b/i.test(q)) {
        q = q.replace(/^if\s+you\b/i, "Do you");
      }
      q = q.charAt(0).toUpperCase() + q.slice(1);
      if (!/[.!?]$/.test(q)) q += "?";
      return q;
    }

    // "Remind them about X" → "Just a reminder about X."
    const remindMatch = q.match(/^remind\s+(?:them\s+)?(.+)$/i);
    if (remindMatch) {
      const body = remindMatch[1];
      q = /^(about|that|to)\b/i.test(body)
        ? `Just a reminder ${body}`
        : `Just a reminder, ${body}`;
      if (!/[.!?]$/.test(q)) q += ".";
      return q;
    }

    // Fallback: use as-is
    if (!/[.!?]$/.test(q)) q += ".";
    return q;
  }

  private parseTranscript(
    transcriptObject?: Array<{ content: string; role: string; words: Array<{ start?: number }> }>
  ): TranscriptEntry[] {
    if (!transcriptObject?.length) return [];
    return transcriptObject.map((entry) => ({
      role: entry.role === "agent" ? "assistant" as const : "user" as const,
      text: entry.content,
      timestamp: entry.words?.[0]?.start
        ? Math.round(entry.words[0].start * 1000)
        : Date.now(),
    }));
  }

  private async monitorCall(callId: string): Promise<void> {
    const activeCall = this.activeCalls.get(callId);
    if (!activeCall) return;

    const pollInterval = setInterval(async () => {
      try {
        const retellCall = await this.client.call.retrieve(activeCall.retellCallId);

        if (retellCall.call_status === "ended" || retellCall.call_status === "error") {
          clearInterval(pollInterval);
          this.activeCalls.delete(callId);

          const durationSeconds = retellCall.duration_ms
            ? Math.round(retellCall.duration_ms / 1000)
            : Math.round((Date.now() - activeCall.startedAt) / 1000);

          const transcript = this.parseTranscript(
            retellCall.transcript_object as Array<{ content: string; role: string; words: Array<{ start?: number }> }> | undefined
          );

          const result: VoiceCallResult = {
            callId,
            phoneNumber: activeCall.phoneNumber,
            status: retellCall.call_status === "error" ? "failed" : "completed",
            durationSeconds,
            transcript: transcript.length > 0 ? transcript : undefined,
            error: retellCall.call_status === "error"
              ? `Call failed: ${retellCall.disconnection_reason ?? "unknown"}`
              : undefined,
          };

          info(
            "voice",
            `Call ${callId} ${result.status} (${durationSeconds}s, ${transcript.length} transcript entries)`
          );
          this.onCallStatus?.(callId, result.status, result);
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
