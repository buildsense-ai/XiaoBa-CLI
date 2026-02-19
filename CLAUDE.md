# XiaoBa-CLI 开发原则

## Agent 行为控制原则

所有 agent 的优化，永远只考虑优化 input context 的内容和构建方式，不对输出的行为作出任何 hard code 的 control。

具体来说：
- 不在代码层面强制截断、拦截或操控 agent 的输出行为（如强制终止循环、硬编码停止条件）
- 通过优化 system prompt、tool description、记忆召回质量、context 构建逻辑来引导 agent 做出正确判断
- 充分信任和利用大模型自身的推理能力，而不是用程序逻辑替代它的决策

## Context Window 优化方向

agent 每次推理的质量取决于 input context 的质量，优化重点：
- system prompt：清晰、无冗余、行为引导明确
- tool description：精准描述工具用途和使用时机
- 记忆召回（GauzMem recall）：控制噪音，只注入高相关度内容
- 对话历史：合理压缩，保留关键上下文

## 项目结构

- `src/core/` — 核心引擎（conversation-runner, agent-session）
- `src/feishu/` — 飞书适配层
- `src/tools/` — 工具定义和实现
- `src/skills/` — skill 解析和激活
- `skills/` — skill 定义文件（SKILL.md + 数据）
- `prompts/` — system prompt 模块化模板
- `tests/` — 测试
