import { defineAgent, voice, type JobContext } from "@livekit/agents";
import * as silero from "@livekit/agents-plugin-silero";
import { SipClient } from "livekit-server-sdk";

const { Agent, AgentSession } = voice;

interface CallMetadata {
  systemPrompt?: string;
  firstMessage?: string;
  phoneNumber?: string;
  sipTrunkId?: string;
}

/**
 * LiveKit voice agent entry file.
 *
 * This runs in a subprocess spawned by AgentServer. It receives call context
 * (system prompt, phone number, SIP trunk) via dispatch metadata set by VoiceService.
 *
 * The agent joins the room first, then dials out via SIP to connect the callee.
 *
 * Uses LiveKit hosted inference — STT/LLM/TTS are specified as model strings
 * and billed through the LiveKit account. No separate provider API keys needed.
 */
export default defineAgent({
  entry: async (ctx: JobContext) => {
    await ctx.connect();

    // Read call context from job metadata (set by VoiceService dispatch)
    const metaStr = ctx.job.metadata ?? ctx.room.metadata ?? "{}";
    let meta: CallMetadata;
    try {
      meta = JSON.parse(metaStr);
    } catch {
      meta = {};
    }

    const systemPrompt =
      meta.systemPrompt ?? "You are a helpful voice assistant.";
    const firstMessage =
      meta.firstMessage ?? "Hello, this is Axis Agent calling.";
    const voiceId = process.env["CARTESIA_VOICE_ID"] ?? "043cfc81-d69f-4bee-ae1e-7862cb358650"; // Australian Woman

    const vad = await silero.VAD.load();

    const agent = new Agent({
      instructions: systemPrompt,
      vad,
      stt: "deepgram/nova-3:en",
      llm: "openai/gpt-4o-mini",
      tts: `cartesia/sonic-2:${voiceId}`,
      turnDetection: "vad",
      allowInterruptions: true,
    });

    const session = new AgentSession({});
    await session.start({ agent, room: ctx.room });

    // Dial out via SIP if this is an outbound call
    if (meta.phoneNumber && meta.sipTrunkId) {
      const lkUrl = (process.env["LIVEKIT_URL"] ?? "")
        .replace("wss://", "https://")
        .replace("ws://", "http://");
      const sipClient = new SipClient(
        lkUrl,
        process.env["LIVEKIT_API_KEY"] ?? "",
        process.env["LIVEKIT_API_SECRET"] ?? "",
      );

      await sipClient.createSipParticipant(
        meta.sipTrunkId,
        meta.phoneNumber,
        ctx.room.name ?? "",
        {
          participantIdentity: `caller-${meta.phoneNumber}`,
          participantName: meta.phoneNumber,
          playDialtone: true,
          ringingTimeout: 30,
          maxCallDuration: 300, // 5 minute max
        },
      );

      // Wait for the callee to join, then greet them
      await ctx.waitForParticipant();
      session.say(firstMessage);
    } else {
      // Inbound call — greet immediately
      session.say(firstMessage);
      await ctx.waitForParticipant();
    }
  },
});
