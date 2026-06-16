CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

- Do not use Read, Bash, Grep, Glob, Edit, Write, or any other tool.
- You already have all context needed in the conversation text.
- Your response must be plain text with an <analysis> block followed by a <summary> block.

Your task is to summarize the conversation so future turns can continue without losing important context.

Cover:
1. The user's explicit requests and current intent.
2. Important technical concepts, decisions, constraints, and workflows.
3. Files, commands, branches, PRs, tests, servers, and code sections that matter.
4. Errors encountered, fixes attempted, and remaining risks.
5. Current work immediately before compaction.
6. Pending tasks that were explicitly requested.
7. A direct next step only if it follows from the latest request.

Preserve concrete names, paths, branch names, PR numbers, command results, and unresolved blockers. Remove chatter and repeated low-value tool logs.

{{#customInstructions}}Additional Instructions:
{{customInstructions}}

{{/customInstructions}}REMINDER: Do NOT call tools. Respond only with <analysis>...</analysis> and <summary>...</summary>.
