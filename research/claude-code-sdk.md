# Claude Code SDK Research

## Package

```bash
npm install @anthropic-ai/claude-agent-sdk
```

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";
```

## Core API

The main entry point is `query()` — returns an async generator:

```typescript
for await (const message of query({
  prompt: "Fix bugs in auth.py",
  options: {
    cwd: "/home/ubuntu/project",
    allowedTools: ["Read", "Edit", "Bash"],
    permissionMode: "acceptEdits",
  }
})) {
  if (message.type === "result") {
    console.log(message.result);
  }
}
```

## All Options

| Parameter | Type | Default | Purpose |
|-----------|------|---------|---------|
| `prompt` | `string \| AsyncIterable` | Required | What Claude should do |
| `model` | `string` | Default | `claude-opus-4-6`, `claude-sonnet-4-6`, etc. |
| `cwd` | `string` | `process.cwd()` | Working directory |
| `allowedTools` | `string[]` | All | Whitelist of tools |
| `disallowedTools` | `string[]` | `[]` | Blacklist of tools |
| `permissionMode` | `'default' \| 'acceptEdits' \| 'bypassPermissions' \| 'plan'` | `'default'` | Auto-approval behavior |
| `allowDangerouslySkipPermissions` | `boolean` | `false` | Required for `bypassPermissions` |
| `canUseTool` | Callback | `undefined` | Custom permission function |
| `resume` | `string` | `undefined` | Resume previous session ID |
| `forkSession` | `boolean` | `false` | Fork to new session |
| `continue` | `boolean` | `false` | Continue most recent conversation |
| `sessionId` | `string` | Auto-generated | Use specific UUID |
| `persistSession` | `boolean` | `true` | Save session to disk |
| `systemPrompt` | `string \| preset` | Minimal | Custom instructions |
| `mcpServers` | `Record<string, McpServerConfig>` | `{}` | MCP server configs |
| `maxTurns` | `number` | `undefined` | Max conversation turns |
| `maxBudgetUsd` | `number` | `undefined` | Cost limit |
| `effort` | `'low' \| 'medium' \| 'high' \| 'max'` | `'high'` | Effort level |
| `outputFormat` | `{ type: 'json_schema'; schema: JSONSchema }` | `undefined` | Structured output |
| `env` | `Record<string, string>` | `process.env` | Environment variables |

## Authentication

**IMPORTANT: Research suggests SDK requires API key, NOT OAuth/Max plan.**

Options:
1. **Anthropic API Key**: `export ANTHROPIC_API_KEY=sk-ant-xxx`
2. **AWS Bedrock**: `export CLAUDE_CODE_USE_BEDROCK=1`
3. **Google Vertex AI**: `export CLAUDE_CODE_USE_VERTEX=1`

**NEEDS VERIFICATION**: Whether the SDK can piggyback on an existing `claude auth login` session (Max plan OAuth). The SDK spawns Claude Code under the hood, so it *might* use existing auth. This is the key question for using Max plan tokens.

## Available Tools

| Tool | Purpose |
|------|---------|
| Read | Read files |
| Write | Create new files |
| Edit | Edit existing files |
| Bash | Run shell commands |
| Glob | Find files by pattern |
| Grep | Search file contents |
| WebSearch | Web search |
| WebFetch | Fetch web pages |

## Session Management

```typescript
// Capture session ID
let sessionId: string;
for await (const message of query({ prompt: "..." })) {
  if (message.type === "system" && message.subtype === "init") {
    sessionId = message.session_id;
  }
}

// Resume later
for await (const message of query({
  prompt: "Continue from before",
  options: { resume: sessionId }
})) { ... }
```

## Headless/Unattended Configuration

For always-on Lightsail agent:

```typescript
options: {
  permissionMode: "acceptEdits",
  allowDangerouslySkipPermissions: true,
  allowedTools: ["Read", "Edit", "Write", "Bash", "Glob", "Grep"],
  maxTurns: 10,
  maxBudgetUsd: 10,
  persistSession: true,
}
```

## MCP Server Integration

```typescript
options: {
  mcpServers: {
    "postgres": {
      command: "npx",
      args: ["@modelcontextprotocol/server-postgres"],
      env: { DATABASE_URL: "postgresql://..." }
    }
  }
}
```

## Systemd Service (Lightsail)

```ini
[Unit]
Description=Claude Agent
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/agent
Environment="ANTHROPIC_API_KEY=sk-ant-xxx"
ExecStart=/usr/bin/node agent.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```
