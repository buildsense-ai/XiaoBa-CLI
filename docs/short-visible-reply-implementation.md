# Short Visible Reply Implementation

本文只记录“短可见回复 / 长内容产物化”的当前实现方向。

## 目标

目标不是在模型输出后用硬规则截断或强行改写，而是让 agent 在生成前形成产品习惯：

- 聊天可见回复默认短。
- 长内容优先做成文件、artifact、网页详情或当前通道支持的交付物。
- 聊天里只给结论、摘要、位置和下一步。
- 用户明确要求“直接贴全文 / 不要文件”时尊重用户。

## 当前方案：Prompt-First

这版不再把“最终回复出口硬拦截”作为主方案。

当前实现是：

```text
按场景注入可见输出偏好 -> 模型在生成前决定短答还是产物化 -> 原有工具链负责写文件/发文件
```

也就是说，主要依赖：

- 稳定 system prompt 的输出原则。
- 每轮 transient 软提示。
- 少量 in-context examples。
- 现有 `write_file` / `send_file` 等工具能力。

运行时不再默认做：

- 按字符数/行数硬拦截最终回复。
- 自动把最终长文本保存成文件。
- 自动替换模型原始回复。
- 为了判断长短而缓冲所有流式输出。

## 涉及文件

核心实现：

- `prompts/system-prompt.md`
- `prompts/transient/visible-output-guidance.md`
- `src/core/visible-output-guidance.ts`
- `src/core/transient-injection-policy.ts`
- `src/core/conversation-runner.ts`
- `src/core/turn-context-builder.ts`

测试：

- `tests/visible-output-guidance.test.ts`

## 稳定 System Prompt

`prompts/system-prompt.md` 中已经包含长期输出原则：

- 聊天可见回复默认简短。
- 需要长篇内容、完整材料、报告、讲义、表格、详细过程或其他交付物时，优先写入文件、artifact、网页详情或当前通道支持的交付形式。
- 聊天中只说明交付物位置、内容摘要和验证结果。
- 除非用户明确要求直接在聊天里展开全文，否则不要把长内容完整贴进对话气泡。

这部分是长期产品行为，不依赖具体 surface。

## Transient 软提示

新增 transient 模板：

```text
prompts/transient/visible-output-guidance.md
```

它通过 `buildVisibleOutputGuidance()` 构造成一条临时注入消息：

```ts
{
  role: 'user',
  content: '[transient_visible_output_guidance]\n...',
  __injected: true
}
```

为什么用 `role: "user"`：

- 这类提示更接近“本轮运行时上下文/产品偏好”，不是永久系统规则。
- 它插在当前真实用户消息附近，让模型生成当前回复前看到。
- `__injected: true` 标记保证它不会被当成真实用户消息长期保存。

模板内容包括：

- 当前 surface。
- 当前可用交付路径。
- 短可见回复偏好。
- “长内容产物化”的行为说明。
- 少量 examples。

示例片段：

```text
User asks for a complete plan/report/material -> create a Markdown/document file, then reply:
"已整理到 <file>。核心结论是 ...，我还验证了/待确认 ..."

User asks a quick question -> answer directly in a few sentences, no file.

User says "直接贴全文" or "不要文件" -> provide the requested inline content.
```

## 注入策略

注入策略在：

```ts
src/core/transient-injection-policy.ts
```

字段：

```ts
injectVisibleOutputGuidance: boolean
```

判断函数：

```ts
shouldInjectVisibleOutputGuidance(...)
```

当前触发原则：

- 普通闲聊不注入。
- 微信、飞书、CatsCo 等消息端的非闲聊任务注入。
- 复杂任务注入。
- `office` / `classroom` / `team-assistant` 这类容易产生交付物的任务注入。

这不是业务硬规则，只是决定“这一轮是否需要提醒模型注意可见输出形态”。

## 注入位置

`ConversationRunner.run()` 中计算 provider transient policy：

```ts
const transientPolicy = resolveProviderTransientPolicy(...)
```

如果 `injectVisibleOutputGuidance` 为 true，则构建：

```ts
const visibleOutputGuidance = buildVisibleOutputGuidance({
  surface,
  tools: requestTools,
  intent: transientPolicy.intent,
});
```

然后加入 `buildProviderInputMessages()` 的 transient hints：

```ts
[
  perTurnRunnerHint,
  toolGuidance,
  visibleOutputGuidance,
  ...
]
```

最终它只进入本次 provider 请求的 `messages`，不会写入 durable session。

## 清理策略

`ConversationRunner.buildProviderInputMessages()` 会移除上一轮残留的：

```text
[transient_visible_output_guidance]
```

`TurnContextBuilder.removeTransientMessages()` 也会移除同类消息。

这保证 visible output guidance 是 turn-scoped/provider-scoped，不污染长期历史。

## 和工具的关系

真正的文件能力仍然来自工具 schema：

- `write_file`
- `edit_file`
- `send_file`

`visible-output-guidance` 不替代工具 schema，也不复制完整工具参数。

它只告诉模型当前可用交付路径，例如：

```text
write_file for local Markdown/text artifacts;
send_file for chat file delivery after a file exists
```

模型仍需要自己决定：

- 是否需要创建文件。
- 用哪个工具创建文件。
- 是否需要发送文件。
- 聊天里给什么短说明。

## 和硬规则方案的区别

当前方案不是：

```text
模型已经输出长文 -> runner 用字符数判断 -> 强制写文件 -> 替换回复
```

当前方案是：

```text
模型生成前看到产品偏好和示例 -> 主动短答或主动产物化
```

因此它更符合产品预期：

- 让 agent 看起来“会工作”，不是“被拦截”。
- 不在运行时强行改变模型最终回答。
- 保留用户明确要求 inline 的自由。
- 后续可以通过 prompt、ICL、eval 持续优化。

## 当前边界

已经完成：

- 稳定 system prompt 中有短回复/产物化原则。
- 新增 visible output transient 模板。
- 新增 provider-scoped 注入策略。
- 根据 surface、任务复杂度和 intent 选择性注入。
- 注入消息不进入长期历史。
- 单测覆盖注入和清理行为。

尚未完成：

- 真实模型效果验证。
- 更丰富的 in-context examples。
- surface 级别的输出偏好配置。
- 网页端 artifact/card 展示策略。
- 微信/飞书真实文件发送体验验证。
- shadow 日志和 eval，用真实数据判断提示是否有效。

## 测试

运行：

```bash
npx tsx --test tests/visible-output-guidance.test.ts
```

测试覆盖：

- 非闲聊/交付物场景会注入 visible output guidance。
- 普通闲聊不会注入。
- guidance 是 `role: "user"` 且 `__injected: true`。
- provider input 中可见，durable messages 中不可见。
- cleanup 能移除意外残留的 guidance。
