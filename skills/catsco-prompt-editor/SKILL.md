---
name: catsco-prompt-editor
description: Safely inspect, propose, and apply CatsCo prompt changes through local prompt overrides. Use when asked to tune system prompts, compare prompt variants, or let a companion/pet agent suggest prompt edits without changing source code.
---

# CatsCo Prompt Editor

Use this skill to improve CatsCo prompts without distracting the main agent from the user's task.

## Operating Rules

- Treat prompt editing as a side workflow: diagnose, propose, ask for confirmation, then apply.
- Prefer local prompt overrides over editing built-in prompt files. Built-in files are the baseline; overrides are the experiment layer.
- Only edit existing prompt `.md` paths exposed by Prompt Lab, such as `system-prompt.md`, `runtime-context.md`, `compact-system.md`, `transient/*.md`, `subagents/*.md`, and `sidecars/*.md`.
- Do not edit `src/`, tool schemas, provider adapters, credentials, or user data unless the user explicitly asks for code changes.
- Never put secrets, private file contents, long chat transcripts, screenshots, or API keys into prompt files.

## Workflow

1. Inspect the current prompt state.
   - Prefer `GET http://127.0.0.1:3800/api/prompts` when the local Dashboard API is running.
   - Otherwise ask the user for the Prompt Lab state or the override directory path.
2. Pick the smallest prompt file that matches the behavior being tuned.
   - Global behavior: `system-prompt.md`.
   - Runtime facts and current directory wording: `runtime-context.md` or `transient/current-directory.md`.
   - Compression quality: `compact-system.md`.
   - Sub-agent behavior: `subagents/*`.
   - Small side model calls: `sidecars/*`.
3. Propose the change before writing it.
   - Explain the target file, the intended behavioral change, and the risk.
   - Ask for a clear apply/cancel confirmation if the user has not already approved.
4. Apply the override.
   - Prefer `PUT http://127.0.0.1:3800/api/prompts/file` with JSON `{ "path": "...", "content": "..." }`.
   - If the API is unavailable, write the same relative path under the prompt override directory.
5. Verify.
   - Refresh Prompt Lab and confirm the file shows `override`.
   - Ask the user to send the next message in the same session. Main system prompt changes hot-load before the next user turn, not in the middle of a running tool loop.
   - Check session logs for a new `Prompt trace` line or changed `prompt.system_hash` / `prompt.bundle_hash`.

## Companion/Pet Mode

When used by a companion or pet agent:

- Stay out of the main agent's active tool loop.
- Present a small confirmation prompt: apply this prompt change, preview only, or cancel.
- Prefer one file per proposal.
- Summarize the exact effect in one or two sentences after saving.
- If the change is risky or broad, save nothing and ask the user to review the proposed diff first.

## A/B Notes

For prompt experiments, use a short version label such as `brief-v2` or `teacher-grading-v1` and record the active prompt hash. Compare outputs by the same user message, same session context, and different `prompt_version` or `system_hash`.
