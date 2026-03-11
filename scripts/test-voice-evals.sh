#!/usr/bin/env bash
# Run Vapi Evals against the voice agent's assistant configuration
# Usage: bash scripts/test-voice-evals.sh [eval-name]
# Requires: VAPI_API_KEY env var
set -euo pipefail

if [ -z "${VAPI_API_KEY:-}" ]; then
  # Load from .env without sourcing (avoids issues with special chars)
  if [ -f .env ]; then
    VAPI_API_KEY=$(grep -oP 'VAPI_API_KEY=\K.*' .env || true)
  fi
  if [ -z "${VAPI_API_KEY:-}" ]; then
    echo "ERROR: VAPI_API_KEY not set" >&2
    exit 1
  fi
fi

VAPI_BASE="https://api.vapi.ai"
FILTER="${1:-all}"
PASS=0
FAIL=0
ERRORS=()

# The assistant config we're testing (matches voice.ts buildCallBody for human calls)
read -r -d '' ASSISTANT_CONFIG << 'ASSISTANT_EOF' || true
{
  "firstMessageMode": "assistant-waits-for-user",
  "model": {
    "provider": "openai",
    "model": "gpt-4o-mini",
    "tools": [{"type": "endCall"}],
    "messages": [{
      "role": "system",
      "content": "You are a personal AI assistant on a phone call.\nYou are calling on behalf of Sean.\nYou are calling Mum.\n\n# Call Purpose\nAsk what time dinner is tonight\n\n# Opening\nWait for the other person to say hello first, then respond.\nYour FIRST message must combine a brief greeting with your question — do NOT greet and then wait.\nExample: \"Hi Mum, calling on behalf of Sean. What time is dinner tonight?\"\n\n# How to talk\n- Be casual and quick, like texting but out loud\n- One sentence per turn, two max\n- Use words like gotcha, cool, right, sounds good\n- Match their energy\n\n# Flow\n1. Wait for them to say hello, then greet + ask your question\n2. Wait for their answer — do NOT keep talking\n3. When they answer, you MUST say your confirmation out loud BEFORE calling endCall\n\n## CRITICAL: Always speak before ending the call\nYou MUST always include spoken text in your response. NEVER call endCall without also saying something.\nEvery response must have content (spoken words). A tool call alone with no text is WRONG.\n\n## Response template (FOLLOW THIS EXACTLY):\n- They say \"7:30\" → You say: \"Gotcha, 7:30. Thanks, bye!\" then use the endCall tool\n- They say \"Tuesday\" → You say: \"Cool, Tuesday. Thanks, bye!\" then use the endCall tool\n\nIMPORTANT: Never say the words 'endCall' or 'call endCall' out loud. The endCall tool is a silent action, not spoken words.\n\nWRONG (never do this):\n- Calling endCall without saying anything first\n- Saying 'endCall' out loud as part of your speech\n- Just saying \"Goodbye\" without confirming their answer\n- Saying \"OK\" then waiting, then saying \"bye\" in a separate turn\n\n# Ending the call\n- ALWAYS speak your farewell out loud AND use the endCall tool in the same turn\n- If they say bye first, respond with a quick bye AND use endCall\n\n# Rules\n- Never ask 'how are you'\n- Never say goodbye or thanks more than once\n- Never mention that you're an AI unless directly asked"
    }]
  },
  "voice": {
    "provider": "cartesia",
    "voiceId": "043cfc81-d69f-4bee-ae1e-7862cb358650"
  },
  "silenceTimeoutSeconds": 30,
  "maxDurationSeconds": 300,
  "backgroundSound": "off",
  "startSpeakingPlan": {
    "waitSeconds": 0.8,
    "smartEndpointingEnabled": true,
    "transcriptionEndpointingPlan": {
      "onPunctuationSeconds": 0.5,
      "onNoPunctuationSeconds": 1.5,
      "onNumberSeconds": 1.0
    }
  },
  "stopSpeakingPlan": {
    "numWords": 2,
    "backoffSeconds": 1
  }
}
ASSISTANT_EOF

# Helper: create eval, run it, poll for result
run_eval() {
  local name="$1"
  local description="$2"
  local messages="$3"

  if [ "$FILTER" != "all" ] && [ "$FILTER" != "$name" ]; then
    return
  fi

  echo ""
  echo "━━━ Running: $name ━━━"
  echo "    $description"

  # Create eval
  local eval_body
  eval_body=$(jq -n \
    --arg name "$name" \
    --arg desc "$description" \
    --argjson msgs "$messages" \
    '{name: $name, description: $desc, type: "chat.mockConversation", messages: $msgs}')

  local eval_resp
  eval_resp=$(curl -sf -X POST "$VAPI_BASE/eval" \
    -H "Authorization: Bearer $VAPI_API_KEY" \
    -H "Content-Type: application/json" \
    -d "$eval_body" 2>&1) || {
    echo "    ✗ Failed to create eval: $eval_resp"
    FAIL=$((FAIL + 1))
    ERRORS+=("$name: failed to create eval")
    return
  }

  local eval_id
  eval_id=$(echo "$eval_resp" | jq -r '.id')
  echo "    Eval ID: $eval_id"

  # Run eval against transient assistant
  local run_body
  run_body=$(jq -n \
    --arg eid "$eval_id" \
    --argjson assistant "$ASSISTANT_CONFIG" \
    '{type: "eval", evalId: $eid, target: {type: "assistant", assistant: $assistant}}')

  local run_resp
  run_resp=$(curl -s -X POST "$VAPI_BASE/eval/run" \
    -H "Authorization: Bearer $VAPI_API_KEY" \
    -H "Content-Type: application/json" \
    -d "$run_body" 2>&1)
  local run_error
  run_error=$(echo "$run_resp" | jq -r '.error // empty' 2>/dev/null)
  if [ -n "$run_error" ]; then
    echo "    ✗ Failed to start eval run: $run_resp"
    FAIL=$((FAIL + 1))
    ERRORS+=("$name: failed to start run")
    curl -sf -X DELETE "$VAPI_BASE/eval/$eval_id" -H "Authorization: Bearer $VAPI_API_KEY" > /dev/null 2>&1 || true
    return
  fi

  local run_id
  run_id=$(echo "$run_resp" | jq -r '.evalRunId // .id')
  echo "    Run ID: $run_id"

  # Poll for completion (max 60s)
  local status="running"
  local attempts=0
  while [ "$status" = "running" ] || [ "$status" = "queued" ]; do
    sleep 3
    attempts=$((attempts + 1))
    if [ $attempts -gt 20 ]; then
      echo "    ✗ Timed out after 60s"
      FAIL=$((FAIL + 1))
      ERRORS+=("$name: timed out")
      curl -sf -X DELETE "$VAPI_BASE/eval/$eval_id" -H "Authorization: Bearer $VAPI_API_KEY" > /dev/null 2>&1 || true
      return
    fi

    local result_resp
    result_resp=$(curl -s "$VAPI_BASE/eval/run/$run_id" \
      -H "Authorization: Bearer $VAPI_API_KEY" 2>&1) || continue

    status=$(echo "$result_resp" | jq -r '.status // "running"')

    if [ "$status" = "ended" ]; then
      local ended_reason
      ended_reason=$(echo "$result_resp" | jq -r '.endedReason // "unknown"')

      # Extract results
      local all_passed
      all_passed=$(echo "$result_resp" | jq '[.results[]? | .status] | all(. == "pass")' 2>/dev/null || echo "false")

      # Show conversation transcript
      echo "    Transcript:"
      echo "$result_resp" | jq -r '.results[0]?.messages[]? | "      \(.role): \(.content // "(tool call)" | .[0:100])"' 2>/dev/null || true

      if [ "$all_passed" = "true" ]; then
        echo "    ✓ PASSED"
        PASS=$((PASS + 1))
      else
        echo "    ✗ FAILED (reason: $ended_reason)"
        # Show failure details
        echo "$result_resp" | jq -r '.results[]? | select(.status == "fail") | "      Judge: \(.judge // {} | tostring | .[0:200])"' 2>/dev/null || true
        FAIL=$((FAIL + 1))
        ERRORS+=("$name: eval failed")
      fi
    fi
  done

  # Clean up eval
  curl -sf -X DELETE "$VAPI_BASE/eval/$eval_id" -H "Authorization: Bearer $VAPI_API_KEY" > /dev/null 2>&1 || true
}

echo "╔══════════════════════════════════════╗"
echo "║   Vapi Voice Agent Eval Suite        ║"
echo "╚══════════════════════════════════════╝"

# ─── Test 1: Waits for user to speak first ───
run_eval "wait-for-hello" \
  "Agent should wait for the receiver to say hello before speaking" \
  '[
    {"role": "user", "content": "Hello?"},
    {
      "role": "assistant",
      "judgePlan": {
        "type": "ai",
        "model": {
          "provider": "openai",
          "model": "gpt-4o",
          "messages": [{"role": "system", "content": "The assistant is on a phone call on behalf of Sean, calling Mum to ask about dinner time. The user just said hello. Evaluate: does the assistant combine a greeting WITH its question in a single response? It should say something like \"Hi Mum, Sean asked me to call - what time is dinner tonight?\" NOT just \"Hello\" or \"Hi\" alone. PASS if greeting + question are in one message. FAIL if greeting only with no question, or if it asks how they are. Output only: pass or fail"}]
        }
      }
    }
  ]'

# ─── Test 2: Waits for answer before responding ───
run_eval "waits-for-answer" \
  "Agent should ask question then wait — not keep talking" \
  '[
    {"role": "user", "content": "Hello?"},
    {
      "role": "assistant",
      "judgePlan": {
        "type": "ai",
        "model": {
          "provider": "openai",
          "model": "gpt-4o",
          "messages": [{"role": "system", "content": "The assistant is calling to ask what time dinner is. It should greet and ask the question. PASS if the response ends with a question or question mark and does NOT answer its own question or keep rambling. The response should be 1-2 sentences max. FAIL if it is more than 2 sentences or does not ask a question. Output only: pass or fail"}]
        }
      }
    },
    {"role": "user", "content": "Oh hi! Dinner is at 7:30."},
    {
      "role": "assistant",
      "judgePlan": {
        "type": "ai",
        "model": {
          "provider": "openai",
          "model": "gpt-4o",
          "messages": [{"role": "system", "content": "The user said dinner is at 7:30. The assistant should confirm the answer (mentioning 7:30), say thanks and bye in the SAME message. PASS if it confirms 7:30 and says bye/thanks in one message. FAIL if it just says bye without confirming, or asks another question, or splits into multiple messages. Output only: pass or fail"}]
        }
      }
    }
  ]'

# ─── Test 3: Calls endCall after farewell ───
run_eval "calls-endcall" \
  "Agent should call endCall tool immediately after saying bye" \
  '[
    {"role": "user", "content": "Hello?"},
    {
      "role": "assistant",
      "judgePlan": {
        "type": "ai",
        "model": {
          "provider": "openai",
          "model": "gpt-4o",
          "messages": [{"role": "system", "content": "PASS if the assistant greets and asks about dinner time. Output only: pass or fail"}]
        }
      }
    },
    {"role": "user", "content": "Around 6 oclock"},
    {
      "role": "assistant",
      "judgePlan": {
        "type": "ai",
        "model": {
          "provider": "openai",
          "model": "gpt-4o",
          "messages": [{"role": "system", "content": "The user said dinner is around 6 oclock. The assistant should confirm the time (mention 6) and say bye/thanks in the same message. PASS if it confirms the time and says bye. FAIL if it asks another question or does not confirm the time. Output only: pass or fail"}]
        }
      }
    }
  ]'

# ─── Test 4: Does not ask "how are you" ───
run_eval "no-how-are-you" \
  "Agent should never ask how are you" \
  '[
    {"role": "user", "content": "Hey! Who is this?"},
    {
      "role": "assistant",
      "judgePlan": {
        "type": "ai",
        "model": {
          "provider": "openai",
          "model": "gpt-4o",
          "messages": [{"role": "system", "content": "The caller asked who is this. The assistant should identify itself briefly (calling on behalf of Sean) and state its purpose (asking about dinner time). PASS if it identifies itself and states purpose without asking \"how are you\" or similar pleasantries. FAIL if it asks \"how are you\" or \"how are things\" or similar. Output only: pass or fail"}]
        }
      }
    }
  ]'

# ─── Test 5: Handles short answers ───
run_eval "handles-short-answer" \
  "Agent should handle a one-word answer gracefully" \
  '[
    {"role": "user", "content": "Yep?"},
    {
      "role": "assistant",
      "judgePlan": {
        "type": "ai",
        "model": {
          "provider": "openai",
          "model": "gpt-4o",
          "messages": [{"role": "system", "content": "PASS if assistant greets and asks about dinner time. Output only: pass or fail"}]
        }
      }
    },
    {"role": "user", "content": "Seven"},
    {
      "role": "assistant",
      "judgePlan": {
        "type": "ai",
        "model": {
          "provider": "openai",
          "model": "gpt-4o",
          "messages": [{"role": "system", "content": "The user said \"Seven\" meaning 7 oclock for dinner. The assistant should confirm seven/7, say thanks and bye, and call endCall. PASS if it does all of this in one turn. FAIL if it asks a follow-up question like \"7 AM or PM?\" or does not call endCall. Output only: pass or fail"}]
        }
      }
    }
  ]'

# ─── Test 6: Does not reveal AI nature unprompted ───
run_eval "no-ai-reveal" \
  "Agent should not mention being an AI unless asked directly" \
  '[
    {"role": "user", "content": "Hello, who is calling?"},
    {
      "role": "assistant",
      "judgePlan": {
        "type": "ai",
        "model": {
          "provider": "openai",
          "model": "gpt-4o",
          "messages": [{"role": "system", "content": "The user asked who is calling. The assistant should say it is calling on behalf of Sean and ask about dinner. PASS if it does NOT mention being an AI, robot, virtual assistant, or language model. FAIL if it reveals it is an AI. Output only: pass or fail"}]
        }
      }
    }
  ]'

# ─── Test 7: Does not say "endCall" out loud ───
run_eval "no-endcall-leak" \
  "Agent should never say endCall out loud in its speech" \
  '[
    {"role": "user", "content": "Hi there"},
    {"role": "assistant", "judgePlan": {"type": "ai", "model": {"provider": "openai", "model": "gpt-4o", "messages": [{"role": "system", "content": "PASS if assistant greets and asks about dinner. Output only: pass or fail"}]}}},
    {"role": "user", "content": "Its at 8"},
    {
      "role": "assistant",
      "judgePlan": {
        "type": "ai",
        "model": {
          "provider": "openai",
          "model": "gpt-4o",
          "messages": [{"role": "system", "content": "Check the assistant spoken text (content field). PASS if the spoken text does NOT contain the literal words \"endCall\" or \"call endCall\" or \"AND call endCall\". The assistant may USE the endCall tool (that is fine) but should not SAY the word endCall out loud. FAIL if the spoken text contains endCall as a word. Output only: pass or fail"}]
        }
      }
    }
  ]'

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Results: $PASS passed, $FAIL failed"
if [ ${#ERRORS[@]} -gt 0 ]; then
  echo ""
  echo "Failures:"
  for err in "${ERRORS[@]}"; do
    echo "  - $err"
  done
fi
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

exit $FAIL
