# Minimal Runtime Architecture Proposal

## Goal

Define a smallest useful runtime slice for XiaoBa that is:

- message-native
- agent-to-agent friendly
- OpenAI-compatible first
- easy to reason about
- not polluted by stale tool/skill descriptions

This proposal is intentionally narrow. It is meant to become a clean baseline before reintroducing:

- skill optimization
- previous summary
- compression
- old memory/session recovery
- subagent orchestration

## Non-goals

This proposal does **not** try to solve:

- full skill system design
- summary/compression strategy
- long-term memory design
- Anthropic compatibility
- complete tool ecosystem design

Those should be handled later as separate layers.

## Core Principle

XiaoBa should be treated as a **message-native agent**, not a tool-native agent.

That means:

- the external world only sees messages/files
- `message out` is a first-class event
- `reply` must not be treated the same way as ordinary internal tools

Ordinary tools are internal work.
`message out` is external communication.

## Transcript Layers

The runtime should explicitly separate three layers.

### 1. Canonical Session

This is the long-lived semantic conversation state.

It should represent what happened in a platform-independent way.

Examples:

```text
张三: ...
李四: ...
agent_self: [已发送信息] ...
agent_self: [已发送文件] ...
```

This layer should be:

- message-native
- actor-oriented
- stable across platforms and providers

This layer should **not** be shaped by provider protocol quirks such as:

- Anthropic `user/tool_result`
- OpenAI `tool` role

### 2. Working Trace

This is the current-run execution trace used for continued reasoning.

It exists only for the active run.

It should preserve execution facts that matter to the model, especially:

```text
assistant: tool_call reply(...)
tool: 消息已发送
```

Why:

- if this trace is removed too early
- the model no longer knows it already delivered the message
- then duplicate `reply(...)` becomes likely

This layer is runtime-native, not user-facing.

### 3. Provider Transcript

This is the request actually sent to the model provider.

It is a projection of:

- canonical session
- working trace
- runtime overlays

For OpenAI-compatible models, this becomes:

- `system`
- `user`
- `assistant`
- `tool`

So:

- session is the semantic source of truth
- working trace is the run-time execution source of truth
- provider transcript is only a transport view

## Short Definition

Use this sentence when explaining the architecture:

> Session is "what happened"; transcript is "how that state is projected for a specific consumer".

## Message-Out Semantics

`message out` tools are special.

They must not be handled the same way as ordinary tools.

### Message-Out Tools

Examples:

- `reply`
- future `send_file`
- future `mention`

### Control Tools

Examples:

- `pause_turn`

### Work/Observation Tools

Examples:

- `shell_executor`
- future script tools

## Message-Out Handling Rules

### In Working Trace

Keep provider-native execution facts:

```text
assistant: tool_call reply("好的老师，我来了")
tool: 消息已发送
```

This must remain visible inside the current run.

### In Canonical/Durable Session

Normalize `message out` into message-native history:

```text
agent_self: [已发送信息] 好的老师，我来了
```

This avoids provider noise while preserving the fact that the message was already delivered.

### If a Run Ends Without Any Message Out

Do not hard-send.
Do not repeatedly inject noisy prompts.

Instead, allow a one-time soft check in the active run only:

```text
当前用户 query 是：...
本轮还没有任何用户可见输出。
如果需要回复用户，请使用 reply。
如果本轮可以结束且不需要发送消息，可以调用 pause_turn。
```

Important:

- only once
- not persisted into session
- not treated as user content
- not used as a repeated control loop

## Prompt Design Rules

### Base Prompt

The base prompt should contain only:

- identity/persona
- speaking style
- high-level behavioral principles

The base prompt should **not** contain:

- static tool inventory
- static skill inventory
- stale capability lists
- platform-specific operational details

### Surface Prompt

The surface prompt should be factual and short.

Example:

```text
[surface:catscompany]
当前是 Cats Company 聊天会话。
用户只能看到你通过 reply 发送的内容。
你的普通文本输出用户看不到。
```

Optional final line:

```text
如果这一轮不需要给用户发送任何内容，可以调用 pause_turn。
```

### Runtime Identity Block

Platform identity should not be hardcoded into the base prompt.

Inject it at runtime.

Example:

```text
[identity]
你当前在这个平台上的名字是：盖尔曼
你对外自称这个名字
当前日期：2026-03-04
```

This keeps platform naming aligned with the real social surface.

## Minimal Toolset

The proposed minimal runtime slice should start with:

- `reply`
- `pause_turn`
- `shell_executor`
- optional `skill` introspection/loading hook

Everything else should stay out of the baseline.

## Why Shell Stays

The long-term direction is to move many "tools" into script-based execution.

That suggests a split:

- base runtime tools: small scriptable execution layer
- higher-level skills: dynamically loaded semantic workflows

So the minimal runtime does not need a giant tool inventory.
It only needs a stable execution primitive.

## Runtime Flow

Minimal message flow:

1. receive user message
2. build canonical session view
3. build provider transcript
4. model responds
5. if `reply` is called:
   - send message
   - record provider-native tool trace in working trace
   - record `[已发送信息] ...` in durable session
6. continue run if needed
7. `pause_turn` or natural completion ends the run

## Immediate Fixes Suggested By This Proposal

1. Keep `reply` tool call + tool result in current-run working trace
2. Normalize delivered messages in durable session as `[已发送信息] ...`
3. Add one-time soft handling for runs with no `message out`
4. Strip static capability/tool/skill lists from the base prompt
5. Reduce surface prompt to platform facts
6. Inject platform display name through a runtime identity block

## Open Questions

1. How should dynamic skill descriptions be loaded into the prompt:
   - only on activation
   - or as a runtime capability summary

2. How should script-based base tools expose descriptions:
   - startup-time registry
   - or request-time injection

3. Should `pause_turn` remain a visible control tool long-term, or become a runtime state transition later

4. What exact canonical event schema should replace today's message-shaped durable session

## Recommended PR Scope

Keep the first PR small.

It should only include:

1. transcript layer definition
2. message-out special handling
3. base prompt cleanup
4. surface prompt reduction
5. runtime identity injection

It should explicitly exclude:

- summary/compression
- skill optimization
- old memory restore strategy
- subagent design
- broad tool ecosystem redesign
