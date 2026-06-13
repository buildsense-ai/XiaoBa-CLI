# Runtime Observations 草案

这份文档是 `prompt-injection-guidelines.md` 里的 Runtime Observations 细化说明。先看整体注入规范，再看这里的 store 数据结构和闭环细节。

这份文档定义一层轻量的 runtime observation store，用来承接未来的异步上下文来源，例如 memory graph、web search、review、长任务或子任务结果。它不是现有注入机制的重构，也不要求现在把 runner hint、plan status、skills list、current directory 等直接注入全部迁进来。

## 目标

- 给未来异步结果一个统一入口：后台任务完成后先写入 store，再由对话循环按预算挑选摘要注入模型。
- 明确缓存安全边界：runtime observation 只能以 `role: "user"` 和 `__injected: true` 进入模型上下文，不能进入 `system`。
- 把“事实存储”和“prompt 渲染”分开：store 保存结构化观察结果，renderer 负责生成一次性的 `[runtime_observations]` 消息。
- 先提供接口和规范，方便后续 memory graph、web search、review 等功能接入。

## 非目标

- 不迁移现有 runner hint、plan status、skills list、subagent status、current directory 注入。
- 不做持久化，不跨进程共享，不做复杂队列。
- 不引入完整 lane/scheduler。第一版只做选择、去重、预算和状态流转。
- 不把动态 observation 写进 `system`，也不依赖 provider 特殊能力。

## 数据模型

每条 observation 代表一条后台观察结果：

- `id`: observation 的稳定 id。
- `sessionId`: 所属会话。
- `turnId`: 可选，产生这条 observation 的轮次。
- `source`: 来源，例如 `memory_graph`、`web_search`、`review`、`subagent`、`runtime`。
- `status`: `pending`、`ready`、`injected`、`consumed`、`stale`、`failed`。
- `title`: 给模型看的短标题。
- `summary`: 默认注入模型的摘要。
- `detail`: 可选的完整详情，默认不直接塞进 prompt。
- `citations`: 可选来源引用。
- `priority` / `relevance`: 用于预算内排序。
- `tokenEstimate`: 粗略 token 估算，用于 prompt budget。
- `expiresAt`: 可选过期时间。
- `hash`: 内容指纹，用于去重。
- `policy`: 注入策略，例如只注入一次、持续注入直到消费、仅指针、不自动注入。

## 生命周期

1. 用户消息进入 ReAct 循环。
2. memory graph、web search、review 等后台任务异步执行。
3. 后台任务完成后调用 `store.upsert(...)` 写入 observation。
4. 每次构造下一轮 provider input 前，调用 `store.pickForPrompt(...)` 按状态、过期时间、优先级、相关性和预算选择 observation。
5. `TurnContextBuilder` 调用 `renderRuntimeObservations(...)` 生成一条模型可见消息：

```ts
{
  role: 'user',
  content: '[runtime_observations]\n...',
  __injected: true,
  __runtimeObservation: true,
  runtimeObservationSource: 'runtime_observations',
}
```

6. `AgentTurnController` 在本轮发送成功后调用 `store.markInjected(...)`。模型已经处理或业务确认不再需要时调用 `store.markConsumed(...)`。

当前实验版已经把这条链路接到 `AgentSession.upsertRuntimeObservation(...)`：

```ts
session.upsertRuntimeObservation({
  source: 'web_search',
  title: '搜索结果',
  summary: '...',
});

await session.handleMessage('继续处理刚才的问题');
```

这会在下一轮真实用户消息前注入一条 `[runtime_observations]`，并在发送成功后把对应 observation 标为 `injected`。

## Prompt 形态

第一版统一渲染为一条 `user` 注入消息：

```text
[runtime_observations]
以下是后台异步观察结果，不是用户的新请求。当前用户消息仍然优先；只在相关时参考。

1. [web_search:obs_abc] 搜索结果
   摘要: ...
   来源: ...
```

放置位置由后续接入点决定。当前实验版默认放在当前用户消息之前。如果某类 observation 必须在 ReAct 循环内部补充，可放在 runner tail，但仍保持 `user + __injected`。

## 缓存安全规则

- 所有动态 observation 都不能进入 `system`。
- 尽量注入摘要，不直接注入完整详情。
- 同一 hash 的 observation 只保留最高优先级的一条进入 prompt。
- 超过预算的 observation 跳过，等待下一次或由业务改成更短摘要。
- 过期、失败、已消费的 observation 不自动注入。

## 现有注入的处理

现有直接注入先保持原状：

- runner hint 仍由 `ConversationRunner` 管。
- plan status、skills list、subagent status、runtime feedback 仍由 `TurnContextBuilder` 管。
- current directory 仍由 runner 按现有逻辑注入。

这些信息是“当前轮 prompt 机械状态”，不是异步产生的外部观察结果；提前迁入 observation store 反而会增加不必要复杂度。等 memory graph、web search、review 等真实异步来源出现后，再把它们接入这层 store。
