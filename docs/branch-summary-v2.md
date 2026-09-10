# Branch Summary v2

Branch Summary 只负责压缩当前 Episode 的 durable transcript。它不搜索历史，
也不向主 Agent 注入建议；Branch Memory 仍是独立能力。

## 运行契约

只有两个上下文水位：

- **75% 启动点**：对正常 256K+ 模型，按物理上下文窗口计算；在 pre-turn、
  模型请求前或完整 tool batch 后，使用 Provider usage 锚点校准
  `durable message tokens + 本轮实际 tool tokens + 一次性 prompt tokens`。
  超过 75% 且没有候选时，复制不可变快照，
  使用主 Session 相同的 `AIService`、Provider、模型和凭据异步生成摘要。
- **85% 停止点**：正常 256K+ 模型按物理窗口超过 85% 后不再发起新的主模型请求。
  若 75% 启动的摘要仍在运行，
  主 Agent 等待同一个摘要，不取消也不重建。

安全空间只计算一次：不再先扣固定 reserve 后又乘 75%/85%。小于 256K 或最大输出
无法装入剩余 15% 的配置继续使用主线的安全 input limit；如果该 limit 不高于启动点，
则不投机启动异步候选，直接在安全边界使用串行检查点。

摘要完成后只在安全边界提交：模型请求前、完整 tool batch 后、Episode 结束时。
提交使用 revision、Episode、前缀 hash 和边界长度做 CAS；快照之后新增的消息作为
suffix 原样保留，未完成的 tool exchange 不允许提交。

Episode 结束边界只提交已经 ready 的候选，不再因水位启动或等待摘要；此时没有下一次
主模型请求，真正的 85% 守门留到下一 Episode 的 pre-turn/首次模型请求前。

一次性运行提示只参与本次水位判断，不写入摘要快照；工具预算使用本轮真正会发给
Provider 的工具集合，而不是全部已注册工具。因此临时提示把上下文推过 85% 时，
仍等待同一个异步候选，不会并发再启动一份摘要。

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
