# Code Review: P0 chime-in judge + P1 teammate profiles

**审查人**: ErGoz  
**日期**: 2026-02-19  
**Commit**: 1c8235f  
**结论**: ⚠️ REQUEST_CHANGES — 有 2 个问题需要修复

---

## 改动概要

- 新增 `src/bridge/chime-in-judge.ts` — 轻量"该不该插嘴"判断模块
- 改造 `src/feishu/index.ts` 的 `onGroupBroadcast` — 未被@时走 chime-in 判断
- 顺手修了 `feishu/index.ts:128-130` 残留的硬编码 IP 和用户名（P0 阻塞项遗漏，好事）

---

## 问题

### 🔴 问题1：chime-in 判断没有限制 max_tokens

`chime-in-judge.ts:53` 调用 `this.aiService.chat()`，但 `AIService.chat()` 不接受 max_tokens 参数，会使用全局默认值。方案里明确说了"几十个 token 搞定"，但实际上 LLM 可能返回一大段解释文字而不是简单的 yes/no，白白烧 token。

`JUDGE_MAX_TOKENS = 20` 这个常量定义了但没用上，是死代码。

**建议**: 要么给 `AIService.chat()` 加 options 参数支持 max_tokens，要么在 ChimeInJudge 里用一个独立的、配置了低 max_tokens 的 AIService 实例。

### 🔴 问题2：延迟后没有检查对方是否已经回复

方案里写的是"先发出来的说，另一个看到对方已回复后重新判断要不要还说"。但代码里只做了随机延迟，延迟结束后直接触发推理，没有检查延迟期间是否有其他 bot 已经回复了同一条消息。

`index.ts:483-485`:
```typescript
const delay = 1000 + Math.random() * 2000;
await new Promise(resolve => setTimeout(resolve, delay));
// 这里直接往下走了，没有 re-check
```

**建议**: 延迟结束后检查 session 的最近上下文，如果发现已有其他 bot 回复了相关内容，就跳过不说。

---

## 正面评价

- chime-in-judge.ts 整体设计干净，职责单一，上下文窗口滑动（slice -MAX_CONTEXT_MESSAGES）实现正确
- prompt 设计简洁有效，"只回答 yes/no 不要解释"是对的
- 错误处理合理：判断失败时默认不插嘴（return false），不会因为 LLM 调用失败就乱说话
- onGroupBroadcast 的改造逻辑清晰，被@和未被@的分支处理得当
- 顺手修掉了 feishu/index.ts 里残留的硬编码 IP，好习惯

---

## 小建议（不阻塞合并）

- `BOT_EXPERTISE` 环境变量没有文档，建议在 .env.example 里加一行
- `buildJudgeUserPrompt` 是模块级函数但没有 export，如果以后要单测会不方便，不过现在不急

---

*Review by ErGoz · 2026-02-19*
