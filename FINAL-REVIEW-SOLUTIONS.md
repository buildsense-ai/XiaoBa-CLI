# XiaoBa 最终评估 — 解决方案文档

**整理人**: ErGoz  
**日期**: 2026-02-19  
**基于**: FINAL-REVIEW.md 评估结果 + ErGoz & XiaoBa 双方方案讨论

---

## 一、必须修（阻塞上线）

### C2: injectContext 无限膨胀 session 历史

**问题**: 每条广播消息都往 session.messages 里 push，bot 长时间旁听不说话时数组无限增长，无清理机制。

**方案**: 在 `AgentSession.injectContext()` 里加滑动窗口，限制注入的上下文消息数量上限（ErGoz 建议 30，XiaoBa 建议 50，待老师定）。超过上限时丢弃最早的注入消息，保留 system 消息和正常对话消息不受影响。

**改动范围**: `src/core/agent-session.ts` — injectContext 方法，约 10 行改动。

### H1: Group/ 同事档案没有注入 system prompt

**问题**: P1 在 Group/CatCompany.md 里加了角色和擅长信息，但代码没有读取和注入，bot 实际上看不到。

**方案**: 在 `FeishuBot` 构造函数里读取 Group/*.md，解析成员表。在 session init 时作为一条 system 消息注入（类似现有的 `[surface:feishu]`），不改 PromptManager（CLI 模式不需要这个信息）。

**改动范围**: `src/feishu/index.ts` — 构造函数加读取逻辑 + session 创建时注入，约 30 行改动。

---

## 二、强烈建议修

### C1: ChimeInJudge 构造函数无用参数

**问题**: 接收 `aiService` 参数但用 `void` 丢弃，上轮 review 修 maxTokens 时的残留。

**方案**: 删掉构造函数的 `aiService` 参数，调用方同步修改。

**改动范围**: `src/bridge/chime-in-judge.ts` + `src/feishu/index.ts`，2 行改动。

### C3: 广播 session key 可能与飞书消息不一致

**问题**: bridge 广播的 `msg.chat_id` 是发送方 bot 填的，如果两个 bot 不在同一个飞书群，chat_id 对不上，上下文会落到孤立 session。

**方案**: 在 onGroupBroadcast 里校验 chat_id 是否属于当前 bot 已知的群（可从 Group/*.md 读取已知 chat_id 列表），不认识的 chat_id 直接忽略。

**改动范围**: `src/feishu/index.ts` — onGroupBroadcast 方法加校验，约 5 行改动。

### H2: chime-in 判断没有利用同事档案

**问题**: ChimeInJudge 只知道自己的名字和擅长，不知道群里还有谁。无法做出"这事让对方来更合适"的判断。

**方案**: `ChimeInConfig` 加 `teammates` 字段（名字+擅长的数组），构造时从 Group md 读入。`buildJudgeUserPrompt` 里加一段"群里还有 XXX 擅长 YYY"，让 LLM 能综合判断。

**改动范围**: `src/bridge/chime-in-judge.ts`，约 10 行改动。

### H3: 插嘴回复缺乏"接话"语感

**问题**: 插嘴和被@走同一套推理流程，回复风格没有区分。真人主动插嘴会更简短自然。

**方案**: 插嘴触发推理时，在消息前注入一条 system hint：`[你是主动参与讨论，不是被直接提问，保持简短自然]`。在 onGroupBroadcast 的 chime-in 分支里加。

**改动范围**: `src/feishu/index.ts` — onGroupBroadcast 方法，1 行改动。

---

## 三、后续迭代（不阻塞上线）

| 编号 | 问题 | 方案思路 |
|------|------|----------|
| C4 | @检测用 includes() 会误触发 | 改为正则词边界匹配，或在广播协议里加 mentions 字段 |
| C5 | Bridge 无认证 | 加 shared secret 或 HMAC 签名 |
| C6 | PromptManager 重复创建 SkillManager | 改为接收外部传入的 SkillManager 实例 |
| H4 | 不区分老师消息和 bot 消息 | chime-in prompt 加发送者角色信息 |
| H5 | 没有"打字中"状态 | 评估飞书 API 是否支持，或在开始推理时发一条简短提示 |

---

## 四、待老师决定

- C2 的 injectContext 上限数量：30（ErGoz）还是 50（XiaoBa）？

---

*方案由 ErGoz 整理，基于 ErGoz + XiaoBa 双方讨论 · 2026-02-19*
