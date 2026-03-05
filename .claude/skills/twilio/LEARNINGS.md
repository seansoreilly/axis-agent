# Twilio Skill Learnings

Append entries below when a Twilio operation succeeds, fails, or requires correction.

## Entry Format

### [date] - [operation] - [outcome: success|failure|correction]
- **What happened**: Brief description
- **Root cause** (if failure/correction): What went wrong
- **Fix applied**: What was changed
- **Lesson**: What to do differently next time

---

<!-- Entries below -->

### 2026-03-05 - AU1 authentication - correction
- **What happened**: Twilio AU1 region returned error 20003 (Authenticate) when using Account SID + Auth Token for Basic auth.
- **Root cause**: AU1 region requires API Key SID + API Key Secret for authentication, not the main Account SID + Auth Token.
- **Fix applied**: Updated `_common.py` `load_credentials()` to prefer `api_key_sid`/`api_key_secret` over `account_sid`/`auth_token`.
- **Lesson**: Twilio regional deployments (AU1, IE1, etc.) require API Key auth. Always prefer API Key credentials.

### 2026-03-05 - SMS number capability - lesson
- **What happened**: Attempted to send SMS from the Australian number, which failed.
- **Lesson**: The AU number does NOT support SMS — only voice. Use the US number for all SMS sending. Run `list_numbers.py` to check capabilities before assuming a number can send SMS.

### 2026-03-05 - contact lookup integration - correction
- **What happened**: Agent asked the user for phone numbers instead of looking them up via Google Contacts.
- **Root cause**: SOUL.md personality file overrode the agent's system prompt, which contained the contact lookup instructions.
- **Fix applied**: Added mandatory contact lookup instructions to SOUL.md.
- **Lesson**: When sending SMS/calls to contacts, always look up the phone number via Google Contacts first (`scripts/lookup-contact.js`). Never ask the user for a number if a contact name is provided.

### 2026-03-05 - E.164 format - lesson
- **What happened**: Phone numbers must be in E.164 format (+61412345678, not 0412345678).
- **Lesson**: Always validate and convert phone numbers to E.164 before passing to Twilio. Australian mobiles: strip leading 0, prepend +61.
