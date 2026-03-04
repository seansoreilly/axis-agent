---
name: Twilio
description: Send SMS, make voice calls, and manage phone numbers via Twilio (AU1 region, headless-compatible)
tags: [twilio, sms, voice, phone, calls]
---

# Twilio

Send SMS messages, make voice calls with text-to-speech, and list phone numbers via the Twilio API. Configured for the AU1 (Australia) region.

Credentials are stored in `/home/ubuntu/.claude-agent/twilio-credentials.json` (not committed to repo — instance-only).

## Available Numbers

Run `list_numbers.py` to see current numbers and their capabilities. The credentials file stores the default "from" number.

## Send SMS

```bash
python3 /home/ubuntu/agent/.claude/skills/twilio/scripts/send_sms.py --to '+61400000000' --body 'Hello from the agent'
python3 /home/ubuntu/agent/.claude/skills/twilio/scripts/send_sms.py --to '+61400000000' --body 'Hello' --from '+1XXXXXXXXXX'
```

**Arguments:**
- `--to` (required): Recipient phone number in E.164 format (e.g. +61400000000)
- `--body` (required): SMS message body (max 1600 chars, auto-segmented)
- `--from`: Sender number (default: from credentials file)

**Output:** JSON with `success`, `sid`, `to`, `from`, `status`

## Make Voice Call

```bash
python3 /home/ubuntu/agent/.claude/skills/twilio/scripts/make_call.py --to '+61400000000' --message 'Hello, this is your agent calling'
python3 /home/ubuntu/agent/.claude/skills/twilio/scripts/make_call.py --to '+61400000000' --message 'Hello' --from '+61XXXXXXXXX' --voice Polly.Nicole
```

**Arguments:**
- `--to` (required): Recipient phone number in E.164 format
- `--message` (required): Text-to-speech message to read when answered
- `--from`: Caller ID number (default: from credentials file)
- `--voice`: TTS voice (default: Polly.Nicole — Australian English)

**Available voices:** Polly.Nicole (AU female), Polly.Russell (AU male), Polly.Joanna (US female), Polly.Matthew (US male), and [many more](https://www.twilio.com/docs/voice/twiml/say#voice)

**Output:** JSON with `success`, `sid`, `to`, `from`, `status`

## List Numbers

```bash
python3 /home/ubuntu/agent/.claude/skills/twilio/scripts/list_numbers.py
```

**Output:** JSON array of phone numbers with SMS/voice/MMS capabilities

## Notes

- **Region:** This account uses Twilio's AU1 region (api.au1.twilio.com)
- **SMS:** The AU number does NOT support SMS — use the US number for all SMS
- **Voice:** Use the AU number for calls to Australian numbers (local caller ID)
- **E.164 format:** Always include country code with + prefix (e.g. +61412345678, not 0412345678)
