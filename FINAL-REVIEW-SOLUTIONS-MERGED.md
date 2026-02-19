# XiaoBa 最终评估 — 解决方案文档（合并版）

**整理人**: ErGoz（合并 ErGoz + XiaoBa 两份方案的优点）  
**日期**: 2026-02-19  
**基于**: FINAL-REVIEW.md 评估报告 + 三方讨论

---

## 本轮修复范围

修 6 个问题（3 个阻塞 + 3 个强烈建议），其余放后续迭代。

---

## 一、阻塞上线

### 🔴 C1: ChimeInJudge 构造函数无用参数

**问题**: 构造函数接收 aiService 但 void 丢弃，上轮修 maxTokens 时的残留。签名不对就是不对。

**方案**: 删掉 aiService 参数，调用方同步修改。

**改动文件**:
- `src/bridge/chime-in-judge.ts` — 构造函数签名去掉 aiService
- `src/feishu/index.ts` — 调用处去掉 aiService 参数

**预估**: 2 行改动

### 🔴 C2: injectContext 无限膨胀 session 历史

**问题**: 每条广播消息都 push 进 messages 数组，bot 长时间旁听不说话时无限增长，无清理机制。

**方案**: injectContext 加滑动窗口上限，只保留最近 N 条注入的上下文消息，超过自动丢弃最早的。保留 system 消息和正常对话消息不受影响。N 的值待老师拍板（ErGoz 建议 30，XiaoBa 建议 50）。

**改动文件**:
- `src/core/agent-session.ts` — injectContext 方法加上限裁剪逻辑

**预估**: 约 10 行改动

### 🔴 H1: Group/ 同事档案没有注入 system prompt

**问题**: Group/CatCompany.md 里写了角色和擅长，但 bot 的 system prompt 里完全没有这些信息，P1 形同虚设。

**方案**: FeishuBot 启动时读取 Group/*.md，解析成员表。SessionManager 创建 session 时将同事信息作为一条 system 消息注入（类似现有的 `[surface:feishu]`）。不改 PromptManager，CLI 模式不需要这个信息。

**改动文件**:
- `src/feishu/index.ts` — 启动时读 Group md，传给 SessionManager
- `src/feishu/session-manager.ts` — 创建 session 时注入同事信息

**预估**: 约 30 行改动

---

## 二、强烈建议修

### 🟡 C3: 广播 session key 可能与飞书消息不一致

**问题**: bridge 广播的 `msg.chat_id` 是发送方 bot 填的，如果两个 bot 不在同一个飞书群，chat_id 对不上，上下文会落到孤立 session。

**方案**: onGroupBroadcast 里校验 chat_id 是否属于当前 bot 已知的群（从 Group/*.md 读取已知 chat_id 列表），不认识的 chat_id 直接忽略。

**改动文件**:
- `src/feishu/index.ts` — onGroupBroadcast 方法加校验

**预估**: 约 5 行改动

### 🟡 H2: chime-in 判断没有利用同事档案

**问题**: ChimeInJudge 只知道自己的名字和擅长，不知道群里还有谁。无法做出"这事让对方来更合适"的判断。

**方案**: ChimeInConfig 加 `teammates` 字段（名字+擅长的数组），构造时从 Group md 读入。`buildJudgeUserPrompt` 里加一段"群里还有以下同事：XXX 擅长 YYY"，让 LLM 能综合判断。

**改动文件**:
- `src/bridge/chime-in-judge.ts` — ChimeInConfig 加 teammates，prompt 加同事信息

**预估**: 约 10 行改动

### 🟡 H3: 插嘴回复缺乏"接话"语感

**问题**: 插嘴和被@走同一套推理流程，回复风格没有区分。真人主动插嘴会更简短自然。

**方案**: 插嘴触发推理时，在用户消息前注入一条 system hint：`[你是主动插嘴参与讨论，不是被直接提问，请保持简短自然]`。

**改动文件**:
- `src/feishu/index.ts` — onGroupBroadcast 插嘴分支，handleMessage 前注入 hint

**预估**: 1 行改动

---

## 三、明确不动的（后续迭代）

| 编号 | 问题 | 为什么现在不动 |
|------|------|----------------|
| C4 | @检测仍是 includes() | 安全补丁清单，独立排期修 |
| C5 | Bridge 无认证 | 安全补丁清单，独立排期修 |
| C6 | PromptManager 重复创建 SkillManager | 性能优化，不影响正确性，当前 session 数量少感知不到 |
| H4 | 不区分老师/bot 消息 | 锦上添花，当前两个 bot 场景下影响不大 |
| H5 | 没有"打字中"状态 | 飞书 API 限制，且可能显得啰嗦，需要更多体验验证 |

---

## 四、待老师确认

- C2 的 injectContext 上限：30 条（ErGoz）还是 50 条（XiaoBa）？

确认后小八立即开始改代码，改完 ErGoz review。

---

*合并版由 ErGoz 整理 · 2026-02-19*
