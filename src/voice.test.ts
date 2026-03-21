import { describe, it, expect, vi, beforeEach } from "vitest";
import { VoiceService, type VoiceCallRequest } from "./voice.js";

// Mock logger
vi.mock("./logger.js", () => ({
  info: vi.fn(),
  error: vi.fn(),
}));

// Mock retell-sdk
let capturedCreateArgs: Record<string, unknown> | null = null;

vi.mock("retell-sdk", () => {
  return {
    default: class MockRetell {
      call = {
        createPhoneCall: vi.fn().mockImplementation(async (args: Record<string, unknown>) => {
          capturedCreateArgs = args;
          return { call_id: "test-retell-call-id", call_status: "registered" };
        }),
        retrieve: vi.fn().mockResolvedValue({ call_status: "ongoing" }),
      };
    },
  };
});

function createService(): VoiceService {
  const config = {
    apiKey: "test-key",
    phoneNumber: "+14157774444",
    agentId: "test-agent-id",
    voiceId: "test-voice-id",
  };
  return new VoiceService(config);
}

describe("VoiceService", () => {
  let service: VoiceService;

  beforeEach(() => {
    service = createService();
    capturedCreateArgs = null;
  });

  describe("firstMessage generation", () => {
    async function getCallArgs(request: VoiceCallRequest) {
      await service.makeCall(request);
      return capturedCreateArgs;
    }

    it("transforms 'Ask what they are having for breakfast' into a natural question", async () => {
      const args = await getCallArgs({
        phoneNumber: "+1234567890",
        context: "Ask what they are having for breakfast today",
      });
      const override = args?.agent_override as Record<string, unknown>;
      const llm = override?.retell_llm as Record<string, unknown>;
      const msg = llm.begin_message as string;
      expect(msg).toContain("What are you having for breakfast today?");
      expect(msg).toMatch(/^Hi there/);
    });

    it("transforms 'Ask them what time dinner is' correctly", async () => {
      const args = await getCallArgs({
        phoneNumber: "+1234567890",
        context: "Ask them what time dinner is",
      });
      const override = args?.agent_override as Record<string, unknown>;
      const llm = override?.retell_llm as Record<string, unknown>;
      const msg = llm.begin_message as string;
      expect(msg).toContain("What time dinner is?");
    });

    it("passes through direct questions unchanged", async () => {
      const args = await getCallArgs({
        phoneNumber: "+1234567890",
        context: "What time is the meeting?",
      });
      const override = args?.agent_override as Record<string, unknown>;
      const llm = override?.retell_llm as Record<string, unknown>;
      const msg = llm.begin_message as string;
      expect(msg).toContain("What time is the meeting?");
    });

    it("transforms 'Ask if they need a ride' with pronoun swap", async () => {
      const args = await getCallArgs({
        phoneNumber: "+1234567890",
        context: "Ask if they need a ride to the airport",
      });
      const override = args?.agent_override as Record<string, unknown>;
      const llm = override?.retell_llm as Record<string, unknown>;
      const msg = llm.begin_message as string;
      expect(msg).toContain("Do you need a ride to the airport?");
    });

    it("transforms remind context into reminder", async () => {
      const args = await getCallArgs({
        phoneNumber: "+1234567890",
        context: "Remind them about the appointment at 3",
      });
      const override = args?.agent_override as Record<string, unknown>;
      const llm = override?.retell_llm as Record<string, unknown>;
      const msg = llm.begin_message as string;
      expect(msg).toContain("Just a reminder about the appointment at 3.");
    });

    it("uses recipientName in greeting", async () => {
      const args = await getCallArgs({
        phoneNumber: "+1234567890",
        recipientName: "Sarah",
        context: "What time is dinner?",
      });
      const override = args?.agent_override as Record<string, unknown>;
      const llm = override?.retell_llm as Record<string, unknown>;
      const msg = llm.begin_message as string;
      expect(msg).toMatch(/^Hi Sarah/);
    });

    it("uses static greeting when no context", async () => {
      const args = await getCallArgs({ phoneNumber: "+1234567890" });
      const override = args?.agent_override as Record<string, unknown>;
      const llm = override?.retell_llm as Record<string, unknown>;
      expect(llm.begin_message).toBe("Hi there.");
    });
  });

  describe("call configuration", () => {
    it("uses start_speaker 'user' for human calls", async () => {
      await service.makeCall({ phoneNumber: "+1234567890", context: "Hi" });
      const override = capturedCreateArgs?.agent_override as Record<string, unknown>;
      const llm = override?.retell_llm as Record<string, unknown>;
      expect(llm.start_speaker).toBe("user");
    });

    it("uses start_speaker 'user' for IVR calls", async () => {
      await service.makeCall({
        phoneNumber: "+1234567890",
        context: "Navigate the IVR menu and press 1",
      });
      const override = capturedCreateArgs?.agent_override as Record<string, unknown>;
      const llm = override?.retell_llm as Record<string, unknown>;
      expect(llm.start_speaker).toBe("user");
    });

    it("sets empty begin_message for IVR calls", async () => {
      await service.makeCall({
        phoneNumber: "+1234567890",
        context: "Call the automated support line",
      });
      const override = capturedCreateArgs?.agent_override as Record<string, unknown>;
      const llm = override?.retell_llm as Record<string, unknown>;
      expect(llm.begin_message).toBe("");
    });
  });

  describe("system prompt", () => {
    it("includes Call Purpose for human calls", async () => {
      await service.makeCall({
        phoneNumber: "+1234567890",
        context: "Ask about breakfast",
      });
      const dynVars = capturedCreateArgs?.retell_llm_dynamic_variables as Record<string, unknown>;
      const prompt = dynVars?.system_prompt as string;
      expect(prompt).toContain("Call Purpose");
      expect(prompt).toContain("Ask about breakfast");
    });

    it("includes IVR rules for IVR calls", async () => {
      await service.makeCall({
        phoneNumber: "+1234567890",
        context: "Navigate the automated phone menu",
      });
      const dynVars = capturedCreateArgs?.retell_llm_dynamic_variables as Record<string, unknown>;
      const prompt = dynVars?.system_prompt as string;
      expect(prompt).toContain("IVR");
    });

    it("uses claude-4.6-sonnet model", async () => {
      await service.makeCall({ phoneNumber: "+1234567890" });
      const override = capturedCreateArgs?.agent_override as Record<string, unknown>;
      const llm = override?.retell_llm as Record<string, unknown>;
      expect(llm.model).toBe("claude-4.6-sonnet");
    });

    it("sends from_number and to_number correctly", async () => {
      await service.makeCall({ phoneNumber: "+61400000000" });
      expect(capturedCreateArgs?.from_number).toBe("+14157774444");
      expect(capturedCreateArgs?.to_number).toBe("+61400000000");
    });
  });
});
