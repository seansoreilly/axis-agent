---
name: Skill Generator
description: Create new skills from conversation, with structured templates and validation
tags: [meta, skills, self-improvement]
---

# Skill Generator

Create new custom skills when asked by the user. Before building a custom skill, always check the capability routing priority: MCP Server > Community Skill > Custom Skill > One-off Bash. Only use this template when no existing option fits.

## When to Create a Skill

Create a skill when:
- The task is **recurring** (not a one-off)
- It involves an **external service or API** with structured inputs/outputs
- It requires a **multi-step workflow** that benefits from documentation
- No existing MCP server or community skill covers it

Do NOT create a skill for:
- One-off tasks (just use Bash)
- Tasks already covered by Zapier MCP, Trello MCP, or existing skills
- Pure file operations (use built-in Read/Write/Edit tools)

## Step-by-Step Creation Process

### 1. Research

Before building anything:
- Search for `"<service> MCP server"` — if one exists, add it to `.mcp.json` instead
- Search for `"<service> claude skill"` on GitHub — if compatible (headless auth), install it
- Check existing skills in `.claude/skills/` for overlap

### 2. Scaffold Directory

```bash
mkdir -p /home/ubuntu/agent/.claude/skills/<name>/scripts/
```

### 3. Write SKILL.md

Use this template (model after facebook, twilio, gmail skills):

```markdown
---
name: <Human-Readable Name>
description: <One-line description> (headless-compatible)
tags: [<tag1>, <tag2>]
---

# <Name>

<One paragraph overview of what the skill does and how it authenticates.>

Credentials are loaded from `/home/ubuntu/.claude-agent/<name>-credentials.json` or environment variable `<SERVICE>_API_KEY`.

## <Action 1>

\`\`\`bash
python3 /home/ubuntu/agent/.claude/skills/<name>/scripts/<action>.py --arg1 'value' --arg2 'value'
\`\`\`

**Arguments:**
- `--arg1` (required): Description
- `--arg2` (optional, default: X): Description

**Output:** JSON with `success` (boolean), `<result_field>`, or `error`

## Notes

- <Important constraints, rate limits, regional settings>
- <Auth method and credential location>
```

### 4. Write Scripts

**Python** (preferred for API integrations):
```python
#!/usr/bin/env python3
"""<Brief description>."""
import argparse
import json
import sys
import requests

def main():
    parser = argparse.ArgumentParser(description="<Description>")
    parser.add_argument("--arg1", required=True, help="<Help text>")
    args = parser.parse_args()

    # Load credentials
    creds_path = "/home/ubuntu/.claude-agent/<name>-credentials.json"
    with open(creds_path) as f:
        creds = json.load(f)

    try:
        # API call here
        result = {"success": True, "data": "..."}
        print(json.dumps(result))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
        sys.exit(1)

if __name__ == "__main__":
    main()
```

**Node.js** (for file processing or JS ecosystem tools):
```javascript
#!/usr/bin/env node
import { parseArgs } from "node:util";
// ... similar pattern with JSON output
```

**Conventions:**
- Use `argparse` (Python) or `parseArgs` (Node.js) for CLI arguments
- Always output JSON to stdout for machine parsing
- Exit code 0 for success, non-zero for failure
- Load credentials from `/home/ubuntu/.claude-agent/` or env vars — never hardcode
- Use a `_common.py` for shared credential loading if multiple scripts need the same creds
- Keep scripts self-contained (minimal dependencies)
- **All scripts with side effects MUST support `--dry-run`** — validates credentials and inputs without calling external APIs. Returns `{"success": true, "dry_run": true, ...}`. This is used by post-deploy health checks to verify skills are functional.

### 5. Validate

Run through this checklist before considering the skill complete:

- [ ] SKILL.md has valid YAML frontmatter (`name`, `description`, `tags`)
- [ ] All scripts run without errors (`python3 <script> --help`)
- [ ] Scripts produce valid JSON output
- [ ] Credentials path documented and not hardcoded in scripts
- [ ] No secrets committed to skill files
- [ ] SKILL.md examples match actual script arguments
- [ ] Scripts with side effects support `--dry-run` (returns `{"success": true, "dry_run": true, ...}`)
- [ ] Tested with a real API call (or dry-run if destructive)

### 6. Test

Run each documented command with real (or test) inputs. Verify:
- JSON output parses correctly
- Error cases return `{"success": false, "error": "..."}`
- Credential loading works from the documented path

### 7. Log

After creating or fixing a skill, append an entry to `.claude/skills/skill-generator/LEARNINGS.md`.

## Headless Constraints

This agent runs headless under systemd. Only these auth methods work:
- API keys / tokens (stored in env vars or credential files)
- App passwords (e.g., Gmail app password)
- Service accounts (e.g., Google service account JSON)

These do NOT work:
- OAuth 2.0 browser consent flows
- Any interactive authentication prompt
- QR code scanning

## Post-Creation

- If the skill requires credentials the user hasn't provisioned yet, tell them what to set up and where to store it
- If the skill requires new Python packages, install them: `pip3 install <package>`
- If a restart is needed (rare — only if modifying MCP config), run self-deploy
- Skills are available immediately on the next agent query (no restart needed)
