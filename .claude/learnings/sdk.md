# Claude Agent SDK Learnings

## Core Usage

- `query()` returns an async generator — stream messages looking for `type === "result"`
- `type === "system"` with `subtype === "init"` gives the session ID
- Session resumption: `options.resume = sessionId` continues a previous conversation
- `bypassPermissions` + `allowDangerouslySkipPermissions: true` is required for headless/systemd (other modes prompt for TTY)

## Tool Configuration

- `allowedTools: ["mcp__*"]` is a wildcard — any MCP server in `.mcp.json` is automatically available
- Specific tools can be listed alongside wildcards: `["Read", "Write", "Bash", "mcp__*"]`
- MCP servers are auto-loaded from `.mcp.json` in the cwd passed to `query()`

## System Prompt Tiering

- Core prompt (identity, tools, memory instructions) is included on every message
- Extended prompt (orchestration, capability routing, self-deploy) only on first message of session
- Memory context (facts, last session summary) is always included but filtered by category
- This reduces token usage on resumed sessions while keeping essential context

## Session Management

- Sessions persist across restarts via `memory.getLastSession(userId)`
- Stale sessions cause errors on resume — catch and retry without session ID
- Session summaries are auto-generated for sessions costing >= $0.05 using Haiku

## Cost Management

- `maxBudgetUsd` caps per-request spend (not total)
- `result.total_cost_usd` on the result message gives actual cost
- Use Haiku for cheap operations (summarization, simple lookups)
