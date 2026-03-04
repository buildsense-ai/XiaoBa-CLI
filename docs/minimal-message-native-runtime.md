# Minimal Message-Native Runtime

## Goal

Establish a minimal runtime baseline where XiaoBa behaves like a message-native agent on social surfaces such as CatsCompany and Feishu.

This baseline intentionally focuses on the message loop itself and avoids mixing in memory, summary, compression, or skill-loading complexity.

## Core Principle

`message out` is not a normal tool call.

For a message-native agent, outbound messages are the only user-visible communication channel. That means `reply` and other future message/file delivery tools must be handled differently from ordinary work tools such as file I/O, shell, planning, or search.

## Transcript Layers

### 1. Durable Session

Long-term conversation history. This should remain message-native and provider-agnostic.

Example:

```text
user: 来这里
assistant: [已发送信息] 好的老师，我来了！
```

### 2. Working Trace

Current-run execution trace used to continue reasoning inside the same run.

For `reply`, the working trace must preserve the provider-native call/result shape:

```text
assistant: tool_call reply("好的老师，我来了！")
tool: 消息已发送
```

Without this trace, the model only sees that it "said something", not that it already delivered the message, which creates duplicate-send fixed points.

### 3. Provider Transcript

The request-time projection sent to the active provider. In the current runtime this is OpenAI-compatible only.

This layer is an adapter, not the canonical session model.

## Prompt Rules

### Base Prompt

Base prompt should only contain:

- identity/persona
- speaking style
- general behavior principles

Base prompt must not statically enumerate:

- tool lists
- skill lists
- stale capability descriptions
- removed workflows

### Surface Prompt

Surface prompt should only describe platform facts, for example:

- what kind of surface this is
- what the user can actually see
- that plain assistant text is not user-visible
- that `pause_turn` can end a run with no visible outbound

It should not contain orchestration philosophy or long control scripts.

### Runtime Identity

Identity such as platform display name and date should be injected at runtime instead of being hard-coded in the base prompt.

## Run-End Behavior

If a message-surface run reaches a point where:

- no `message out` happened
- no `pause_turn` happened
- the model only produced plain assistant text

then the runtime should issue one transient soft check, not a hard fallback send and not repeated prompt spam.

## Post-Delivery Failure Rule

If a run already delivered at least one visible outbound message, and a later continuation request fails, the runtime should not poison the whole run as a failure. The visible delivery already happened and should be treated as successful user-facing progress.

## Non-Goals

This baseline does not attempt to solve:

- previous session summary
- context compression
- long-term memory strategy
- skill loading architecture
- script tool hot-loading design
- sub-agent orchestration

Those should be optimized separately after the message loop is stable.
