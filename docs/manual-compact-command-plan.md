# `/compact` 手动检查点压缩实施计划

## 目标

提供一个唯一的手动控制命令 `/compact`，让用户在当前会话空闲时主动执行一次现有的 checkpoint 压缩。

这不是新的 Summary Agent，也不是 Branch Memory；不改变自动压缩阈值，不切换模型，不创建新 Episode。

## 用户可见行为

```text
/compact
  → 正在压缩上下文……
  → 上下文已压缩，检查点已保存。
```

- `/compact` 不作为普通 `user` 消息进入模型上下文。
- 压缩成功后，旧的 durable transcript 由 checkpoint summary、保留的近期尾部和 transient runtime 内容组成；会话身份与任务继续保留。
- 没有可压缩的历史时，不调用 Summary 模型，并提示当前无需压缩。
- 压缩失败时保留原上下文，提示用户稍后重试。
- 当前模型回合或另一轮手动压缩正在进行时，不并发修改上下文，返回等待提示。

## 实现边界

### XiaoBa

1. 在 `AgentSession.handleCommand()` 增加唯一命令 `compact`。
2. 给现有 `CheckpointCompactionCoordinator` 增加一次性 `force` 请求标记；手动命令不受 85% 自动触发阈值限制，但仍经过现有“无可压缩内容”和“摘要没有缩减”保护。
3. 手动压缩使用现有 Summary 请求、重试、流空闲超时、摘要校验、checkpoint 持久化和错误保护。
4. 增加很薄的会话级互斥状态，避免 `/compact` 与模型回合或另一个 `/compact` 并发修改 `messages`。
5. 使用现有压缩状态回调发送 Working 风格的开始、完成、失败提示；日志沿用既有 checkpoint 事件，并标识 `phase=manual`。
6. CLI 帮助加入 `/compact`；命令分派保留其普通异步路径，以便显示 Working 进度。

### CatsCompany

1. 复用现有斜杠命令解析、`session.handleCommand()` 和 `sender.reply()`，不新增 HTTP API。
2. 不复制 `/clear` 的清队列、清 generation、取消任务和持久化哨兵逻辑；`/compact` 只压缩当前会话。
3. 为命令执行补充 Working 状态回调映射，使用户能看到“正在压缩”；完成/失败仍通过现有命令回复返回。
4. 增加协议回归测试，证明命令不进入普通模型回合且只产生一次回复。

## 日志与会话记录

- `/compact` 输入和完成提示不写入普通会话 transcript。
- 复用现有 `checkpoint_compaction` start/complete/error/skipped 记录；不新增日志文件或数据库表。
- checkpoint summary 本身是会话的正常持久化内容，原始运行日志仍由现有日志链路保留。

## 不做的事情

- 不增加 `/summary`、`/checkpoint` 等别名。
- 不加入自动定时压缩、提前压缩、模型切换或 `/resume`。
- 不修改 Branch Memory、长 Episode Memory 或 Branch Summary。
- 不修改 Saturday 现有分支和部署环境。

## 验收

- 低于自动阈值时 `/compact` 仍能主动生成 checkpoint。
- 没有可压缩内容时不调用模型。
- 成功、失败、重复调用和忙时行为明确。
- 命令与提示不进入模型 transcript。
- CLI 和 CatsCompany 都能收到开始/完成/失败反馈。
- `/clear` 既有行为不变。
- XiaoBa 与 CatsCompany 的构建、相关单测和完整 CI 通过。
