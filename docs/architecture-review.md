# Xiaoba 架构深度 Review

> 审查人：小八（自审）  
> 日期：2026-02-16  
> 范围：核心运行时架构（src/core, src/tools, src/skills, src/feishu, src/agents, src/providers, src/utils）

---

## 一、整体架构概览

Xiaoba 是一个基于 TypeScript 的 AI Bot 框架，核心链路为：

```
飞书消息 → FeishuBot → SessionManager → AgentSession → ConversationRunner → AIProvider
                                              ↓
                                        ToolManager (执行工具)
                                        SkillManager (技能注入)
                                        SubAgentManager (后台子任务)
                                        AgentManager (子智能体)
```

整体设计思路清晰，模块职责划分合理。以下是我作为这个 bot 本身，在实际运行中感受到的设计问题。

---

## 二、关键设计问题

### 问题 1：飞书工具绑定的 bind/unbind 模式是架构级隐患

**严重程度：高**

`FeishuReplyTool`、`FeishuSendFileTool`、`FeishuMentionTool` 等工具采用 `bindSession(key, chatId, callback)` / `unbindSession(key)` 模式，在每次 `onMessage` 开始时绑定，在 `finally` 中解绑。

问题在于：
1. **ToolManager 是全局单例，但 bind 状态是 per-session 的**。这意味着工具实例内部维护了一个 `Map<sessionKey, callback>` 的可变状态，本质上是把"谁在用这个工具"的路由逻辑塞进了工具本身。
2. **子智能体反馈注入（`handleSubAgentFeedback`）需要重新绑定工具**，导致 `feishu/index.ts` 中出现了大量重复的 bind 代码块（`onMessage`、`handleSubAgentFeedback`、`handleAsyncBridgeResult`、`onBridgeMessage` 四处几乎相同的绑定逻辑）。
3. **竞态风险**：`handleSubAgentFeedback` 中先检查 `isBusy()` 再绑定工具，但两步之间没有原子保护。虽然 Node.js 单线程下不会真正并发，但 `await` 点之间的交错仍可能导致绑定被覆盖。

**建议**：将飞书回调从"工具内部状态"提升为 `ToolExecutionContext` 的一部分。工具执行时从 context 中获取发送能力，而不是依赖预先绑定的闭包。这样可以消除 bind/unbind 仪式，也消除重复代码。

---

### 问题 2：两套并行的子任务系统（SubAgentManager vs AgentManager）职责重叠

**严重程度：中高**

系统中存在两套独立的"子任务"机制：
- `SubAgentManager` + `SubAgentSession`：用于 `spawn_subagent` 工具，面向飞书场景，支持 skill 激活、飞书回调、挂起/恢复。
- `AgentManager` + `BaseAgent` 子类（ExploreAgent, PlanAgent, BashAgent 等）：用于 `task` 工具，面向 CLI 场景，通过 `AgentToolExecutor` 执行。

两者都是"创建一个独立的对话循环去执行任务"，但：
- `SubAgentSession` 自己创建 `ToolManager`，自己构建 system prompt，自己管理 messages。
- `BaseAgent` 子类通过 `AgentToolExecutor` 包装父会话传入的工具子集。
- 两者的生命周期管理、错误重试、进度上报机制完全独立。

这导致：
- 维护两套几乎等价的对话循环管理逻辑。
- `SubAgentSession` 中的 `ToolManager` 是全新实例，与主会话的 `ToolManager` 没有关系，注册的工具可能不一致。
- 如果要给子任务加新能力（比如上下文压缩策略调整），需要改两个地方。

**建议**：统一为一套子任务抽象。`SubAgentSession` 和 `BaseAgent` 的核心都是"带独立 messages 的 ConversationRunner"，可以抽取一个统一的 `TaskRunner` 层，两者作为不同的配置 profile（飞书模式 vs CLI 模式）。

---

### 问题 3：PromptManager.buildSystemPrompt() 每次都重新实例化 SkillManager 并加载所有 skill

**严重程度：中**

```typescript
static async buildSystemPrompt(): Promise<string> {
    // ...
    const manager = new SkillManager();
    await manager.loadSkills();  // 每次都扫描文件系统
    // ...
}
```

`buildSystemPrompt()` 在每个新会话的 `init()` 中调用，每次都 `new SkillManager()` + `loadSkills()`（扫描磁盘、解析 SKILL.md）。而 `AgentServices` 中已经有一个 `skillManager` 实例了，这里完全没有复用。

**影响**：
- 不必要的 I/O 开销（虽然不大，但在高并发场景下会累积）。
- 更严重的是，如果运行时动态创建了 skill（通过 `create_skill`），这里新建的 SkillManager 可能和主 SkillManager 的状态不一致。

**建议**：`buildSystemPrompt()` 应接受 `SkillManager` 实例作为参数，或改为实例方法。

---

### 问题 4：AgentSession 的 busy 锁是布尔值，无法处理消息队列

**严重程度：中**

```typescript
if (this.busy) {
    return BUSY_MESSAGE;
}
```

当用户快速连发多条消息时，第二条及之后的消息直接被丢弃（返回"正在处理上一条消息"）。这在飞书场景下体验很差——用户发了一条消息后想补充信息，补充的内容会被吞掉。

更糟糕的是，`handleSubAgentFeedback` 中的重试逻辑（最多 10 次，每次等 5 秒）意味着子智能体的反馈可能要等 50 秒才能注入，如果这期间用户也在发消息，就会互相阻塞。

**建议**：引入消息队列机制。收到的消息先入队，当前处理完成后自动取下一条。或者至少支持"追加到当前对话"的语义，而不是简单丢弃。

---

### 问题 5：上下文压缩的 AI 摘要调用没有独立的 token 预算控制

**严重程度：中**

`ContextCompressor.compact()` 将旧消息拼接后发给 AI 做摘要，但：
1. 单条消息限制 1500 字符是硬编码的，没有根据实际 token 预算动态调整。
2. 摘要请求本身可能很大（大量旧消息拼接），如果旧消息太多，摘要 prompt 本身就可能超过模型上下文限制。
3. 摘要用的是同一个 `aiService`（同一个模型），没有用更便宜/更快的模型来做压缩。

**建议**：
- 摘要 prompt 的总 token 数应有上限，超过时先做机械截断再摘要。
- 考虑用更轻量的模型（如 haiku）做压缩，降低成本和延迟。

---

### 问题 6：ConversationRunner 中 `applyToolPolicy` 在循环内重复计算

**严重程度：低**

```typescript
while (turns++ < this.maxTurns) {
    const activeTools = this.applyToolPolicy(allTools, this.activeSkillToolPolicy)
        .filter(t => !this.disabledTools.has(t.name));
    // ...
    for (const toolCall of response.toolCalls) {
        const activeToolNames = this.applyToolPolicy(allTools, this.activeSkillToolPolicy)
            .filter(tool => !this.disabledTools.has(tool.name))
            .map(tool => tool.name);
        // ...
    }
}
```

每个 turn 计算一次 `activeTools`，然后在内层 for 循环中又对每个 toolCall 重新计算一次 `activeToolNames`。`applyToolPolicy` 的结果在同一个 turn 内不会变化（除非 skill 在 turn 中间被激活，但那是下一轮才生效的），这是不必要的重复计算。

**建议**：在 turn 开始时计算一次 `activeToolNames`，内层循环直接复用。

---

### 问题 7：工具名别名映射分散在多处，且不一致

**严重程度：中**

工具名别名映射出现在至少三个地方：
1. `tool-manager.ts` 中的 `TOOL_NAME_ALIASES`：`'Bash' → 'execute_bash'`
2. `conversation-runner.ts` 中的 `TOOL_NAME_ALIASES`：`'Bash' → 'execute_shell'`
3. 各处硬编码的工具名字符串

注意第 1 处映射 Bash → `execute_bash`，第 2 处映射 Bash → `execute_shell`。虽然 `safety.ts` 中做了 `execute_bash` 和 `execute_shell` 的等价处理，但这种分散的别名映射很容易在后续维护中产生不一致。

**建议**：统一到一个 `tool-aliases.ts` 模块，所有需要别名解析的地方都引用同一份映射。

---

### 问题 8：SessionManager 的过期清理存在异步竞态

**严重程度：低-中**

```typescript
setInterval(() => {
    for (const [key, session] of this.sessions) {
        if (now - session.lastActiveAt > this.ttl) {
            session.summarizeAndDestroy().catch(...);  // 异步
            this.sessions.delete(key);  // 同步立即删除
        }
    }
}, 60_000);
```

`summarizeAndDestroy()` 是异步的（需要调用 AI 生成摘要），但 `sessions.delete(key)` 是同步立即执行的。如果在摘要生成期间用户发来新消息，`getOrCreate` 会创建一个全新的空会话，而旧会话的摘要可能还在写入中。

更严重的是，`summarizeAndDestroy()` 内部会清空 `this.messages`，但此时 session 已经从 Map 中删除了，所以这个清空操作是多余的。

**建议**：先标记 session 为"正在销毁"状态，等 `summarizeAndDestroy()` 完成后再从 Map 中删除。或者在 `getOrCreate` 中检查是否有正在销毁的同名 session。

---

### 问题 9：SubAgentSession 每次都创建全新的 ToolManager，Python 工具重复加载

**严重程度：低-中**

```typescript
// SubAgentSession._executeOnce()
const toolManager = new ToolManager(this.options.workingDirectory, {...});
```

每个子智能体都 `new ToolManager()`，这会触发 `registerDefaultTools()` → `registerGlobalPythonTools()`，后者会扫描 `tools/global/` 目录并加载所有 Python 工具。如果同时有多个子智能体在运行，就会重复加载。

**建议**：Python 工具的定义（schema）可以缓存，只在首次加载时解析一次。或者让 SubAgentSession 接受一个工具定义的快照，而不是每次都重新扫描。

---

### 问题 10：错误处理中的信息泄露风险

**严重程度：低**

```typescript
// agent-session.ts
return `处理消息时出错: ${err.message}`;
```

错误消息直接返回给用户，可能包含内部路径、API key 片段、堆栈信息等敏感内容。虽然 `safety.ts` 做了一些防护，但错误路径上没有统一的脱敏处理。

**建议**：对用户可见的错误消息做统一脱敏，只返回通用错误描述，详细信息记录到日志。

---

### 问题 11：`deasync` 依赖是一个定时炸弹

**严重程度：中**

`package.json` 中依赖了 `deasync`，这是一个通过 C++ addon 阻塞 Node.js 事件循环来实现同步等待的库。它：
- 在某些 Node.js 版本上会 segfault
- 与 worker_threads 不兼容
- 在 Docker Alpine 镜像中经常编译失败
- 违背 Node.js 异步设计哲学

**建议**：排查哪里用了 `deasync`，替换为纯异步方案。

---

### 问题 12：ConversationRunner 的 shrinkMessage 对 tool 消息过于激进

**严重程度：低-中**

```typescript
if (message.role === 'tool') {
    const toolName = message.name || 'unknown';
    nextContent = `[tool:${toolName}] 历史输出已省略`;
}
```

在 `shrinkMessage` 中，所有 tool 消息的内容都被直接替换为"历史输出已省略"，不管是否在 aggressive 模式下。这意味着即使是最近的 tool 结果（比如刚执行的搜索结果），在上下文裁剪时也会被完全丢弃。

这个逻辑在 `hardTrimMessages` 中被调用，而 `hardTrimMessages` 的 `recent` 部分用的是 `shrinkMessage(msg, false)`（非 aggressive），但 tool 消息的处理不区分 aggressive 与否。

**建议**：非 aggressive 模式下，tool 消息应保留部分内容（比如前 500 字符），而不是完全丢弃。

---

## 三、架构层面的改进建议

### 3.1 引入 ExecutionContext 贯穿整个调用链

目前"谁在调用"、"通过什么渠道"、"有什么权限"这些信息分散在多个地方（sessionKey、surface、permissionProfile、飞书回调等）。建议引入一个统一的 `ExecutionContext` 对象，从消息入口创建，贯穿到 ConversationRunner、Tool 执行，避免到处传递零散参数。

### 3.2 工具注册应支持"能力声明"而非硬编码

当前工具的注册是在 `ToolManager.registerDefaultTools()` 中硬编码的。飞书工具（reply、send_file、mention）在 `FeishuBot` 构造函数中额外注册。这意味着 CLI 模式下也会注册飞书工具（只是没有绑定回调所以不会真正工作）。

建议工具注册支持"能力声明"：工具声明自己需要什么能力（如 `requires: ['feishu']`），ToolManager 根据当前运行环境自动过滤。

### 3.3 消息格式应与 Provider 解耦

当前 `Message` 类型直接使用了 OpenAI 风格的 `tool_calls`、`tool_call_id` 字段。虽然 `AnthropicProvider` 内部做了转换，但这意味着核心数据结构绑定了特定 Provider 的消息格式。如果未来要支持 Gemini 等其他 Provider，转换逻辑会越来越复杂。

建议定义一个 Provider 无关的内部消息格式，在 Provider 层做双向转换。

---

## 四、做得好的地方

- **ConversationRunner 的工具熔断机制**：连续失败自动禁用，策略阻断立即禁用，设计得很实用。
- **AIService 的主备链路 + 指数退避重试**：生产级的可靠性设计。
- **SubAgentSession 的会话级重试**：区分可重试错误和不可重试错误，带指数退避。
- **安全模块（safety.ts）**：危险命令检测、路径越界检查、.env 保护，覆盖面不错。
- **Skill 系统的设计**：通过 Markdown 文件定义 skill，支持工具策略白名单/黑名单，激活信号的 upsert 机制避免重复注入。
- **上下文压缩的分层策略**：AI 摘要 → 机械截断 → 最小降级，三级 fallback 很稳健。
