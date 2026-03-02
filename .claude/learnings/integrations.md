# Integration Learnings

## Adding a Native MCP Server

When Zapier MCP doesn't cover a service (or the connection is unreliable), build a custom MCP server:

1. **Create `src/<service>-mcp-server.ts`** using `@modelcontextprotocol/sdk`
2. **Register in `.mcp.json`** — use `"command": "node", "args": ["dist/<service>-mcp-server.js"]`
3. **No env block needed in `.mcp.json`** — the MCP server process inherits env vars from the parent (systemd EnvironmentFile)
4. **Auth via env vars** — add `<SERVICE>_API_KEY` etc. to `.env`, `.env.example`, and Bitwarden `env-secrets`
5. **Update agent system prompt** in `src/agent.ts` `buildExtendedPrompt()` — list available tools so the agent knows about them
6. **Update docs** — CLAUDE.md (capability routing, secret inventory), README.md (integrations section, project structure)
7. **Build before deploy** — the MCP server must be compiled to `dist/` since `.mcp.json` references the JS file

### MCP Server Template Pattern

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// z (zod) is included transitively via @modelcontextprotocol/sdk — no extra install needed
// Env vars are read from process.env (inherited from parent)
// Use server.tool(name, description, zodSchema, handler) to register tools
// Return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }
```

### Key Lessons

- **Zapier Trello was never actually connected** — the system prompt claimed it was, but no tools existed. Always verify integrations work end-to-end before documenting them.
- **Trello auth requires API key + token (not secret)** — the API secret is for OAuth token generation. Generate a permanent token via: `https://trello.com/1/authorize?expiration=never&scope=read,write&response_type=token&key=<KEY>&name=<APP>`
- **`mcp__*` wildcard in `allowedTools`** automatically picks up any new MCP server added to `.mcp.json` — no code changes needed in agent.ts allowedTools.
- **Test MCP server init** by piping a JSON-RPC initialize message via stdin and checking the response.

## Zapier MCP

- Tools are dynamically determined by what the user has connected in their Zapier account
- The `get_configuration_url` tool provides the link for users to add/remove connections
- Don't list specific Zapier tools in docs unless you've verified they actually exist via ToolSearch
- Currently confirmed working: Google Calendar, Gmail, Google Contacts, Microsoft Office 365, JotForm, OpenRouter

## Secret Management for Integrations

- All API credentials go in Bitwarden vault item `env-secrets` (folder `claude-agent-lightsail`)
- The sync script (`scripts/sync-secrets.sh`) can fail silently — always verify creds reached the server with `ssh ... grep <KEY> .env`
- After adding env vars, restart the systemd service to pick them up
- Local `.env` is gitignored — safe for development credentials
