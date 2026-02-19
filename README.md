<p align="center">
  <img src="https://img.shields.io/badge/XiaoBa-AI%20Agent%20Framework-black?style=for-the-badge&labelColor=000000&color=FFD700" alt="XiaoBa" />
</p>

<h1 align="center">
  <code>小 八 / XiaoBa</code>
</h1>

<p align="center">
  <strong>🖤 Black & Gold — 一个可扩展的 AI Agent CLI 框架</strong>
</p>

<p align="center">
  <em>多模型 Failover · 多 Agent 协作 · 13 Skills · 28+ Tools · 飞书 / IM 集成</em>
</p>

<p align="center">
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-%3E%3D18-black?style=flat-square&logo=node.js&logoColor=FFD700&labelColor=000" alt="Node.js" /></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.3-black?style=flat-square&logo=typescript&logoColor=FFD700&labelColor=000" alt="TypeScript" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-black?style=flat-square&logoColor=FFD700&labelColor=000&color=FFD700" alt="MIT" /></a>
  <img src="https://img.shields.io/badge/Tools-28+-black?style=flat-square&labelColor=000&color=FFD700" alt="Tools" />
  <img src="https://img.shields.io/badge/Skills-13-black?style=flat-square&labelColor=000&color=FFD700" alt="Skills" />
</p>

---

## What is XiaoBa?

XiaoBa 是一个 **可扩展的 AI Agent 命令行框架**，不只是聊天机器人。

它拥有完整的 Agent 系统、Skill 系统、Tool 系统，支持多 LLM 提供商自动 Failover，可以作为 CLI 工具使用，也可以一键接入飞书等 IM 平台成为团队 AI 助手。

```
┌─────────────────────────────────────────────────────┐
│                    XiaoBa CLI                       │
│                                                     │
│  ┌───────────┐  ┌───────────┐  ┌───────────┐       │
│  │  Agents   │  │  Skills   │  │   Tools   │       │
│  │  ×6 types │  │  ×13      │  │   ×28+    │       │
│  └─────┬─────┘  └─────┬─────┘  └─────┬─────┘       │
│        └───────────────┼───────────────┘             │
│                        ▼                             │
│  ┌─────────────────────────────────────────────┐     │
│  │         LLM Provider Layer                  │     │
│  │   Anthropic ← OpenAI ← DeepSeek ← ...      │     │
│  │         (Auto Failover Chain)               │     │
│  └─────────────────────────────────────────────┘     │
│                        ▼                             │
│  ┌──────────┐  ┌──────────┐  ┌──────────────┐       │
│  │   CLI    │  │  Feishu  │  │ CatsCompany  │       │
│  │  交互模式 │  │  飞书Bot  │  │   IM Bot     │       │
│  └──────────┘  └──────────┘  └──────────────┘       │
└─────────────────────────────────────────────────────┘
```

---

## Features

### 🧠 Agent 系统

| Agent | 职责 |
|-------|------|
| **General Purpose** | 通用对话与推理 |
| **Bash** | 安全执行系统命令 |
| **Code Reviewer** | 代码审查与分析 |
| **Explore** | 代码库探索与理解 |
| **Plan** | 任务规划与分解 |

Agent 之间可以 **spawn / resume / stop**，实现多 Agent 协作。

### 🎯 Skill 系统

Skills 是可插拔的专业能力模块，通过 Markdown 定义，零代码即可扩展：

| Skill | 用途 |
|-------|------|
| `paper-analysis` | 论文深度解析 |
| `sci-paper-writing` | 科研论文写作 |
| `literature-review` | 文献综述生成 |
| `research-orchestrator` | 科研流程编排 |
| `experiment-design` | 实验方案设计 |
| `paper-to-ppt` | 论文一键转 PPT |
| `code-review` | 代码审查 |
| `critical-reading` | 批判性阅读 |
| `cad-supervision` | CAD 图纸审查 |
| `excalidraw` | Excalidraw 绘图 |
| `xhs-vibe-write` | 小红书风格写作 |
| `agent-browser` | 浏览器自动化 |
| `self-evolution` | 自我进化 |

### 🔗 LLM Failover Chain

```
主模型 (Anthropic Claude)
  ↓ 失败
备模型 1 (OpenAI GPT)
  ↓ 失败
备模型 2 (DeepSeek)
  ↓ ...
```

- 支持任意数量的备用模型链路
- 主/视觉模型独立 Failover
- 流式输出中断后可选择是否切换
- 兼容所有 OpenAI API 格式的服务

### 🛠️ 28+ 内置工具

文件读写 · Glob/Grep 搜索 · Bash 执行 · Web 抓取 · Web 搜索 · Python 扩展 · 任务规划 · 子 Agent 管理 · 飞书消息 · Todo 管理 · 计划模式 ...

### 📱 IM 平台集成

- **飞书 (Lark)** — WebSocket 长连接，支持群聊 @、文件收发、图片识别
- **CatsCompany** — 自定义 IM 平台接入

---

## Quick Start

```bash
# 克隆
git clone https://github.com/AICatCompany/XiaoBa.git
cd XiaoBa

# 安装依赖
npm install

# 配置
cp .env.example .env
# 编辑 .env，填入你的 API Key

# 构建 & 全局安装
npm run build
npm link
```

### 使用

```bash
# 交互模式
xiaoba

# 单条消息
xiaoba chat -m "帮我分析一下这段代码"

# 管理 Skills
xiaoba skill list
xiaoba skill enable paper-analysis

# 启动飞书 Bot
xiaoba feishu

# 配置
xiaoba config
```

---

## Project Structure

```
XiaoBa/
├── src/
│   ├── agents/          # Agent 系统 (6 types)
│   ├── commands/        # CLI 命令 (chat, config, feishu, skill)
│   ├── core/            # 会话管理、上下文压缩、子 Agent
│   ├── providers/       # LLM 提供商 (Anthropic, OpenAI)
│   ├── skills/          # Skill 系统引擎
│   ├── tools/           # 28+ 工具实现
│   ├── feishu/          # 飞书集成
│   ├── catscompany/     # CatsCompany 集成
│   ├── bridge/          # 进程间通信
│   ├── theme/           # 黑金配色
│   └── utils/           # 工具函数
├── skills/              # Skill 定义 (Markdown + Python)
├── tools/               # 外部工具扩展
├── prompts/             # 系统提示词
├── templates/           # 模板
└── deploy/              # 部署配置 (Docker)
```

---

## Configuration

所有配置通过 `.env` 文件管理，参考 [`.env.example`](./.env.example)：

| 配置项 | 说明 |
|--------|------|
| `GAUZ_LLM_PROVIDER` | LLM 提供商 (`anthropic` / `openai`) |
| `GAUZ_LLM_MODEL` | 主模型 |
| `GAUZ_LLM_BACKUP_*` | 备用模型链路 |
| `GAUZ_VISION_*` | 视觉模型配置 |
| `GAUZ_TOOL_ALLOW` | 工具白名单 |
| `GAUZ_MEM_*` | 记忆系统 |
| `FEISHU_*` | 飞书 Bot |
| `MINIO_*` | 对象存储 |

---

## Extending XiaoBa

### 添加 Skill

在 `skills/` 目录下创建文件夹，编写 `SKILL.md`：

```markdown
---
name: my-skill
description: 我的自定义 Skill
version: 1.0.0
tools:
  - my_tool
---

# System Prompt

你是一个专业的 ...
```

如果 Skill 需要工具，在同目录下添加 `*_tool.py`，XiaoBa 会自动加载。

### 添加工具

在 `tools/global/` 下添加 Python 工具脚本，遵循标准接口即可被自动发现。

---

## Development

```bash
npm run dev       # 开发模式 (tsx hot-reload)
npm run build     # 编译 TypeScript
npm run watch     # 监听模式
npm run test      # 运行测试
```

---

## Roadmap

- [x] 多 Agent 协作系统
- [x] Skill 系统 (13 Skills)
- [x] 28+ 内置工具
- [x] LLM Failover Chain
- [x] 飞书 Bot 集成
- [x] Python 工具扩展
- [x] 上下文压缩 & Token 估算
- [ ] 插件市场
- [ ] 更多 IM 平台 (微信、钉钉)
- [ ] Web UI
- [ ] 记忆系统增强

---

## Contributing

欢迎贡献！请查看 [Issues](../../issues) 或提交 PR。

1. Fork 本仓库
2. 创建特性分支 (`git checkout -b feature/amazing-feature`)
3. 提交更改 (`git commit -m 'feat: add amazing feature'`)
4. 推送分支 (`git push origin feature/amazing-feature`)
5. 提交 Pull Request

---

## License

[MIT](./LICENSE) — 自由使用，保留署名即可。

---

<p align="center">
  <strong>⭐ 如果这个项目对你有帮助，请给个 Star！</strong>
</p>

<p align="center">
  <sub>Built with 🖤 & ✨ by CatCompany</sub>
</p>
