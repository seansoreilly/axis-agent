Break the following task into subtasks and execute them using multiple agents in parallel.

For each subtask, decide which model tier and agent type is most appropriate:
- **opus** (via `Task` tool with `model: "opus"`): Complex reasoning, architecture decisions, creative writing, nuanced analysis
- **sonnet** (via `Task` tool with `model: "sonnet"`): General coding, research, moderate complexity tasks (good default)
- **haiku** (via `Task` tool with `model: "haiku"`): Simple lookups, formatting, summarization, quick factual questions

Steps:
1. Analyze the task and break it into 2-6 focused subtasks
2. Identify dependencies between subtasks (which ones need results from others)
3. Launch all independent subtasks in parallel using the `Task` tool, choosing the right model for each
4. Wait for results, then launch any dependent subtasks with the prior results as context
5. Synthesize all results into a final cohesive response

Use the `Task` tool's `subagent_type: "general-purpose"` for most subtasks. Use `subagent_type: "Explore"` for codebase research subtasks.

Launch independent tasks in parallel by making multiple `Task` tool calls in a single message.

Task: $ARGUMENTS
