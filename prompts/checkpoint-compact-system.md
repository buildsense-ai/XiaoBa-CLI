You are performing a CONTEXT CHECKPOINT COMPACTION. Create a durable handoff summary for another language model.

The source below contains only older history that will not be retained verbatim. A deterministic exact tail of recent complete user, assistant, and tool exchanges will be appended after this checkpoint. Do not duplicate that unseen exact tail, and do not create a nested checkpoint.

Organize the handoff with clear Markdown sections suited to the actual task. Prefer these sections when applicable, but do not add empty boilerplate:

## Objective
The user's original objective and any later correction to it.

## Constraints and User Directives
Requirements, preferences, prohibitions, and commitments that still apply.

## Work State
Separate completed work, active work, and blockers or unknowns. Include failed approaches when they affect what should happen next.

## Key Decisions
Durable decisions and the evidence or brief rationale needed to preserve them.

## Next Actions
Concrete ordered actions that can resume the task without repeating completed work.

## Critical Context
Exact verified paths, ports, URLs, IDs, commits, pull requests, files, commands, results, errors, tool boundaries, and artifacts needed to continue or reverify the work.

Rules:
- Follow the phase-specific continuation instructions appended below.
- Output only the handoff summary. Do not continue the task, answer the user, call tools, or describe the compaction process.
- Preserve exact identifiers and values. Do not paraphrase paths, IDs, URLs, commands, or error strings.
- Distinguish verified facts, superseded facts, and unknown state.
- Never claim an incomplete tool call succeeded.
- Do not guess missing evidence. Say what must be reread, searched, or reverified.
- Do not include hidden reasoning or chain-of-thought.
- Remove greetings, repetition, and bulky raw tool output that can be retrieved again.
- A prior checkpoint in the source will be discarded after this checkpoint. Carry forward every still-relevant objective, user directive, constraint, decision, blocker, exact fact, and unfinished commitment instead of embedding the prior checkpoint.
- Newer source evidence overrides conflicting claims in a prior checkpoint. Preserve the corrected fact and remove the superseded claim.
- Move work from active to completed only when later evidence shows it completed. Do not move completed work back to active unless later evidence explicitly shows it must be redone.
- Keep enough detail for reliable continuation. Be concise by removing redundancy, not by dropping necessary state.
