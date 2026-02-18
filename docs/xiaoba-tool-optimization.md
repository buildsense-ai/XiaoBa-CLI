# XiaoBa 工具层优化方案

## 背景

对比 Claude Code 的工具编排，XiaoBa 的架构骨架（skill 系统、subagent、熔断、上下文压缩）已经很扎实，但在工具层面有几个低成本高回报的改进空间。

XiaoBa 的定位不是 CLI 开发工具，而是一个"有手有脚的 AI 同事"——自身具备文件操作和代码能力，但核心价值在于理解需求、协调资源、交付成果。将来会接入 A2A 平台，通过与其他 AI 协作完成自身不擅长的任务。因此优化不照搬 Claude Code，只取对 XiaoBa 有价值的部分。

## 改动范围

### 1. 丰富基础工具的 description（prompt 层）

现状：工具描述只有一句话（如 `execute_shell`: "使用系统默认 shell 执行命令"），模型缺乏使用策略指引。

改动：针对容易用错的基础工具，在 description 中补充使用策略、常见陷阱、与其他工具的关系。不是所有工具都改，只改以下几个：

| 工具 | 补充内容 |
|------|----------|
| `execute_shell` | 不要用 bash 做文件读写（用 read_file/write_file）；多个独立命令可并行调用；用绝对路径避免 cd 问题 |
| `read_file` | 修改文件前必须先读；大文件用 offset/limit 分段读 |
| `edit_file` | 必须先 read_file 再 edit；old_string 不唯一时提供更多上下文；保持原文缩进 |
| `grep` | 搜索文件内容优先用 grep 而非 bash grep/rg；说明与 glob 的区别（grep 搜内容，glob 搜文件名） |
| `glob` | 搜索文件名/路径用 glob 而非 bash find/ls |
| `write_file` | 优先 edit_file 修改现有文件，只在创建新文件时用 write_file |

不改的工具：`feishu_reply`、`feishu_send_file`、`skill`、`spawn_subagent` 等 — 这些已经够清晰，或者由 skill prompt 指引。

### 2. edit_file 加"先读后改"校验（代码层）

现状：模型可以不读文件就直接 edit，容易导致 old_string 匹配失败或改错位置。

改动：在 `EditTool.execute()` 中追踪已读文件列表，如果目标文件没被 read_file 读过，返回提示要求先读。

实现方式：ToolManager 维护一个 `readFiles: Set<string>`，ReadTool 执行成功后记录路径，EditTool 执行前检查。

### 3. Bash 持久化 shell session（代码层）

现状：每次 `execute_shell` 都是独立子进程，环境变量、cd 状态不保留。连续操作同一个项目时效率低。

改动：用 `child_process.spawn` 创建持久 shell 进程，通过 stdin/stdout 交互，支持状态保持。超时自动回收。

### 4. 工具结果截断策略（代码层）

现状：shell 输出 maxBuffer 10MB，但返回给模型的内容没有截断，大输出会浪费 token 甚至撑爆上下文。

改动：工具结果超过 30000 字符时自动截断，保留头尾各 12000 字符，中间用 `[...已省略 N 字符...]` 替代。在 ConversationRunner 或 ToolManager 层统一处理，所有工具受益。

### 5. 可选：dev skill prompt（prompt 层）

现状：system prompt 保持"研究生助手"人设，不适合塞入大量 coding 最佳实践。

改动：创建一个 `dev` skill，当用户需要写代码、改项目时激活，注入 coding 场景的工具使用原则（先读后改、搜索优先用 grep/glob、并行调用独立操作等）。平时聊天、读论文时不加载，不影响泛化能力和表达体验。

## 不做的事

- 不改 system prompt 的人设和调性
- 不把 XiaoBa 往 CLI 开发工具方向改
- 不过度添加 coding 指引到主 prompt（放 skill 里）
