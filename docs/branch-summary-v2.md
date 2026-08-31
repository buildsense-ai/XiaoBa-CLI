# Branch Summary v2

Branch Summary 只负责压缩当前 Episode 的 durable transcript。它不搜索历史，
也不向主 Agent 注入建议；Branch Memory 仍是独立能力。

## 运行契约

只有两个上下文水位：

- **70% 启动点**：在 pre-turn、模型请求前或完整 tool batch 后，精确计算
  `message tokens + tool tokens`。达到 70% 且没有候选时，复制不可变快照，
  使用主 Session 相同的 `AIService`、Provider、模型和凭据异步生成摘要。
- **85% 停止点**：不再发起新的主模型请求。若 70% 启动的摘要仍在运行，
  主 Agent 等待同一个摘要，不取消也不重建。

摘要完成后只在安全边界提交：模型请求前、完整 tool batch 后、Episode 结束时。
提交使用 revision、Episode、前缀 hash 和边界长度做 CAS；快照之后新增的消息作为
suffix 原样保留，未完成的 tool exchange 不允许提交。

## 失败与恢复

- 异步候选最长运行 15 分钟，共享一个最多 18 次 Provider 请求的预算。
- 502、超时、网络中断、空摘要和缺少终态的流响应，在同一候选中最多尝试 3 次。
- 401/403 不做无意义重试，按认证错误冻结。
- 85% 时若异步候选已经确定失败、过期或无法安全提交，主 Agent保持暂停，基于
  最新 durable transcript 启动一次串行候选；它复用相同的三次重试、请求预算、
  CAS 和持久化规则。
- 串行候选最终失败时保留完整 transcript 并冻结 Session，不截断历史，也不继续
  请求主模型。

## 可观测性

每个候选记录：

- 主 Session 实际使用的 provider 和 model；
- 启动、ready、stop、commit/failure 时间；
- 总耗时、达到停止点后的等待时间；
- 逻辑尝试数和 Provider 请求数/上限；
- 摘要输入、输出、cache read、cache write tokens；
- async candidate 或 serial fallback 模式，以及最终 outcome/failure reason。

## 非目标

- 不增加用户命令或 UI；普通用户输入和长 Episode 自动使用该机制。
- 不改变 Branch Memory 的历史搜索、周期激活或注入协议。
- 不为摘要单独配置 MiniMax；摘要跟随主 Session 模型。
- 不在不安全位置替换 transcript，不静默丢弃用户输入或工具结果。

