# XiaoBa 主 Agent Continuation Checkpoint 压缩链路

## 目标

本链路解决两类问题：

1. 单个长任务在同一个 episode 内持续调用工具，接近上下文上限后仍能继续执行。
2. 已有会话、云端历史或中断后的会话重新载入时，模型能区分“已经确认的事实”和“必须重新验证的运行状态”。

实现采用 Codex 风格的 continuation checkpoint 模式，但不声称复制任何未公开内部实现。核心原则是：

```text
保留原始记录
→ 在稳定边界生成可续跑检查点
→ 持久化检查点
→ 重新注入当前运行环境
→ 继续同一任务
```

旧 `ContextWindowManager`、`ContextCompressor` 和机械裁剪代码暂时保留，用于回滚和最后兜底。新旧语义压缩不会在同一次运行中同时生效。

## 唯一开关

```text
XIAOBA_CHECKPOINT_COMPACTION_ENABLED
```

- 未设置或不为 `false`：使用新检查点链路。
- 设置为 `false`：恢复旧 `ContextWindowManager` / `ContextCompressor` 链路。

Branch Agent 和 Subagent 暂不接入新 coordinator，行为保持不变。

## 数据分层

### 耐久上下文

会进入检查点并可保存到 Session：

- 主 system prompt；
- 用户消息；
- assistant 消息；
- 工具调用和完整工具结果；
- 之前生成的 continuation checkpoint；
- episode 标识和远端上下文水位。

### 临时运行上下文

不会写进摘要事实，检查点后按当前状态重新生成：

- `[transient_runtime_context]`；
- 当前设备、target route 和本地文件授权；
- runtime feedback；
- synthetic observation；
- 本轮 runner hint。

这可以避免旧设备状态、旧路径授权或已断开的 route 被摘要固化成长期事实。

## 三个触发阶段

### 1. `pre_turn`

发生位置：主 Agent 开始处理一条新的外部用户消息之前。

```mermaid
flowchart LR
  A["读取本地 Session"] --> B["计算耐久消息 + 工具 schema token"]
  B --> C{"超过 80%?"}
  C -- "否" --> G["正常构建本轮上下文"]
  C -- "是" --> D["生成 continuation checkpoint"]
  D --> E["持久化检查点"]
  E --> G
  G --> H["注入最新 runtime context"]
  H --> I["加入本轮用户输入"]
  I --> J["启动同一主 Agent"]
```

作用：

- 压缩已经落盘的旧历史；
- 当前新用户输入不会被摘要吞掉；
- 新输入始终位于检查点和最近历史之后。

### 2. `mid_turn`

发生位置：同一个 episode 中，一批工具调用全部返回之后、下一次模型请求之前。

```mermaid
flowchart LR
  A["模型发出一批 tool calls"] --> B["等待全部工具结果完整返回"]
  B --> C["将 assistant/tool 交换加入当前 transcript"]
  C --> D{"超过 80%?"}
  D -- "否" --> I["合并忙时新用户输入"]
  D -- "是" --> E["生成 continuation checkpoint"]
  E --> F["原子替换当前内存上下文"]
  F --> G["立即持久化检查点"]
  G --> H["重建当前 runtime context"]
  H --> I
  I --> J["使用同一 episodeId 继续请求模型"]
```

稳定边界要求：

- 不在工具执行中途压缩；
- 不把尚未返回的工具调用写成成功；
- 检查点完成并保存后才继续下一次模型请求；
- 忙时到达的新用户消息在检查点之后加入，仍属于当前 episode。

### 3. `restore`

发生位置：

- 本地 Session 恢复后；
- 群聊历史补入后；
- CatsCompany 云端可见历史首次恢复并准备落盘时。

```mermaid
flowchart LR
  A["读取本地或云端可见历史"] --> B["规范化消息顺序与身份"]
  B --> C{"历史是否需要压缩?"}
  C -- "否" --> G["保存或继续使用"]
  C -- "是" --> D["生成 restore checkpoint"]
  D --> E["标记临时运行状态必须复验"]
  E --> F["持久化有界上下文"]
  F --> G
  G --> H["新请求到达时注入当前 runtime context"]
```

Restore checkpoint 会明确把以下内容标为 `unknown until reverified`：

- 进程是否仍在运行；
- 端口是否仍在监听；
- 文件是否仍存在；
- 设备和 WebSocket 是否在线；
- 凭证、网络和工具执行状态是否仍有效；
- 中断前未完成的工具调用是否成功。

## 阈值

### 主 Agent

```text
耐久消息估算 token + 当前工具 schema token
> prompt budget × 80%
```

才会触发检查点。

### 云端历史恢复

云端历史超过直接落盘预算后进入准备流程。新 coordinator 使用：

```text
max context = 90K
threshold = 65%
```

现有云端恢复入口只在历史超过约 60K 时调用该流程，因此实际触发点保持在既有范围附近。

## 检查点内容

摘要 prompt 要求保留：

- 用户原始目标和最新补充要求；
- 用户明确禁止事项和约束；
- 已完成、正在做、待做步骤；
- 已确认的决定和失败方案；
- 精确路径、端口、URL、ID、commit、PR、文件和命令；
- 每项关键工具结果和最近稳定工具边界；
- 当前错误、阻塞及下一步；
- 必须重新验证的临时状态；
- artifact/source reference。

禁止：

- 输出模型思维链；
- 猜测缺失事实；
- 把未完成工具调用写成成功；
- 静默丢弃用户约束；
- 将旧 runtime context 当成当前事实。

## 压缩后的消息顺序

```text
稳定 system prompt
→ checkpoint boundary
→ continuation summary
→ 最近保留的原始 user/assistant 消息
→ 新生成的 transient runtime context
→ 当前或后续用户输入
```

这样旧历史由 summary 承接，最近原文保持自然对话顺序，真正的新用户输入仍是最后的任务指令。

`mid_turn` 永远优先保留当前 episode 的首条 root 用户请求，再按预算尽量保留同一 episode 后续到达的用户补充。短消息“继续”不能挤掉 root。

保留预算随上下文增长：默认取上下文预算的 15%，最少 8K、最多 32K token。单条输入超过预算时不会无声消失，而会保留带原文长度、SHA-256、头尾内容和重新读取提示的证据胶囊。

`pre_turn` / `restore` 保留最近普通 user/assistant 原文，最多 8 条，使用同一动态 token 预算。

## 超大工具结果

检查点不能因为一个超大工具结果而无法生成。

处理方式：

1. 原始 `Message` 不修改。
2. 只在发送给摘要模型的副本中，将超过 24,000 字符的工具结果转换为证据代理。
3. 证据代理保留：
   - tool name；
   - tool call id；
   - 原字符数；
   - SHA-256；
   - 头部 16,000 字符；
   - 尾部 4,000 字符；
   - 重新运行或重读来源的指令。
4. 摘要生成失败时，原始 transcript 原样返回给后续兜底。

已有 `read_file` / `execute_shell` 历史折叠仍可把完整结果保存为 `tool-result://...` 产物。检查点链路不依赖这两种工具的私有格式。

## 重复压缩

旧 checkpoint 不会被永久原样堆叠。

下一次触发时：

```text
旧 checkpoint summary
+ 新增消息
→ 生成一份新的 checkpoint summary
```

旧 boundary 被移除，旧 summary 作为证据重新摘要。远端上下文水位继续带入新 checkpoint，避免恢复后重复拉取。

## 断线、进程重启与恢复

短暂 WebSocket 重连本身不触发压缩。

如果进程或 Session 被重新建立：

1. 加载最近一次已持久化的 checkpoint；
2. 按 `restore` 语义处理过大的恢复历史；
3. 不假定中断前进程、端口、网络和工具状态仍有效；
4. 在新请求开始时重新注入当前 runtime context；
5. 从 checkpoint 的稳定边界继续，必要时重新执行验证工具。

`mid_turn` 检查点在继续模型调用前持久化，因此即使随后断开，恢复时也不会只剩最早的 user input 和最后一条可见回复。

## 失败与兜底

### 摘要模型失败

```text
checkpoint 失败
→ 不替换原 transcript
→ 不推进检查点状态
→ ConversationRunner 继续原链路
→ provider 请求前的历史工具折叠和机械预算裁剪作为最后兜底
```

### 检查点持久化失败

```text
checkpoint 已生成但落盘失败
→ 不替换当前内存 transcript
→ 不继续使用这份未持久化 checkpoint
→ 保留原 transcript
→ 继续走既有 provider 预算兜底
```

中途压缩必须先成功写入 Session，才会替换内存上下文并继续下一次模型请求。

### 云端恢复摘要失败

保持现有有界机械 fallback，保存最近可用历史，避免每次启动都重复恢复失败。

### 回滚

设置：

```text
XIAOBA_CHECKPOINT_COMPACTION_ENABLED=false
```

即可恢复旧语义压缩链路。新代码不删除旧 compressor、旧 prompt 或旧测试。

## 与旧裁剪的关系

新链路启用时：

- 当前 episode 的工具结果不再提前折叠，优先让 checkpoint 摘要读取完整结果；
- 历史 `read_file` / `execute_shell` 折叠仍保留；
- provider 请求前的 prompt budget guard 仍保留；
- hard trim 只作为 checkpoint 失败或异常超限时的最后防线；
- Runner 内旧 AI compressor 不重新启用。

这不是两套摘要串联，而是：

```text
新 checkpoint = 主语义压缩
旧机械裁剪 = 最后安全阀
旧 AI compressor = 开关回滚路线
```

## 256K 场景验收

`tests/checkpoint-compaction-256k-scenario.test.ts` 使用正式 token 预算算法和
`CheckpointCompactionCoordinator`，对 `pre_turn`、`mid_turn`、`restore`
三条链路进行可重复的 256K 场景验收。

采用 Relay 常用的 `32,768` 最大输出配置时：

```text
模型上下文窗口：256,000
安全保留：52,224
Prompt 预算：203,776
压缩触发线：超过 163,020（Prompt 预算的 80%）
```

本次确定性测试使用约 4K token 的检查点，并模拟 8K tool schema：

| 场景 | 压缩前 durable + tools | 压缩后 messages + tools | 压缩后占 Prompt 预算 |
| --- | ---: | ---: | ---: |
| 新回合前历史压缩 | 164,039 | 24,152 | 11.9% |
| 同一 episode 工具后续跑 | 169,069 | 23,166 | 11.4% |
| 云端/中断历史恢复 | 168,033 | 28,636 | 14.1% |

这些数字是固定输入下的验收结果，不是生产环境必须达到的硬比例。实际压缩后大小取决于：

- bundled system prompt；
- 当前工具 schema；
- 检查点模型输出长度；
- 8K–32K token 的动态近期原文保留；
- 当前 runtime context。

当前实现保证 `80%` 触发，但不强行把结果裁到某个固定百分比，避免为了追求数字再次丢失任务事实。真实模型长任务测试仍用于验证检查点内容质量。

## 真实运行审计

普通运行日志会记录：

- `phase`；
- 压缩前后 token 和消息数；
- checkpoint summary 字符数与 SHA-256；
- 保留的 root、pending 和超长输入证据数量。

普通日志不重复写入完整 checkpoint 正文，避免泄露和日志膨胀。完整语义质量从两处检查：

1. 当前 Session JSONL 中 `__checkpointSummary: true` 的持久消息；
2. 开启 Prompt Trace 后，检查下一次真实模型请求收到的 checkpoint、近期原文和新 runtime context。

测试机可使用：

```powershell
$env:XIAOBA_PROMPT_TRACE="1"
$env:XIAOBA_PROMPT_TRACE_CONTENT="1"
$env:XIAOBA_PROMPT_TRACE_MESSAGE_CHARS="24000"
```

建议先在一台测试机启用新链路，另一台保持旧链路作为对照。真实验收至少覆盖：

1. 预先写入精确端口、路径、ID 和禁止事项；
2. 运行足够长的工具任务触发 `mid_turn`；
3. 触发后继续执行并询问精确事实；
4. 重启进程后发送“继续”，确认从已持久 checkpoint 恢复；
5. 对照 Session JSONL、Prompt Trace 和最终行为，而不只看是否出现“压缩成功”日志。

## 后续删除旧代码的条件

旧链路只有在以下条件都满足后才能删除：

1. 主 Agent 定向测试和完整测试持续通过；
2. 本地长 episode 真实测试能在检查点后继续调用工具；
3. 忙时输入不会被拆成错误的新 episode；
4. 中断/重启能从持久 checkpoint 恢复；
5. 云端大历史恢复正常；
6. 检查点失败时机械兜底可用；
7. 至少一个发布周期内未依赖回滚开关；
8. 观察日志确认不存在重复 checkpoint、频繁压缩或 runtime 状态污染。

满足后可单独提交清理 PR，删除：

- 主 Agent 对旧 `ContextWindowManager` 的运行依赖；
- 云端恢复对旧 `ContextCompressor` 的运行依赖；
- 对应旧摘要 prompt 和只服务旧链路的测试。

机械 prompt budget guard、工具结果 artifact 和 Session 原始日志不应随之删除。
