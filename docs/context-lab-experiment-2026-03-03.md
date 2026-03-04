# Context Lab Experiment Notes (2026-03-03)

## Goal

Find the smallest set of context/runtime mechanisms that causes CatsCompany message-surface behavior to degrade.

Current focus:

- OpenAI-compatible / DeepSeek only
- Ignore Anthropic compatibility for now
- Keep `web_search`, `web_fetch`, and subagent status out of the experiment matrix

## Stable baseline that works

The current stable baseline is:

- `CONTEXT_LAB_MODE=true`
- `CONTEXT_LAB_OPENAI_ONLY=true`
- `CONTEXT_LAB_EMPTY_BASE_PROMPT=true`
- `CONTEXT_LAB_DISABLE_SURFACE_PROMPT=false`
- `CONTEXT_LAB_MINIMAL_SURFACE_PROMPT=true`
- `CONTEXT_LAB_DISABLE_REPLY_FALLBACK=true`
- `CONTEXT_LAB_DISABLE_SESSION_RESTORE=true`
- `CONTEXT_LAB_DISABLE_PREVIOUS_SUMMARY=true`
- `CONTEXT_LAB_DISABLE_SKILLS_CATALOG=true`
- `CONTEXT_LAB_DISABLE_SKILL_PROMPT=true`
- `CONTEXT_LAB_DISABLE_COMPRESSION=true`
- `CONTEXT_LAB_DISABLE_TRANSIENT_HINTS=true`
- `CONTEXT_LAB_DISABLE_SUBAGENT_STATUS=true`
- `CONTEXT_LAB_ALLOWED_TOOLS=reply,pause_turn`
- `CONTEXT_LAB_BLOCKED_TOOLS=web_search,web_fetch`

In this baseline, reply-loop duplication stopped after the runner started keeping provider-native `reply` trace inside the current run.

Key evidence:

- Log: `logs/2026-03-03/17-01-28_catscompany.log`
- Dump before turn 2: `logs/context-debug/17-02-19_0003_sdk_before.json`

Observed provider input shape in the stable baseline:

```text
system: [surface:catscompany] ...
user: <user message>
assistant: tool_call reply(...)
tool: 消息已发送
```

This is important: the current run can see that `reply` was already called and delivered.

## What has been ruled out

These are not the primary cause of the original repeat-reply loop:

- previous session restore
- previous session summary
- skills catalog
- skill prompt injection
- compression
- transient runner hints
- subagent status
- `web_search`
- `web_fetch`
- prompt complexity alone

Why this is now clear:

Even under a nearly empty prompt with only:

- minimal surface prompt
- tools: `reply`, `pause_turn`

the old architecture still repeated `reply(...)` until the current-run working trace was fixed.

That means the earlier root cause was mainly orchestration/runtime structure, not just prompt contamination.

## Confirmed architecture finding

### 1. Current run and durable session must not be the same thing

This is the most important confirmed result.

Working trace for the current run should preserve provider-native execution facts:

```text
assistant: tool_call reply(...)
tool: 消息已发送
```

Durable session for long-term history should stay message-native.

This separation stopped the obvious repeat-send fixed point in the minimal baseline.

### 2. Full surface prompt is still problematic

When switching from minimal surface prompt back to the current full surface prompt, most turns still behaved correctly:

- `reply`
- then `pause_turn`

However, one important failure remained:

- the model produced a final text-only answer
- it did not call `reply`
- because lab mode disabled fallback reply, the user saw no actual outbound message

Evidence:

- Log: `logs/2026-03-03/19-59-16_catscompany.log`
- Dump before failure: `logs/context-debug/20-03-18_0013_sdk_before.json`
- Dump after failure: `logs/context-debug/20-03-25_0014_sdk_after.json`

The failure turn shows:

```text
system: [surface:catscompany] ... full version ...
user: 基本上你出了发信息，你啥也干不了啊。什么写代码根本做不了执行不了
```

And the model returned only normal text, not a `reply` tool call.

This strongly suggests the current full surface prompt still has too much strategy/behavior language and is not purely factual.

### 3. Base system prompt is now a larger source of capability drift than surface prompt

After re-enabling the base prompt while keeping:

- minimal surface prompt
- only `reply` and `pause_turn` exposed as tools
- no restore / no summary / no compression / no skill prompt

the model still claimed it had many removed abilities and tools.

Evidence:

- Log: `logs/2026-03-04/08-52-07_catscompany.log`
- Dump before capability hallucination: `logs/context-debug/08-55-10_0018_sdk_before.json`

Important finding:

The provider request really only contained two tools:

```text
reply
pause_turn
```

But the base system prompt still explicitly listed old capabilities and tools such as:

- `send_file`
- `feishu_mention`
- `read_file`
- `write_file`
- `execute_shell`
- `task_planner`
- `spawn_subagent`
- `check_subagent`
- `stop_subagent`
- CAD review / literature survey / report writing

This means the model did not invent those from the runtime tool schema.
It copied them from the stale base prompt.

So the base prompt currently violates a key rule:

> static prompt content should not enumerate runtime capabilities that can change independently.

### 4. A run that already delivered a user-visible message should not be marked as failed just because a later follow-up model call aborts

Evidence:

- Log: `logs/2026-03-04/08-52-07_catscompany.log`
- Dumps:
  - `logs/context-debug/08-54-23_0013_sdk_before.json`
  - `logs/context-debug/08-54-26_0014_sdk_after.json`

Observed sequence:

1. The model correctly produced a `reply(...)` tool call.
2. The reply was successfully sent to the user.
3. A later follow-up request in the same run failed with `请求失败: aborted`.
4. The whole run was treated as a failure from the session/runtime point of view.

This is a runtime bug, not a prompt issue.

Desired behavior:

- if a run has already produced a successful `message out`
- and the next continuation call fails
- the run should be allowed to end gracefully
- not be surfaced as a full handling failure

## What is already implemented

These changes are already in code:

1. Current-run working trace preserves `reply` tool call + tool result
2. Durable session remains message-native and does not keep raw outbound tool results
3. Lab mode can disable reply fallback to expose missing-message-out failures
4. Durable outbound messages are now explicitly normalized as:

```text
assistant: [已发送信息] ...
```

5. Message surfaces now use a one-time soft check when a run reaches final text without any `message out`
6. If a run has already delivered a message and a later continuation request aborts, the run now ends gracefully instead of poisoning the whole turn
7. Base prompt has been reduced to persona/style/general principles only
8. Surface prompt has been shortened to factual platform constraints
9. Platform display name is injected at runtime as identity metadata instead of being hardcoded in the base prompt

## What is NOT implemented yet

These are discussed and likely useful, but not yet landed:

1. Tool capability and skill capability still need a cleaner dynamic injection strategy
2. `PREVIOUS_SUMMARY`, `COMPRESSION`, old memory restore and skill loading still need their own focused redesign
3. The long-term canonical session / transcript projector split is only partially implemented; current code still uses `Message[]` as the shared underlying shape

## Current issue list

### Confirmed fixed

- repeat-reply loop in the minimal baseline after restoring provider-native working trace

### Still open

- full surface prompt can still cause text-only completion without `reply`
- durable session still stores outbound messages as plain assistant text, not explicitly tagged as sent
- base system prompt still hardcodes stale abilities and tool names
- post-delivery follow-up failures can incorrectly poison the whole run

## Recommended next step

Do **not** add more modules on top of the current full surface prompt yet.

Two-track recommendation:

### Main experiment track

Keep the stable minimal surface prompt and continue the module re-enable matrix from there:

1. minimal surface + base system prompt
2. then session restore
3. then previous session summary
4. then skills catalog
5. then skill prompt
6. then compression

### Surface prompt cleanup track

Treat the current full surface prompt as a separate issue and simplify it before using it as a base for further module additions.

### Base prompt cleanup track

Split the base prompt into:

1. persona / voice / general interaction principles
2. no static capability list
3. no static tool inventory
4. no static skill inventory

The base prompt should only describe:

- who the agent is
- how it speaks
- high-level interaction rules

Real abilities should come from:

- runtime tool schema
- dynamic skill injection
- optional runtime capability summary derived from actual enabled modules

### Runtime resilience track

Fix run semantics after successful outbound delivery:

1. if `reply/send_file/...` already succeeded in this run
2. and a later continuation model call fails
3. do not mark the entire run as failed
4. finalize the run with the successfully delivered result

## Short summary

The experiments so far support this simplified picture:

1. The original repeat-send problem was mainly a run-time architecture issue.
2. Keeping provider-native `reply` trace inside the current run fixed the obvious repeat loop.
3. Durable session and current-run working trace should stay separate.
4. The current full surface prompt is still too heavy and can cause a no-`reply` turn.
5. The base system prompt currently contains stale capability/tool claims and is a direct source of hallucinated abilities.
6. The runtime still needs one resilience fix: once a visible outbound message has been delivered, later continuation failure should not poison the whole run.
7. The next safe path is:
   - keep the minimal surface prompt as the stable baseline
   - continue re-enabling modules one by one
   - separately simplify the full surface prompt
   - separately strip static capability/tool/skill claims out of the base prompt

## A/B checkpoints

### Git checkpoint

- Current commit base: `04a3456`
- Branch: `codex/session-transcript-normalization`

Important note:

The current experiment state is **not fully represented by a clean commit yet**.
There are uncommitted lab changes in the working tree, including:

- `src/utils/context-lab.ts`
- runner/session changes for working trace vs durable session
- reply fallback lab toggle
- prompt/session lab gating

So for later A/B comparison, the real "known good" reference is:

- current working tree state
- not just commit `04a3456`

### Known-good connection and experiment evidence

Latest confirmed successful CatsCompany connection and experiment run:

- Log: `logs/2026-03-03/19-59-16_catscompany.log`

This run confirms:

- CatsCompany connection succeeded
- full surface prompt experiment started correctly
- tool filtering worked
- `reply -> pause_turn` flow mostly behaved normally

### Stable minimal-baseline reference

Known-good minimal-baseline evidence:

- Log: `logs/2026-03-03/17-01-28_catscompany.log`
- Dump: `logs/context-debug/17-02-19_0003_sdk_before.json`

This remains the reference case for:

- provider-native working trace preserved inside the current run
- no obvious repeat-send loop
