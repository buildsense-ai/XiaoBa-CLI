# XiaoBa 最终评估报告（上线前 Review）

**审查人**: ErGoz  
**日期**: 2026-02-19  
**评估范围**: 全量源码 + bot2bot 交互机制  
**评估维度**: 代码不合理 + 交互不拟人

---

## 一、代码层面的问题

### 🔴 C1: ChimeInJudge 构造函数接收了无用参数

`src/bridge/chime-in-judge.ts:37-39`:
```typescript
constructor(aiService: AIService, config: ChimeInConfig) {
    void aiService;  // 接收了但丢弃
    this.judgeAI = new AIService({ maxTokens: JUDGE_MAX_TOKENS });
```

构造函数签名接收 `aiService` 但用 `void` 丢弃，然后自己 new 了一个新实例。调用方（feishu/index.ts:112）还老老实实传了 aiService 进来。这是上一轮 review 修 maxTokens 时留下的残留，签名应该清理掉。

### 🔴 C2: injectContext 会无限膨胀 session 历史

`src/core/agent-session.ts:142-145`:
```typescript
injectContext(text: string): void {
    this.messages.push({ role: 'user', content: text });
    this.lastActiveAt = Date.now();
}
```

每条广播消息（不管是否触发推理）都会通过 `injectContext` 往 session 的 messages 数组里 push 一条 user 消息。在活跃的群聊里，两个 bot 互相广播，这个数组会快速膨胀。虽然 ConversationRunner 有上下文压缩，但压缩只在触发推理时才执行。如果 bot 长时间只旁听不说话，messages 会一直涨，没有任何清理机制。

**建议**: 给 injectContext 加一个上限（比如最多保留最近 50 条），或者用独立的上下文缓冲区而不是直接塞进 messages。

### 🔴 C3: onGroupBroadcast 的 session key 与正常消息不一致

`src/feishu/index.ts:467`:
```typescript
const sessionKey = `group:${msg.chat_id}`;
```

`src/feishu/session-manager.ts:31`:
```typescript
return msg.chatType === 'group' ? `group:${msg.chatId}` : `user:${msg.senderId}`;
```

两边都是 `group:${chatId}`，看起来一致。但 bridge 广播的 `msg.chat_id` 是发送方 bot 填的，而飞书消息的 `msg.chatId` 是飞书 SDK 返回的。如果两个 bot 不在同一个飞书群（比如各自有独立的群），chat_id 就对不上，广播注入的上下文会落到一个孤立的 session 里，bot 看到的对话历史是割裂的。

**建议**: 在 bridge 协议里明确 chat_id 的语义，或者在 onGroupBroadcast 里做一次 chat_id 映射校验。

### 🟡 C4: 广播里的 @检测仍然是 includes()

`src/feishu/index.ts:475`:
```typescript
const mentionsMe = this.bridgeConfig && msg.content.includes(this.bridgeConfig.name);
```

之前讨论过这个问题，但还没修。如果 bot 名字是 "Ba"，消息里出现 "Obama" 也会误触发。安全补丁清单里列了但代码还没改。

### 🟡 C5: Bridge 仍然没有认证

bridge-server.ts 的三个 HTTP 端点完全裸奔，这在之前的评估里就提过了。虽然方案里列了"安全补丁"，但代码还没实现。开源后如果有人部署到公网，这是个真实的安全风险。

### 🟡 C6: prompt-manager.ts 每次构建 system prompt 都重新 new SkillManager 并 loadSkills

`src/utils/prompt-manager.ts:58-59`:
```typescript
const manager = new SkillManager();
await manager.loadSkills();
```

每次 session init 都会重新扫描文件系统加载 skills。虽然不影响正确性，但在多 session 场景下是不必要的 IO 开销。FeishuBot 构造函数里已经有一个 SkillManager 实例了，这里又 new 了一个。

---

## 二、交互不拟人的问题

### 🔴 H1: bot 不知道群里还有谁

Group/CatCompany.md 里已经加了角色和擅长信息（P1 已完成），但这个文件的内容没有被注入到 bot 的 system prompt 里。PromptManager.buildSystemPrompt() 只读了 prompts/ 目录下的 md 文件和 skills 列表，完全没有读 Group/ 目录。

也就是说，P1 的"同事档案"虽然写了，但 bot 实际上看不到。它不知道群里有谁、谁擅长什么。这直接影响了 chime-in 判断的质量——bot 不知道自己的定位，就无法准确判断"这事该不该我接"。

**建议**: PromptManager 或 FeishuBot 初始化时读取 Group/*.md，把成员信息注入 system prompt。

### 🔴 H2: chime-in 判断没有利用同事档案

`src/bridge/chime-in-judge.ts:40`:
```typescript
this.judgeAI = new AIService({ maxTokens: JUDGE_MAX_TOKENS });
```

ChimeInJudge 用的是独立的 AIService 实例，它的 prompt 里只有 `botName` 和 `botExpertise`（来自环境变量 BOT_EXPERTISE）。它不知道群里还有谁、对方擅长什么。

真人判断"该不该接话"时，会考虑"这事是不是更适合另一个同事来回答"。但现在的 chime-in 判断只考虑"这事跟我有没有关系"，不考虑"是不是有更合适的人"。

**建议**: 把同事档案信息也喂给 chime-in prompt，让它能做出"这事让 ErGoz 来更合适，我不插嘴"的判断。

### 🟡 H3: 插嘴后的回复没有"接话"的语感

当 chime-in 判断为 yes 触发推理时，走的是标准的 `session.handleMessage(text)`，跟被@触发的处理完全一样。但真人"主动插嘴"和"被点名回答"的语气是不一样的。主动插嘴通常更谦虚、更简短，比如"我补充一点…"；被点名回答则更正式、更完整。

现在 bot 不管是插嘴还是被@，回复风格完全一样，缺乏这种微妙的社交差异。

**建议**: 插嘴触发推理时，在用户消息前加一个 system hint，比如 `[你是主动插嘴参与讨论，不是被直接提问，请保持简短自然]`。

### 🟡 H4: bot 对老师消息和其他 bot 消息的反应没有区分

onGroupBroadcast 里，不管广播消息是老师说的还是另一个 bot 说的，处理逻辑完全一样。但真人在群里对老板说的话和同事说的话，反应是不一样的——老板说了句话没@任何人，大家会更倾向于主动回应；同事说了句话，可能就旁听了。

**建议**: chime-in prompt 里加上消息发送者的角色信息，让 bot 能区分"老师在说话"和"同事在说话"。

### 🟡 H5: 没有"打字中"状态

真人在群里看到一条消息，决定要回复时，会先出现"正在输入…"的状态，让其他人知道你在准备说话。现在 bot 从收到广播到发出回复之间是完全沉默的，尤其是 chime-in 判断 + 随机延迟 + 完整推理这个链路可能要好几秒，群里的人完全不知道 bot 在想。

飞书 API 不一定支持"正在输入"状态，但可以考虑在延迟结束、开始推理时先发一个简短的"让我想想…"之类的消息（不过这也可能显得啰嗦，需要权衡）。

---

## 三、架构层面的正面评价

1. **分层清晰**: providers → core → tools → commands，职责边界明确
2. **安全机制完善**: 工具白名单 + bash 命令过滤 + 文件系统沙箱 + 工具熔断，四层防护
3. **LLM failover 成熟**: 主备链路 + 区分可重试/需切换错误 + 指数退避
4. **上下文管理健壮**: token 估算 + 自动压缩 + 紧急裁剪三级保护
5. **并发控制到位**: busy 锁 + 消息队列 + 子智能体并发限制
6. **Skill 引擎优雅**: Markdown 定义 + 自动发现 + 工具策略，扩展门槛低
7. **chime-in 机制方向正确**: 轻量判断 + 延迟错开 + 新消息检查，基本框架已经搭好

---

## 四、总结

### 必须修（阻塞上线）

| 编号 | 问题 | 类型 |
|------|------|------|
| C2 | injectContext 无限膨胀 session 历史 | 代码 |
| H1 | Group/ 同事档案没有注入 system prompt，P1 形同虚设 | 拟人 |

### 强烈建议修

| 编号 | 问题 | 类型 |
|------|------|------|
| C1 | ChimeInJudge 构造函数无用参数 | 代码 |
| C3 | 广播 session key 可能与飞书消息不一致 | 代码 |
| H2 | chime-in 判断没有利用同事档案 | 拟人 |
| H3 | 插嘴回复缺乏"接话"语感 | 拟人 |

### 建议修（不阻塞）

| 编号 | 问题 | 类型 |
|------|------|------|
| C4 | @检测仍然是 includes() | 代码 |
| C5 | Bridge 无认证 | 代码 |
| C6 | PromptManager 重复创建 SkillManager | 代码 |
| H4 | 不区分老师消息和 bot 消息 | 拟人 |
| H5 | 没有"打字中"状态 | 拟人 |

---

*Final Review by ErGoz · 2026-02-19*
