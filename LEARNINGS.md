# Learnings

Important discoveries, debugging insights, and non-obvious behaviors. Prevents repeating the same mistakes across conversations.

See `CLAUDE.md` → **Learnings** section for the entry format and auto-retain rules.

---

### 2026-03-05 - skill-generator - lesson
- **What happened**: Twilio skill had SKILL.md and `_common.py` but `send_sms.py` was never created. Skeleton committed without functional scripts.
- **Lesson**: A skill isn't done until you can run its commands end-to-end. Always create the actual executable scripts alongside SKILL.md.

### 2026-03-05 - twilio - fix
- **What happened**: Twilio AU1 region returned error 20003 (Authenticate) when using Account SID + Auth Token for Basic auth.
- **Root cause**: AU1 region requires API Key SID + API Key Secret, not the main Account SID + Auth Token.
- **Fix/Pattern**: Updated `load_credentials()` to prefer API Key credentials when available.
- **Lesson**: Twilio regional deployments (AU1, IE1, etc.) require API Key auth. Always prefer API Key credentials over Account SID + Auth Token.

### 2026-03-05 - agent - fix
- **What happened**: Agent ignored contact lookup instructions and asked the user for phone numbers directly.
- **Root cause**: SOUL.md was loaded as the core prompt, completely bypassing the fallback prompt in `agent.ts` which contained contact lookup instructions.
- **Fix/Pattern**: Added contact lookup section to SOUL.md.
- **Lesson**: When the agent uses SOUL.md, ALL critical instructions must be there — the fallback prompt in agent.ts is never used.

### 2026-03-08 - bitwarden - workaround
- **What happened**: `bw unlock --raw` doesn't work with interactive input in Claude Code's bash tool. Session tokens don't persist across bash invocations.
- **Fix/Pattern**: Chain unlock + operations + lock in a single bash command.
- **Lesson**: For Bitwarden operations in Claude Code, always chain all commands in one bash call. Ask user for master password via AskUserQuestion if needed.

### 2026-03-09 - voice (vapi) - fix
- **What happened**: Voice agent confirmed answer in one turn, then paused before saying goodbye in a separate turn.
- **Root cause**: LLM interpreted "say farewell then call endCall" as two separate turns.
- **Fix/Pattern**: Prompt explicitly says "confirm AND say bye in the SAME response" with concrete example: `"Gotcha, 3pm. Thanks, bye!" [endCall]`.
- **Lesson**: LLMs on voice calls split actions across turns unless explicitly told to combine them. Always provide concrete single-turn examples.

### 2026-03-09 - voice (vapi) - pattern
- **What happened**: IVR and human calls need completely different Vapi configs.
- **Lesson**: IVR calls: `assistant-waits-for-user`, slow endpointing (2.0s+), high `stopSpeakingPlan.numWords` (8), `smartEndpointingEnabled: false`, short prompt enforcing listen-then-answer. Human calls: `assistant-speaks-first`, fast endpointing (0.1-0.8s), low `numWords` (2), `smartEndpointingEnabled: true`. Detect IVR via context keywords.

### 2026-03-09 - voice (vapi) - lesson
- **What happened**: gpt-4o caused noticeable pauses between turns due to model latency.
- **Lesson**: For voice calls, gpt-4o-mini provides much faster response times with minimal quality loss for simple tasks. Reserve gpt-4o for complex calls.
