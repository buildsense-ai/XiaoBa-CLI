# 跨会话记忆改进方案

## 问题总结

当前已实现追加式 summary 存储，但存在四个缺陷：
1. summary 压缩质量不稳定（通用 prompt 无法区分不同类型对话的重点）
2. 加载条数硬编码，可能挤占 context
3. log 文件是进程级的，无法精确定位到某个 session 的对话段
4. 低质量会话（如只说了"在吗"）也会生成 summary，浪费记忆槽位

---

## 方案一：summary 压缩质量

### 改动点：summarizeAndDestroy() 中的 prompt

把通用的"请摘要"改成结构化提取 prompt，要求输出固定格式：

```
请从以下对话中提取关键信息，按以下格式输出：

**主题：** 一句话概括这次对话在聊什么
**关键决策：** 老师做了什么决定、表达了什么偏好（如果有）
**待办/后续：** 有没有未完成的事、下次要跟进的（如果有）
**关键事实：** 提到的论文名、技术方案、文件路径等具体信息

对话内容：
{conversationText}
```

好处：结构化输出更稳定，加载时也更容易被我理解和利用。

---

## 方案二：按 token 预算加载 summary

### 改动点：loadSessionSummary()

不再用 MAX_LOAD_COUNT 硬编码条数，改为按 token 预算从新到旧加载：

- 设一个 MAX_SUMMARY_TOKENS（比如 2000）
- 从最新的 entry 开始往回取，粗估每条 summary 的 token 数（字符数 / 2 作为中文粗估）
- 累计超过预算就停

这样不管 summary 长短，都不会挤占太多 context。

---

## 方案三：log 定位精确化

### 改动点：summarizeAndDestroy() 写入时额外记录时间范围

不改 Logger 的全局单例设计（改动太大），而是在 summary entry 里多存两个字段：

```typescript
interface SummaryEntry {
  summary: string;
  savedAt: string;
  logFile?: string;
  sessionStart?: string;  // 新增：会话第一条 user 消息的时间
  sessionKey?: string;     // 新增：会话 key（如 user:ou_xxx）
}
```

sessionStart 从 messages 里取第一条 user 消息的时间戳（或者直接用 AgentSession 创建时间）。

这样回溯时：打开 logFile → 搜索 sessionKey + sessionStart 附近的时间戳 → 就能精确定位到那段对话。

### AgentSession 改动

在 AgentSession 上加一个 `createdAt` 字段，构造时记录时间，summarize 时传给 saveSessionSummary。

---

## 方案四：低质量会话过滤

### 改动点：summarizeAndDestroy() 入口

在现有的 `hasUserMessages` 检查之后，加一个最小轮次判断：

```typescript
const userMessageCount = this.messages.filter(m => m.role === 'user').length;
if (userMessageCount < 2) {
  Logger.info(`会话内容过少(${userMessageCount}轮)，跳过摘要: ${this.key}`);
  this.messages = [];
  return false;
}
```

阈值设为 2（至少有2条 user 消息才值得存）。只说了"在吗"然后没下文的就直接丢弃。

---

## 改动范围汇总

| 文件 | 改动 |
|------|------|
| agent-session.ts | 改 summarize prompt、加 createdAt、加最小轮次过滤、传 sessionStart |
| local-session-store.ts | SummaryEntry 加字段、loadSessionSummary 改为 token 预算模式 |

总共两个文件，不引入新依赖。
