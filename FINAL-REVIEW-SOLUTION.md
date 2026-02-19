# XiaoBa 最终评估 — 解决方案文档

**整理人**: XiaoBa  
**日期**: 2026-02-19  
**基于**: ErGoz 最终评估报告 (FINAL-REVIEW.md) + 三方讨论

---

## 本轮修复范围

修 5 个问题（2 个阻塞 + 3 个强烈建议），其余放后续迭代。

### 🔴 C1: ChimeInJudge 构造函数无用参数

**问题**: 构造函数接收 aiService 但 void 丢弃，是上轮修 maxTokens 时的残留。

**方案**: 删掉 aiService 参数，调用方同步修改。

**改动文件**:
- src/bridge/chime-in-judge.ts — 构造函数签名去掉 aiService
- src/feishu/index.ts — 调用处去掉 aiService 参数

### 🔴 C2: injectContext 无限膨胀 session 历史

**问题**: 每条广播消息都 push 进 messages 数组，bot 长时间旁听不说话时无限增长。

**方案**: injectContext 加上限，只保留最近 N 条注入的上下文消息，超过自动丢弃最早的。N 的值待老师拍板（ErGoz 建议 30，小八建议 50）。

**改动文件**:
- src/core/agent-session.ts — injectContext 方法加上限裁剪逻辑

### 🔴 H1: Group/ 同事档案没有注入 system prompt

**问题**: Group/CatCompany.md 里写了角色和擅长，但 bot 的 system prompt 里完全没有这些信息，P1 形同虚设。

**方案**: FeishuBot 启动时读取 Group/*.md，把成员信息拼成文本，注入到 session 的 system prompt 中。

**改动文件**:
- src/feishu/index.ts — 启动时读 Group md，传给 SessionManager
- src/feishu/session-manager.ts — 创建 session 时注入同事信息

### 🟡 H2: chime-in 判断没有利用同事档案

**问题**: ChimeInJudge 只知道自己的名字和擅长，不知道群里还有谁。无法做出"这事让 ErGoz 来更合适"的判断。

**方案**: ChimeInConfig 加 teammates 字段，构造时从 Group md 读入。判断 prompt 里加上"群里还有以下同事：xxx 擅长 yyy"，让 LLM 能综合判断。

**改动文件**:
- src/bridge/chime-in-judge.ts — ChimeInConfig 加 teammates，prompt 加同事信息

### 🟡 H3: 插嘴回复缺乏"接话"语感

**问题**: 插嘴和被@走的是同一套推理流程，回复风格没有区分。

**方案**: 插嘴触发推理时，在用户消息前注入一条 system hint：`[你是主动插嘴参与讨论，不是被直接提问，请保持简短自然]`。

**改动文件**:
- src/feishu/index.ts — onGroupBroadcast 插嘴分支，handleMessage 前注入 hint

---

## 明确不动的（后续迭代）

| 编号 | 问题 | 原因 |
|------|------|------|
| C3 | 广播 session key 可能不一致 | 当前两个 bot 在同一群，chat_id 一致，暂无风险 |
| C4 | @检测仍是 includes() | 安全补丁清单，独立排期 |
| C5 | Bridge 无认证 | 安全补丁清单，独立排期 |
| C6 | PromptManager 重复创建 SkillManager | 性能优化，不影响正确性 |
| H4 | 不区分老师/bot 消息 | 锦上添花 |
| H5 | 没有"打字中"状态 | 锦上添花，飞书 API 限制 |

---

## 待老师确认

- C2 的 injectContext 上限：30 条（ErGoz）还是 50 条（小八）？

确认后立即开始改代码，改完让 ErGoz review。

---

*整理: XiaoBa · 2026-02-19*
