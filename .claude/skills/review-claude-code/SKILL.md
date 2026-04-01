---
name: review-claude-code
description: Review latest Claude Code/SDK updates and identify refactoring opportunities to replace custom code with native features
user_invocable: true
tags: [maintenance, refactoring, sdk, self-improvement]
---

# /review-claude-code — SDK & CLI Update Review

When the user invokes `/review-claude-code`, perform ALL of the following steps in order. The goal is to compare the current Claude Code SDK version against the latest release and identify opportunities to replace custom code with native SDK features.

## Step 1: Gather Version Info

Collect current and latest version information:

```bash
# Current SDK version pinned in this project
node -e "console.log(require('./package.json').dependencies['@anthropic-ai/claude-agent-sdk'])"

# Latest SDK version on npm
npm view @anthropic-ai/claude-agent-sdk version

# All available versions (to understand release cadence)
npm view @anthropic-ai/claude-agent-sdk versions --json

# Current CLI version
claude --version 2>/dev/null || echo "CLI not available"
```

Report the version gap (e.g., "0.2.69 → 0.2.75 = 6 versions behind").

## Step 2: Fetch Release Notes & SDK Changes

Use a multi-source strategy to understand what changed:

1. **WebSearch** for "Claude Code changelog" and "Claude Code SDK release notes" to find official announcements.
2. **Read installed SDK types** to understand current capabilities:
   ```bash
   find node_modules/@anthropic-ai/claude-agent-sdk -name '*.d.ts' -type f
   ```
   Read the main type definition file (typically `sdk.d.ts` or `index.d.ts`).

3. **If a version gap exists**, diff the type definitions against the latest:
   ```bash
   # Save current types
   cp node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts /tmp/sdk-current.d.ts 2>/dev/null || true

   # Download latest package
   npm pack @anthropic-ai/claude-agent-sdk@latest --pack-destination /tmp/ 2>/dev/null

   # Extract and diff
   cd /tmp && tar xzf anthropic-ai-claude-agent-sdk-*.tgz 2>/dev/null
   diff -u /tmp/sdk-current.d.ts /tmp/package/sdk.d.ts 2>/dev/null || echo "Could not diff types"
   ```

4. **Check the npm page or GitHub** for a CHANGELOG if available:
   ```bash
   npm view @anthropic-ai/claude-agent-sdk repository.url 2>/dev/null
   ```

Summarize all new features, API changes, and deprecations found.

## Step 3: Inventory Custom Implementations

Read each source file and catalog what custom code this project maintains. For each item, note the file, approximate line range, and what it does:

| Custom Feature | Files to Read | What to Look For |
|---|---|---|
| Session wrapping & resumption | `src/agent.ts` | `query()` wrapper, session ID extraction, `options.resume` |
| Conversation summaries | `src/agent.ts` | Summary generation on expensive sessions |
| Memory fact store | `src/memory.ts`, `src/persistence.ts` | JSON key-value store, SQLite backing |
| Prompt building (tiered) | `src/prompt-builder.ts` | Core vs extended prompt sections, memory injection |
| Prompt section definitions | `src/prompt-config.ts` | Section registry, capability routing |
| Skill discovery | `src/agent.ts` | `SKILL.md` file scanning, skill loading |
| Tool/permission config | `src/agent.ts` | `allowedTools`, `bypassPermissions` setup |
| OAuth token refresh | `src/auth.ts` | Credential file reading, token refresh logic |
| Timeout management | `src/agent.ts` | `AbortSignal.timeout()`, cancellation |
| Cost/rate limit tracking | `src/agent.ts` | Budget tracking, rate limit detection |
| Subagent definitions | `src/agent.ts` | Custom subagent configuration |

Read each file listed above and record the actual line ranges and implementation details.

## Step 4: Compare & Identify Overlaps

For each custom feature from Step 3, check whether the SDK (current or latest) now provides a native equivalent. Classify each as:

- **`safe-replace`** — Native feature is a drop-in replacement. Existing tests should pass as-is after switching. Minimal risk.
- **`partial-replace`** — Some custom logic can be removed, but some must stay (e.g., native handles the base case but custom code adds project-specific behavior).
- **`keep-custom`** — No native equivalent exists, or the native version lacks functionality this project needs.
- **`investigate-further`** — Unclear from type definitions alone; needs runtime testing or deeper analysis.

**"Negligible change" criteria** — a replacement qualifies as safe if:
- Same inputs produce same outputs
- Error handling is preserved
- No user-visible behavior change
- Existing tests pass without modification

## Step 5: Generate Report

Output a structured markdown report with these sections:

### Version Summary
| | Version |
|---|---|
| Current SDK | x.y.z |
| Latest SDK | x.y.z |
| Versions behind | N |
| CLI version | x.y.z |

### What's New in Claude Code
Bullet list of new features, API changes, and deprecations discovered in Step 2.

### Refactoring Opportunities
For each `safe-replace` or `partial-replace` item:
- **Feature name**
- **Current implementation**: file path, line range, brief description
- **Native replacement**: SDK API or feature that replaces it
- **Classification**: `safe-replace` | `partial-replace`
- **Migration notes**: What to change, what to keep
- **Risk**: Low / Medium / High

### No-Action Items
For each `keep-custom` item, briefly explain why no native replacement exists.

### Items Needing Investigation
For each `investigate-further` item, explain what's unclear and suggest next steps.

### Risk Summary
Overall assessment: how many items can be safely replaced, estimated effort, recommended order of migration.

## Step 6: Optional SDK Update

After presenting the report, ask the user if they want to update the SDK. If they approve:

1. `npm install @anthropic-ai/claude-agent-sdk@latest`
2. `npm run build` — verify TypeScript compilation succeeds
3. `npm test` — verify all tests pass
4. Report results

**Do NOT update the SDK unless the user explicitly approves.** The default behavior of this skill is read-only analysis.
