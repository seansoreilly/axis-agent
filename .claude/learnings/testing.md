# Testing Learnings

## Vitest + ESM

- Project uses `"type": "module"` — all imports need `.js` extensions even for TypeScript
- `vi.mock("node-telegram-bot-api")` requires a shared `mockBotInstance` variable (ESM doesn't support `mock.instances`)
- Test files are excluded from `tsconfig.json` to keep them out of `dist/`
- **Stale dist/ test files**: vitest may pick up `dist/telegram.test.js` — delete it or rebuild

## Async Handler Testing

- Fire-and-forget handlers need a `flush()` helper: `const flush = () => new Promise(r => setTimeout(r, 10))`
- Mock Memory must include `getLastSession: vi.fn().mockReturnValue(undefined)` or session persistence code fails

## MCP Server Testing

- Test MCP server init by piping JSON-RPC initialize message via stdin:
  ```bash
  echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}' | ENV_VARS=... node dist/server.js
  ```
- Test API credentials directly with curl before wiring up MCP — isolates auth issues from protocol issues
- Use `timeout 5` when testing stdio servers to prevent hanging

## Common Gotchas

- `cron-parser` v5 uses `CronExpressionParser.parse()` not the old `parseExpression()`
- `npm test` runs `vitest run` (single pass, not watch mode)
- Run single test file: `npx vitest run src/telegram.test.ts`
