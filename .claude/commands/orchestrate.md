Break the following task into subtasks and execute them using multiple agents in parallel.

## Step 1: Plan

Analyze the task and break it into 2-6 focused subtasks. Present the plan to the user before executing:

For each subtask, specify:
- **Description** (1-2 sentences)
- **Model tier** — choose the cheapest tier that can handle the work:
  - **haiku**: Simple lookups, formatting, summarization, quick factual questions (cheapest)
  - **sonnet**: General coding, research, moderate complexity tasks (good default)
  - **opus**: Complex reasoning, architecture decisions, creative writing, nuanced analysis (most expensive — use sparingly)
- **Agent type**:
  - `Explore` — codebase research, finding files, understanding patterns
  - `Plan` — architecture decisions, designing implementation strategies
  - `general-purpose` — everything else (coding, writing, analysis)
- **Isolation**: Use `isolation: "worktree"` when the subtask writes or edits code, to prevent agents from conflicting with each other
- **Dependencies** — which other subtasks must complete first (if any)
- **Background** — whether it can run in background (`run_in_background: true`) while other work continues

Wait for user approval before proceeding.

## Step 2: Execute

1. Launch all independent subtasks in parallel by making multiple `Agent` tool calls in a single message
2. Use `run_in_background: true` for independent agents so they run concurrently
3. **Status updates**: Every 60 seconds while agents are running, post a brief status update to the user listing which subtasks are completed, in progress, or pending
4. When background agents complete, launch any dependent subtasks with the prior results included in the prompt
5. Each agent prompt MUST include all context needed to work autonomously — relevant file paths, function names, constraints, and expected output format. Agents start with zero context so be specific.

## Step 3: Synthesize

Combine all subtask results into a final cohesive response. If any subtask used `isolation: "worktree"`, report the worktree branch so changes can be reviewed and merged.

Task: $ARGUMENTS
