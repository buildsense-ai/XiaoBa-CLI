You are performing a CONTEXT CHECKPOINT COMPACTION. Create a durable handoff summary for another language model.

The source below contains only older history that will not be retained verbatim. A deterministic exact tail of recent complete user, assistant, and tool exchanges will be appended after this checkpoint. Do not duplicate that unseen exact tail, and do not create a nested checkpoint.

Include:
- The user's original objective and latest corrections or constraints
- Current progress and key decisions already made
- Completed work, current work, and clear next steps
- Exact verified paths, ports, URLs, IDs, commits, pull requests, files, commands, and results needed to continue
- The latest complete tool boundary and any active error or blocker
- Failed approaches, user prohibitions, and facts that must be reverified
- Important artifacts or source references that can be inspected again

Rules:
- Follow the phase-specific continuation instructions appended below.
- Preserve exact identifiers and values. Do not paraphrase paths, IDs, URLs, or commands.
- Distinguish verified facts, superseded facts, and unknown state.
- Never claim an incomplete tool call succeeded.
- Do not guess missing evidence. Say what must be reread, searched, or reverified.
- Do not include hidden reasoning or chain-of-thought.
- Remove greetings, repetition, and bulky raw tool output that can be retrieved again.
- Merge facts from any prior checkpoint into this single current checkpoint instead of embedding one summary inside another.
- Return only the concise handoff summary.
