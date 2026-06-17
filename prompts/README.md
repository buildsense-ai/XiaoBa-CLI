# CatsCo Prompts 规范

这个目录是 CatsCo 可编辑提示词的统一入口。目标是让提示词迭代、对比测试和后续工具接入尽量只改 `prompts/`，让 `src/` 保持负责拼装、结构化数据和运行时逻辑。

## 核心原则

- **文字放 prompts，逻辑放 src。** 稳定的指令、角色、风格、摘要要求、子 agent 行为模板应放在这里。
- **事实由 runtime 注入。** 当前会话、设备授权、附件引用、工具结果、计划状态、子 agent 状态等每轮变化的数据由代码生成，不写死在 prompt 文件里。
- **结构化数据留在代码。** JSON schema、权限状态、设备候选列表、工具参数等需要严格结构的内容由 TypeScript 组装，必要时只把其中稳定的说明文字抽成 prompt。
- **工具描述不等于 system prompt。** 工具的 `description` 和 `parameters` 留在对应工具定义里，只描述工具能力、参数和返回，不承担全局行为规则。
- **不要隐藏 fallback prompt。** 缺少 prompt 文件时应尽早暴露问题，不在代码里悄悄切到另一套大段系统提示词。

## 工具描述边界

工具描述会通过 provider 的 `tools` 字段进入模型请求，但它不是 system prompt。新增或修改工具时遵循：

- 工具级 `description` 只写这个工具做什么、何时适用、关键限制和返回语义。
- `parameters.*.description` 只写参数格式、单位、默认值、可选值和路径解析方式。
- 不把人格、回复风格、语气、长回复分段策略、plan/subagent 选择策略等全局行为写进工具描述。
- 不把权限兜底写成 prompt 规则；权限、设备授权、路径访问、外发目标一致性必须由 `src` 里的执行逻辑校验。
- 工具之间的选择关系可以简短说明，例如“搜文件名用 `glob`，搜内容用 `grep`”，但不要把完整工作流塞进单个工具描述。

## 当前文件结构

| 路径 | 用途 | 主要调用方 |
| --- | --- | --- |
| `system-prompt.md` | 普通主会话基础 system prompt：人格、通用原则、交流方式、工作方式。 | `PromptComposer.getBaseSystemPrompt()` |
| `runtime-context.md` | 普通主会话运行时模板：displayName、platform、date、当前目录说明。 | `PromptComposer.getRuntimeContextPrompt()` |
| `compact-system.md` | 上下文压缩专用 system prompt。要求只输出文本、禁止工具、输出 `<analysis>` 和 `<summary>`。 | `ContextCompressor.buildCompactSystemPrompt()` |
| `subagents/system.md` | 子 agent 通用运行规则。 | `SubAgentSession.buildSubAgentSystemPrompt()` |
| `subagents/roles/*.md` | 子 agent 角色一句话定义。 | `agentRoleLine()` |
| `subagents/ask-parent-*.md` | 子 agent 是否可向主 agent 提问的提示模板。 | `SubAgentSession.buildSubAgentSystemPrompt()` |
| `transient/*.md` | 每轮可丢弃的稳定注入模板，例如当前目录说明、计划状态说明、子 agent 状态说明、runner 恢复提示、编排 soft nudge。 | `TurnContextBuilder`、`ConversationRunner`、`runner-orchestration-policy` |
| `sidecars/*.md` | 非主会话的侧路模型调用 system prompt，例如群聊插嘴判断、日报生成。 | `ChimeInJudge`、`DailyReportGenerator` |

## 运行时拼装方式

普通主会话初始化时，系统提示词由两部分组成：

```text
prompts/system-prompt.md

prompts/runtime-context.md 渲染后的内容
```

渲染变量由 `PromptComposer` 提供：

- `{{displayName}}`：当前平台展示名。
- `{{platform}}`：当前平台。
- `{{date}}`：当前日期。

模板支持两种语法：

```text
{{name}}

{{#name}}
只有 name 有值时才保留这一段。
{{/name}}
```

读取和渲染由 `src/utils/prompt-template.ts` 负责。该模块会统一去掉行尾空白、合并过多空行，并 trim 文本。

## 生效粒度

- 主会话的 `system-prompt.md` 和 `runtime-context.md` 在会话初始化时读取并注入第一条 system 消息。改完这两个文件后，需要重启进程并开启新会话，或清空/重置当前会话，才会让已经初始化的会话用上新版本。
- 恢复历史时不会长期保存旧 system prompt；持久化历史会过滤 system 消息，重启后恢复的会话会重新读取当前 prompt 文件。
- `transient/`、`compact-system.md`、`subagents/`、`sidecars/` 多数是在每次对应调用时读取。改完文件后，下一次触发对应注入、压缩、子 agent 或 sidecar 调用就会使用新文本。
- 开发目录和当前打包形态会从应用目录下的 `prompts/` 读取。安装版虽然也能读随包带上的文件，但不建议把安装目录当作用户自定义配置目录；后续如果要支持用户自定义 prompt，应单独提供受控的外部 promptsDir。

## 动态注入怎么处理

动态注入分三类，不要一股脑全部搬进 prompt 文件。

### 1. 应该抽到 prompts 的内容

满足以下条件时，优先抽到 `prompts/`：

- 是稳定的自然语言规则。
- 改文字不需要改 TypeScript 类型或数据结构。
- 对模型行为有长期影响，值得做版本对比。
- 不是用户界面文案，也不是工具参数 schema。

例子：

- 子 agent 的角色说明。
- 上下文压缩的摘要要求。
- 普通主会话的人格和工作方式。
- 某类 transient context 的稳定说明文字。
- runner 恢复提示、计划/子 agent 状态的解释文字、编排 soft nudge。
- 侧路模型调用的 system prompt，例如插嘴判断和日报生成。

固定注入也属于这一类：如果一段 system 消息每次内容都相同，或只是把少量变量填进固定句式，就应该优先抽到 `prompts/`。代码只保留“什么时候注入、变量从哪里来、结构怎么拼”的逻辑。

### 2. 暂时留在 src 的内容

满足以下条件时，保留在代码里：

- 每轮都会根据会话、设备、附件、权限变化。
- 是 JSON、数组、schema、ID、时间戳、候选列表等结构化事实。
- 需要和类型、权限判断、工具路由保持强一致。

例子：

- `[transient_runtime_context]` 的 JSON snapshot。
- 当前设备授权、附件 ref、候选设备列表。
- plan steps、subagent 状态列表。
- runner 根据实际错误生成的变量内容。

如果其中有稳定自然语言规则，只抽规则或模板；结构化事实本身仍由代码生成。例如 `prompts/transient/plan-status.md` 负责说明“这是临时计划状态”，但具体步骤列表仍由 `PlanRuntime` 生成。

### 3. 不属于 prompts 的内容

- 工具 `description`、参数说明、返回说明：留在 `src/tools/*`。
- 用户界面文案：留在 dashboard/electron/web 相关代码或前端资源。
- 日志、错误码、告警文案：留在对应运行时或运维模块。
- provider 请求体转换：留在 `src/providers/*`。
- 消息平台 surface 行为（最终回复如何发出、文件如何外发、权限如何确认）由 runner、channel 和工具执行层保证；不要再为 Feishu/CatsCo/Weixin 维护平台专属大段 system prompt。

## 新增 prompt 的命名规范

- 文件名使用小写 kebab-case，例如 `runtime-context.md`、`tool-recovery-hint.md`。
- 按场景分目录，例如：
  - `subagents/`
  - `compact-system.md`
  - `transient/`
  - `sidecars/`
- 一个文件只负责一个明确场景，不混合多个互不相关的规则。
- 模板变量要少而清晰，变量名使用 camelCase，例如 `{{displayName}}`、`{{customInstructions}}`。
- `transient/` 文件必须搭配稳定 prefix 使用，例如 `[transient_runner_hint]`、`[transient_plan_status]`。prefix 留在代码里，便于上下文裁剪和过滤。
- `sidecars/` 只放独立模型调用的 system prompt，不放主会话规则。

## 修改 prompt 的测试要求

改动 prompt 或 prompt 拼装逻辑后，至少运行：

```powershell
npm.cmd run build
node --import tsx --test tests/prompt-composer.test.ts tests/context-compressor.test.ts tests/runtime-characterization.test.ts
npm.cmd run release:check
git diff --check
```

改到 subagent、turn context、tool loop 时，再补跑：

```powershell
npm.cmd run test:runtime
```

改到 `transient/` 模板时，至少补跑相关定向测试：

```powershell
node --import tsx --test tests/runtime-context-builder.test.ts tests/runner-orchestration-policy.test.ts tests/conversation-runner-transcript-normalization.test.ts tests/subagent-runtime-events.test.ts
```

## 打包要求

Electron 打包必须包含 `prompts/**/*`。当前 `package.json` 的 electron-builder `build.files` 已包含：

```json
"prompts/**/*"
```

`npm.cmd run release:check` 会检查：

- `build.files` 是否包含 `prompts/**/*`。
- `system-prompt.md`、`runtime-context.md`、`compact-system.md`、`subagents/system.md` 是否存在。
- 当前代码直接读取的 `transient/`、`sidecars/` 模板是否存在。

## 安全和内容约束

- 不写真实 secret、API key、service token。
- 不写服务器真实 IP、数据库密码、内网地址。
- 不写个人本机绝对路径，除非只是测试 fixture。
- 不把用户隐私文件内容、图片 base64、聊天原文样本放进 prompt 文件。
- 尽量避免过度长篇规则；长规则会挤占模型上下文，也会降低后续调试可控性。

## 后续可观测性建议

为了方便评估 prompt 效果，后续可以在每次模型请求日志里记录：

- `prompt_files`：本轮加载了哪些 prompt 文件。
- `prompt_hash`：最终 system prompt 的 hash。
- `prompt_version`：可选的人工版本号。
- `model` / `provider` / `context_window`：用于对比同一 prompt 在不同模型上的表现。

这样后面做 A/B 测试或回溯用户反馈时，可以知道“这次回复到底用的是哪版提示词”。
