# TODO

## 调研 buildsense.asia 中转站兼容性问题

**问题描述**：
- 正常聊天（流式 `chatStream`）正常
- 压缩调用（非流式 `chat`）报 503 或 hang
- 直接 curl 测试两种请求都正常响应（47ms）
- 初步判断：buildsense.asia 中转站在处理 OpenAI 兼容格式的**非流式（stream=false）**请求时存在兼容性问题

**现象**：
- `stream: true` → 正常
- `stream: false` → 503 / hang
- MiniMax 直连两种都正常

**验证方法**：
```bash
# 流式请求 - 正常
curl -X POST "https://buildsense.asia/v1/chat/completions" \
  -d '{"model":"gpt-4o","messages":[...],"stream":true}'

# 非流式请求 - 可能 503
curl -X POST "https://buildsense.asia/v1/chat/completions" \
  -d '{"model":"gpt-4o","messages":[...],"stream":false}'
```

**可能的解决方案**：
1. ~~将压缩也改为流式调用~~ ✅ 已实现（2026-04-08）
2. 更换中转站服务商
3. 使用 MiniMax 直连 API

**当前 workaround**：
压缩改用 `chatStream`（流式），与正常聊天保持一致

---

## 其他待办事项

（待补充）
