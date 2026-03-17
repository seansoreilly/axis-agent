# Skill Generation Learnings

Append entries below when a skill creation succeeds, fails, or requires correction.

## Entry Format

### [date] - [skill-name] - [outcome: success|failure|correction]
- **What happened**: Brief description
- **Root cause** (if failure/correction): What went wrong
- **Fix applied**: What was changed
- **Lesson**: What to do differently next time

---

<!-- Entries below -->

### 2026-03-05 - twilio - correction
- **What happened**: Twilio skill had SKILL.md and `_common.py` but `send_sms.py` was never created. The skill was documented but non-functional.
- **Root cause**: Skeleton was committed (SKILL.md + shared helpers) without the actual scripts that do the work.
- **Fix applied**: Created `send_sms.py` using stdlib `urllib` (no external deps) and the existing `_common.py` helpers.
- **Lesson**: Always create the actual executable scripts alongside SKILL.md. A skill isn't done until you can run its commands end-to-end.

### 2026-03-05 - twilio - correction
- **What happened**: Twilio AU1 region returned error 20003 (Authenticate) when using Account SID + Auth Token for Basic auth.
- **Root cause**: AU1 region requires API Key SID + API Key Secret for authentication, not the main Account SID + Auth Token. The credentials file had both `api_key_sid`/`api_key_secret` and `account_sid`/`auth_token`, but `_common.py` only used the latter.
- **Fix applied**: Updated `load_credentials()` to return a 5-tuple, preferring API Key credentials when available. Updated `make_auth_header()` to accept generic auth_user/auth_secret params.
- **Lesson**: Twilio regional deployments (AU1, IE1, etc.) require API Key auth. When building Twilio integrations, always prefer API Key credentials over Account SID + Auth Token.

### 2026-03-05 - twilio - correction
- **What happened**: Agent ignored the contact lookup instructions and asked the user for phone numbers instead of looking them up via gws CLI.
- **Root cause**: SOUL.md was loaded as the core prompt, completely bypassing the built-in fallback prompt in `agent.ts` which contained the contact lookup instructions. SOUL.md had no contact lookup section.
- **Fix applied**: Added the "Contact Lookup" section to SOUL.md with gws CLI command for lookup → extract → send.
- **Lesson**: When the agent uses SOUL.md for personality, ALL critical instructions must be in SOUL.md — the built-in fallback prompt in agent.ts is never used. Any new workflow instructions must be added to SOUL.md, not just agent.ts.

### 2026-03-05 - general - lesson
- **What happened**: Skill scripts handle credentials (API keys, tokens, auth secrets) that get loaded from JSON files or env vars.
- **Lesson**: Before deploying any skill script, always audit for hardcoded secrets, debug logging that could leak credentials, or credential values that could end up in git. Check that credentials are loaded from external files/env vars only, never embedded in code.

### 2026-03-08 - claude-admin - success
- **What happened**: Created Claude Code Admin skill for Anthropic Admin API (org management, users, API keys, workspaces, invites).
- **Lesson**: The Anthropic Admin API uses `sk-ant-admin...` keys (different from regular API keys). Base URL is `https://api.anthropic.com/v1/organizations/`. The Admin API covers org/user/key/workspace management but does NOT expose subscription billing (Claude Pro/Max/Team plans) — only API usage. New API keys can only be created via Console UI, not via API.

### 2026-03-08 - bitwarden - lesson
- **What happened**: Bitwarden CLI `bw unlock --raw` doesn't work with interactive input in Claude Code's bash tool. Each bash invocation is a separate process so BW_SESSION tokens don't persist.
- **Fix applied**: Pass password directly to `bw unlock 'password' --raw` and chain all commands in a single bash call.
- **Lesson**: For Bitwarden operations in Claude Code, always chain unlock + operations + lock in a single bash command. The session token won't persist across separate tool invocations. Ask user for master password via AskUserQuestion if needed.

### 2026-03-09 - voice (vapi) - correction
- **What happened**: Voice agent was phoning but not waiting for responses. The call would play the greeting and not engage in conversation.
- **Root cause**: Using `assistantId` + `assistantOverrides` meant the base Vapi assistant's turn-taking and silence settings controlled behavior. No `silenceTimeoutSeconds` was configured, so the agent timed out immediately on silence. Also attempted to use `hooks` in `assistantOverrides` which Vapi rejected with a 400 error — hooks are not supported in overrides.
- **Fix applied**: Switched from `assistantId` + overrides to a fully inline transient `assistant` config. Added `silenceTimeoutSeconds: 30` (15 for IVR), `maxDurationSeconds: 300`, `backgroundSound: "off"`, and explicit `firstMessageMode: "assistant-speaks-first"`. Made `VAPI_ASSISTANT_ID` optional since it's no longer needed.
- **Lesson**: Always use inline transient assistant config with Vapi for full dynamic control. Key settings for conversational calls: `silenceTimeoutSeconds` (30s for humans, 15s for IVR), `maxDurationSeconds`, `firstMessageMode`. The `hooks` property is NOT supported in `assistantOverrides` or the REST API create call endpoint — only in dashboard-configured assistants. Context-aware configuration (detecting IVR vs human calls) improves behavior.

### 2026-03-09 - voice (vapi) - correction
- **What happened**: Voice agent couldn't end calls naturally. It would say goodbye but leave the line open, running until the silence timeout.
- **Root cause**: No `endCall` tool was configured. The LLM had no function to actually hang up the call. The DTMF tool was in `toolIds` but endCall needs to go in `model.tools` as `{ type: "endCall" }`.
- **Fix applied**: Added `{ type: "endCall" }` to `model.tools` array. Updated system prompt with explicit "Ending the Call" section instructing the LLM to use endCall when the conversation concludes, the other person says goodbye, or becomes unresponsive.
- **Lesson**: Vapi's endCall is a built-in tool type — add it via `model.tools: [{ type: "endCall" }]`, not via `toolIds`. The LLM also needs explicit system prompt instructions to use it, including when to trigger it (purpose fulfilled, goodbye said, unresponsive caller). Without both the tool AND the instructions, the agent won't hang up.

### 2026-03-09 - voice (vapi) - correction
- **What happened**: Long pregnant pauses between turns made the conversation feel unnatural and slow.
- **Root cause**: No `startSpeakingPlan` or `transcriptionEndpointingPlan` configured. Vapi defaults are conservative (0.4s wait, 1.5s no-punctuation timeout), causing noticeable delays between the user finishing speaking and the assistant responding.
- **Fix applied**: Added `startSpeakingPlan` with `waitSeconds: 0.2`, `smartEndpointingEnabled: true`, and `transcriptionEndpointingPlan` with aggressive timings (0.1s punctuation, 0.8s no-punctuation, 0.3s numbers). Added `stopSpeakingPlan` with `numWords: 2` and `backoffSeconds: 1` so the assistant yields quickly when interrupted.
- **Lesson**: For natural-feeling voice calls, always configure: `startSpeakingPlan.waitSeconds` (0.2s), `smartEndpointingEnabled: true`, and `transcriptionEndpointingPlan` with sub-second timings. The `stopSpeakingPlan` controls interruption behavior — `numWords: 2` means the assistant stops after hearing 2 words from the user mid-speech.

### 2026-03-09 - voice (vapi) - correction
- **What happened**: Voice agent confirmed the answer in one turn, then had a long pause before saying goodbye in a separate turn. User heard dead air and said "Hello?" before the agent said goodbye.
- **Root cause**: The system prompt told the LLM to "say farewell then call endCall" which the LLM interpreted as two separate turns: (1) confirm + thanks, (2) goodbye + endCall. The separation caused a noticeable pause.
- **Fix applied**: Updated prompt to explicitly say "confirm AND say bye in the SAME response, then immediately call endCall" with a concrete example: `"Gotcha, 3pm. Thanks, bye!" [endCall]`. Also added "Do NOT confirm in one message and then say goodbye in a separate message". Verified via Vapi eval API.
- **Lesson**: LLMs on voice calls will split actions across turns unless explicitly told to combine them. Always provide concrete examples of the desired single-turn output. Use Vapi's eval API (`POST /eval`, `POST /eval/run`, `GET /eval/run/{id}`) with `type: "ai"` judges for iterative prompt testing without making real phone calls.

### 2026-03-09 - voice (vapi) - lesson
- **What happened**: gpt-4o caused noticeable pauses between turns due to model latency.
- **Lesson**: For voice calls, gpt-4o-mini provides much faster response times with minimal quality loss for simple conversational tasks. Use gpt-4o-mini as the default voice model. Reserve gpt-4o for complex calls requiring nuanced understanding.

### 2026-03-09 - voice (vapi) - correction
- **What happened**: Voice agent talked over an IVR system, dumped all context in the first message, and got cut off mid-word by its own `stopSpeakingPlan`. The agent said single-word fragments ("I'm", "got", "Sounds") as the IVR was speaking.
- **Root cause**: Three issues: (1) IVR detection only checked for "ivr", "menu", "automated" — missed "support", "demo", "after-hours" etc. (2) `firstMessageMode` was set to speak first even for IVR calls. (3) Turn-taking settings were tuned for human conversation — `waitSeconds: 0.2`, `stopSpeakingPlan.numWords: 2` caused the agent to interrupt and get interrupted constantly.
- **Fix applied**: Added `isIvrCall()` with broader keyword detection. For IVR calls: `firstMessageMode: "assistant-waits-for-user"`, `waitSeconds: 1.0`, `onPunctuationSeconds: 0.8`, `onNoPunctuationSeconds: 1.5`, `stopSpeakingPlan.numWords: 5`. Added IVR-specific system prompt: "answer ONLY what is asked, one question at a time", "wait for the system to finish speaking", "do NOT dump all your information at once".
- **Lesson**: IVR and human calls need completely different Vapi configs. IVR calls: `assistant-waits-for-user`, slow endpointing (2.0s punctuation, 2.5s no-punctuation), high `stopSpeakingPlan.numWords` (8), `smartEndpointingEnabled: false`, no SOUL.md injection (keep prompt short), and system prompt that enforces listen-then-answer behavior. Human calls: `assistant-speaks-first`, fast endpointing (0.1-0.8s), low `numWords` (2), `smartEndpointingEnabled: true`. Detect IVR via context keywords: "ivr", "menu", "automated", "support", "demo", "after-hours", "hotline", "helpline", "switchboard", "test line", "voicemail", "phone tree", "press". Note: DTMF works (tool is invoked correctly) but post-DTMF audio from IVR systems may not be transcribed — appears to be a Vapi platform limitation.
