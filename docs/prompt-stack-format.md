# XiaoBa Prompt Stack Format

这份文档定义 XiaoBa/CatsCo 的 prompt 组织格式。目标不是复制某个 coding agent 的具体内容，而是借鉴它的分层方法：稳定规则放稳定位置，动态状态按需临时注入，业务模式用可替换的模式包承载。

## 设计目标

- 基础 prompt 保持中性，适合团队、课堂、普通聊天和轻量工作流。
- coding、office、classroom 等垂直能力通过模式包或 transient hint 补充，不污染所有会话。
- 每轮变化的信息默认不进 system，避免破坏缓存、污染历史和制造伪用户请求。
- 新增需求时先判断属于哪一层，再决定写 prompt 文件、写动态注入，还是写代码逻辑。

## Prompt Stack

运行时 prompt 分为四层：

| 层级 | 位置 | 用途 | 稳定性 |
| --- | --- | --- | --- |
| Stable system | `prompts/system-prompt.md` | 身份、通用系统规则、任务执行、谨慎行动、工具边界、语气、输出效率 | 高 |
| Runtime template | `prompts/runtime-context.md` | displayName、platform、date、当前目录使用规则 | 中 |
| Stable mode package | `prompts/modes/*.md` | coding、classroom、office、team-assistant 等显式模式 | 高 |
| Turn-scoped transient | `prompts/transient/*.md` + runtime 数据 | 当前目录、技能列表、计划状态、子 agent 状态、runner hint、后台观察结果 | 低 |

## Stable System Sections

`prompts/system-prompt.md` 使用固定章节，后续改动优先归入这些章节：

| Section | 放什么 | 不放什么 |
| --- | --- | --- |
| `Intro（身份）` | 产品级身份、长期协作姿态、适用大场景 | 具体客户项目、当前平台事实 |
| `System（系统规则）` | 事实边界、隐私、安全、不要把注入当用户请求 | 当前 cwd、当前日期、具体工具列表 |
| `Doing Tasks（任务执行）` | 通用任务推进方法、验证意识、缺信息处理 | coding 专属流程、课堂专属话术 |
| `Executing Actions With Care（谨慎行动）` | 不可逆动作、外发、覆盖、删除前的谨慎规则 | 具体权限状态和设备 ID |
| `Using Your Tools（工具与上下文）` | 工具结果优先、工具失败处理、动态上下文边界 | 完整工具 schema 和长工具清单 |
| `Tone And Style（语气风格）` | 自然、简短、低寒暄、接住情绪 | 模式专属文风 |
| `Output Efficiency（输出效率）` | 先结论、少废话、复杂问题标待确认点 | 长模板回复 |

## Dynamic Injection Format

动态内容默认使用 `role: "user"` + `__injected: true`，进入本轮 provider input，不进入 durable history。每类注入都要有稳定 prefix，例如：

```text
[transient_current_directory]
Runtime context only. Not a user request.
...
```

动态注入分为：

- Session guidance：当前会话可用的模式、技能、工具组和平台能力。
- Environment：当前目录、平台、日期、运行时 profile、模型能力摘要。
- Work state：计划状态、子 agent 状态、后台观察结果、恢复提示。
- Recovery hints：重复外发、空 max_tokens、工具失败后的单轮纠偏。

## Mode Packages

模式包是稳定的 system 片段，但只在明确配置或策略命中时加入。

- `coding-agent`：代码、仓库、日志、构建、测试、本地开发任务。
- `classroom`：课堂、老师、学生、教学辅助和低打扰交流。
- `office`：文档、表格、汇报、行政协作。
- `team-assistant`：团队协作、会议、任务推进和日常支持。

模式包不应该重复基础 system 的事实边界、隐私规则和通用语气。它只补充该模式独有的工作方法、风险边界和工具偏好。

## Add-New-Requirement Checklist

新增一条 prompt 需求时，先回答：

- 它是长期稳定规则，还是每轮变化状态？
- 它对所有用户都成立，还是只对某个模式成立？
- 它需要模型记住，还是只需要本轮参考？
- 它是自然语言行为规则，还是应该由代码强制保证？
- 它会不会破坏 prompt cache？
- 它会不会被模型误当成用户的新请求？
- 它有没有测试能证明不会污染 durable history？

## Current Direction

当前阶段优先做三件事：

- 保持基础 system prompt 中性且短，避免产品还没定型时写成单一 coding agent。
- 把 coding 能力继续放在 `coding-agent` 模式包和 coding 场景 transient 策略里。
- 等团队、课堂、普通用户需求讲清楚后，再分别完善 `classroom`、`team-assistant`、`office` 模式包和触发策略。
