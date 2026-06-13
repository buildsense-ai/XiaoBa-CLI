# Prompt 注入规范草案

这份文档定义 CatsCo / XiaoBa runtime 里“给模型额外塞上下文”的统一规则。它比 `runtime-observations.md` 更上层：Observation Store 只是其中一种注入来源，不应该承包所有注入。

## 核心原则

- `system` 只放稳定、低频变化、会话级的行为约束。动态信息默认不能进 `system`。
- 动态注入默认使用 `role: "user"`，并带上 `__injected: true`。
- 所有 runtime-only 注入都要可清理，不能写进 durable history。
- 注入内容必须声明自己不是用户新请求，避免模型把它当成新任务。
- 默认注入摘要和指针，不直接注入大段原始结果。
- 任何会频繁变化的字段，都要先假设它会影响 prompt cache。

## 注入分类

### 1. Stable System Prompt

用途：模型长期行为、工具使用规则、产品身份、稳定安全约束。

规则：

- 允许 `role: "system"`。
- 内容应尽量稳定，不要包含时间、cwd、任务进度、后台结果、runner 状态。
- 修改会影响缓存前缀，应当有明确收益。

当前归属：

- `PromptManager.buildSystemPrompt()`
- `AgentSession.init()`

### 2. Durable Conversation

用途：真实用户消息、真实 assistant 回复、工具调用回放。

规则：

- 写入 session history。
- 不能混入 `__injected` 的 runtime-only 内容。
- 用于恢复、压缩、日志和下一轮上下文。

当前归属：

- `AgentSession`
- `AgentTurnController`
- `SessionStore`

### 3. Turn-Scoped Runtime State

用途：当前轮才有意义的运行时状态，例如 plan status、skills list、subagent active status、runtime feedback。

规则：

- 默认 `role: "user"` + `__injected: true`。
- 只进入本轮 provider input，不进入 durable history。
- 内容应有稳定 prefix，例如 `[transient_plan_status]`。
- 由 `TurnContextBuilder.removeTransientMessages()` 清理。

当前归属：

- `TurnContextBuilder`
- `RuntimeFeedbackInbox`
- `SessionSkillRuntime`
- `SubAgentManager` / `buildSubAgentStatusMessage`

### 4. Runner-Tail Hints

用途：ReAct 循环内部的局部提示，例如 runner hint、当前工作目录、空 max_tokens 恢复提示、重复外发提示。

规则：

- 默认 `role: "user"` + `__injected: true`。
- 只在 provider input 尾部或工具交换附近出现。
- 不能进入 `system`，不能沉淀进 durable history。
- 放置位置由 `ConversationRunner` 控制，因为它最了解当前 ReAct 轮次。

当前归属：

- `ConversationRunner`
- `runner-orchestration-policy`

### 5. Runtime Observations

用途：异步完成的外部观察结果，例如 memory graph、web search、review、长任务总结。

规则：

- 先写入 `RuntimeObservationStore`，不要直接拼 prompt。
- 下一轮由 `TurnContextBuilder` 按预算挑选并渲染成 `[runtime_observations]`。
- 默认放在当前真实用户消息之前。
- 成功发送后标记为 `injected`；业务确认不再需要时标记为 `consumed`。
- 默认注入 summary，不注入完整 detail。

当前归属：

- `RuntimeObservationStore`
- `renderRuntimeObservations(...)`
- `AgentSession.upsertRuntimeObservation(...)`
- `TurnContextBuilder.injectRuntimeObservations(...)`

### 6. Manual Injected Context

用途：平台或人工侧显式塞入的一次性上下文。

规则：

- 必须 `role: "user"` + `__injected: true`。
- 需要明确 prefix 和来源。
- 如果是异步结果，优先改用 Runtime Observation。
- 如果是机械状态，优先接入 TurnContextBuilder 或 ConversationRunner。

当前归属：

- `AgentSession.injectContext(...)`

## 选择规则

新增注入前先按这个顺序判断：

1. 是长期稳定行为规则吗？
   用 stable system prompt。
2. 是真实用户或 assistant 对话吗？
   写 durable conversation。
3. 是当前轮机械状态吗？
   放进 `TurnContextBuilder`。
4. 是 ReAct 循环内部的即时提示吗？
   放进 `ConversationRunner`。
5. 是后台异步任务完成后的观察结果吗？
   写入 `RuntimeObservationStore`。
6. 只是临时手工塞上下文吗？
   使用 `user + __injected`，并确保可清理。

## 推荐 Prompt 形态

机械状态：

```text
[transient_plan_status]
Runtime context only. Not a user request.
...
```

异步观察：

```text
[runtime_observations]
以下是后台异步观察结果，不是用户的新请求。当前用户消息仍然优先；只在相关时参考。

1. [web_search:obs_abc] 搜索结果
   摘要: ...
   来源: ...
```

当前目录：

```text
[transient_current_directory]
Runtime context only. Not a user request. Do not answer.
cwd: ...
Use only for relative file paths.
```

## 禁止模式

- 动态时间、cwd、runner hint、搜索结果、review 结果进入 `system`。
- 没有 prefix 的注入消息。
- 没有 `__injected` 标记的 runtime-only 消息。
- 把 observation 原始长文本反复塞进 prompt。
- 注入内容直接写成命令式用户需求，例如“请立刻处理以下搜索结果”。
- 新增一套独立上下文拼装逻辑绕过 `TurnContextBuilder` / `ConversationRunner`。

## 缓存安全

MiniMax M3 实验显示，动态 `system` 内容会显著破坏缓存命中。当前规范因此采用保守策略：

- stable system prompt 尽量稳定。
- 动态注入放到 `user + __injected`。
- 高频变化内容尽量放在当前用户消息附近或 runner tail，不插入稳定前缀中间。
- 大段异步结果先摘要、去重、预算筛选。
- provider 边界不能泄露 `__injected`、`__runtimeObservation` 等内部字段。

## 接入检查清单

新增一种注入来源时，PR 需要回答：

- 这条信息属于哪一类注入？
- 为什么不能用现有类别？
- 它会不会每轮变化？
- 它的 role 是什么？
- 它是否带 `__injected`？
- 它的 prefix 是什么？
- 它插在当前用户消息前、runner tail，还是其他位置？
- 它如何从 durable history 中清理？
- 它是否可能破坏 prompt cache？
- 有无测试证明它不会进入 `system`、不会污染 durable history？

## 当前建议

近期不要先做庞大的 lane/scheduler。先沿用现有分工：

- `TurnContextBuilder` 管每轮 provider input 的 turn-scoped 注入。
- `ConversationRunner` 管 ReAct 内部即时提示。
- `RuntimeObservationStore` 管未来异步观察结果。

等 memory graph、web search、review 真正接入后，再根据实际冲突决定是否需要更强的 scheduler。
