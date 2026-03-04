<div align="center">

```
██╗  ██╗██╗ █████╗  ██████╗ ██████╗  █████╗
╚██╗██╔╝██║██╔══██╗██╔═══██╗██╔══██╗██╔══██╗
 ╚███╔╝ ██║███████║██║   ██║██████╔╝███████║
 ██╔██╗ ██║██╔══██║██║   ██║██╔══██╗██╔══██║
██╔╝ ██╗██║██║  ██║╚██████╔╝██████╔╝██║  ██║
╚═╝  ╚═╝╚═╝╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚═╝  ╚═╝
```

**Your AI. Your Rules. Your Terminal.**

An extensible AI Agent framework that runs in your terminal,</br>
connects to your IM platforms, and bends to your will.

[![Node](https://img.shields.io/badge/node-%3E%3D18-black?style=for-the-badge&logo=nodedotjs&logoColor=%23f0db4f&labelColor=0a0a0a)](https://nodejs.org)
[![TS](https://img.shields.io/badge/typescript-5.3-black?style=for-the-badge&logo=typescript&logoColor=%233178c6&labelColor=0a0a0a)](https://typescriptlang.org)
[![MIT](https://img.shields.io/badge/license-MIT-black?style=for-the-badge&labelColor=0a0a0a&color=f5c542)](./LICENSE)
[![Stars](https://img.shields.io/github/stars/buildsense-ai/XiaoBa-CLI?style=for-the-badge&logo=github&logoColor=white&labelColor=0a0a0a&color=f5c542)](../../stargazers)

<br/>

<img width="680" alt="xiaoba-banner" src="./assets/banner.png"/>

---

**6 Agents** · **13 Skills** · **28+ Tools** · **Multi-LLM Failover** · **Feishu Bot**

[Quick Start](#-quick-start) · [Features](#-features) · [Scenarios](#-usage-scenarios) · [Human-likeness](#-human-likeness-engineering) · [Skills](#-skills) · [Configuration](#%EF%B8%8F-configuration) · [Contributing](#-contributing)

</div>

<br/>

## ⚡ Quick Start

```bash
git clone https://github.com/buildsense-ai/XiaoBa-CLI.git && cd XiaoBa-CLI
git submodule update --init --recursive
npm install
cp .env.example .env   # 填入你的 API Key
npm run build && npm link
```

```bash
xiaoba                              # 交互模式
xiaoba chat -m "分析一下这段代码"     # 单条消息
xiaoba feishu                       # 启动飞书 Bot
xiaoba skill list                   # 查看所有 Skills
```

<br/>

## 🔥 Features

<table>
<tr>
<td width="50%">

### 🧠 Multi-Agent System

5 种专业 Agent 协同工作，支持 spawn / resume / stop 动态调度：

- **General Purpose** — 通用推理
- **Bash** — 安全命令执行
- **Code Reviewer** — 代码审查
- **Explore** — 代码库探索
- **Plan** — 任务规划与分解

</td>
<td width="50%">

### 🔗 LLM Failover Chain

主模型挂了？自动切备用，无感切换：

```
Claude ──✗──▶ GPT ──✗──▶ DeepSeek ──▶ ...
```

- 支持无限备用模型链路
- 主模型 / 视觉模型独立 Failover
- 兼容所有 OpenAI API 格式
- 流式输出中断可选切换

</td>
</tr>
<tr>
<td>

### 🛠️ 28+ Built-in Tools

文件读写 · Glob / Grep · Bash 执行 · Web 抓取<br/>
Web 搜索 · Python 扩展 · 子 Agent 管理<br/>
飞书消息 · Todo · 计划模式 ...

工具白名单机制，按需放开，安全可控。

</td>
<td>

### 📱 IM Integration

一行命令接入 IM 平台，变身团队 AI 助手：

- **飞书 (Lark)** — WebSocket 长连接，群聊 @、文件收发、图片识别
- **CatsCompany** — 基于 CatsCompany 官方 SDK 的自定义 IM 接入

</td>
</tr>
</table>

<br/>

## 💬 Usage Scenarios

### Private Chat — Your Personal Research Assistant

In a 1-on-1 conversation, XiaoBa acts like a dedicated graduate student. Give it a task, it gets to work.

```
You:    帮我精读一下这篇论文
XiaoBa: 好的老师，我先看看。
        ... (silently reads, analyzes figures, extracts key insights) ...
        [sends structured analysis report as file]
        读完了老师，8章12张图都分析了，核心贡献在第4章，要我展开讲讲吗？
```

What makes it different from a generic chatbot:
- **Talks like a human, not a bot** — no markdown tables in chat, no "As an AI assistant", no emoji progress bars
- **Matches your rhythm** — short urgent messages get quick replies; casual chat gets a relaxed tone
- **Knows when to shut up** — you say "ok" or "thanks", it doesn't reply with "Is there anything else I can help with?"
- **Errors are human too** — instead of `TypeError: Cannot read property 'x' of undefined`, you get "Sorry, something went wrong, try again?"
- **Long tasks run in background** — delegates to sub-agents, keeps chatting with you while work happens

### Group Chat — Multi-Bot Collaboration

Deploy multiple XiaoBa instances (or mix with other bots like ErGoz) in a group chat. They collaborate like real teammates.

```
You:       @小八 把认证的bug修一下  @二狗子 改完帮忙review
XiaoBa:    好的老师，我看看。
           ... (writes code, commits to branch) ...
XiaoBa:    @ErGoz 二狗子，改好了，你看看 diff
ErGoz:     两个问题——第42行少了空值检查，错误信息泄露了内部状态。
XiaoBa:    都修了，再看看？
ErGoz:     没问题了，APPROVE。
```

The magic is in the social dynamics:
- **Chime-in judgment** — bots don't just respond when @'d. A lightweight LLM call decides "should I speak up?" based on recent context. If the topic is in their expertise, they join naturally
- **Anti-collision** — random delay (1-3s) before chiming in + check if someone else already replied. No two bots talking over each other
- **Teammate awareness** — each bot knows who else is in the group and what they're good at. "This is a code review question, ErGoz is better suited — I'll stay quiet"
- **Contextual replies** — when chiming in, bots see what was discussed recently and continue the thread naturally, not start from scratch
- **Authenticated bridge** — bot-to-bot communication via HTTP with shared secret, safe for public deployment

<br/>

## 🎭 Human-likeness Engineering

Most AI agents focus on capability. XiaoBa also focuses on **not feeling like a bot**.

| Dimension | What we do | What others do |
|-----------|-----------|----------------|
| **Conversation style** | Prompt-engineered to chat like a real person on IM — short, casual, no formatting abuse | Default LLM output with markdown headers and bullet points |
| **Emotional rhythm** | Mirrors user's pace — urgent gets concise, relaxed gets chatty | Same tone regardless of context |
| **Error handling** | Friendly message to user, technical details in logs only | Raw stack traces or generic "An error occurred" |
| **Group social norms** | Knows when NOT to speak — doesn't reply to every message | Responds to everything or nothing |
| **Multi-bot dynamics** | Chime-in judgment, anti-collision, teammate profiles | No multi-bot awareness |
| **Session continuity** | Summarizes conversations on expiry, resumes context next time | Starts fresh every session |

This isn't about adding emoji or personality quirks. It's about removing the things that make you *feel* like you're talking to a machine.

<br/>

## 🎯 Skills

可插拔的专业能力模块。Markdown 定义，零代码扩展。

| | Skill | 干什么的 |
|---|---|---|
| 📄 | `paper-analysis` | 论文深度解析 |
| ✍️ | `sci-paper-writing` | 科研论文写作 |
| 📚 | `literature-review` | 文献综述生成 |
| 🔬 | `research-orchestrator` | 科研流程编排 |
| 🧪 | `experiment-design` | 实验方案设计 |
| 🎞️ | `paper-to-ppt` | 论文 → PPT 一键转换 |
| 🔍 | `code-review` | 代码审查 |
| 📖 | `critical-reading` | 批判性阅读 |
| 📐 | `cad-supervision` | CAD 图纸审查 |
| 🎨 | `excalidraw` | Excalidraw 绘图 |
| 📕 | `xhs-vibe-write` | 小红书风格写作 |
| 🌐 | `agent-browser` | 浏览器自动化 |
| 🧬 | `self-evolution` | Agent 自我进化 |

<details>
<summary><b>自定义 Skill 只需 3 步</b></summary>

```bash
mkdir skills/my-skill
```

创建 `skills/my-skill/SKILL.md`：

```markdown
---
name: my-skill
description: 我的自定义 Skill
version: 1.0.0
tools:
  - my_tool
---

你是一个专业的 ...
```

需要工具？同目录放 `*_tool.py`，自动加载。

</details>

<br/>

## ⚙️ Configuration

复制 `.env.example` → `.env`，按需填写：

| 配置组 | 说明 |
|--------|------|
| `GAUZ_LLM_*` | 主模型 Provider / Model / API Key |
| `GAUZ_LLM_BACKUP_*` | 备用模型链路（支持多个） |
| `GAUZ_VISION_*` | 视觉模型（独立 Failover） |
| `GAUZ_TOOL_ALLOW` | 工具白名单 |
| `GAUZ_MEM_*` | 记忆系统 |
| `FEISHU_*` | 飞书 Bot 凭证 |
| `BRIDGE_SECRET` | Bot Bridge 认证密钥（多 bot 协作） |
| `MINIO_*` | 对象存储 |

<br/>

## 🏗️ Architecture

```
src/
├── agents/        6 种 Agent 实现
├── core/          会话管理 · 上下文压缩 · 子 Agent 调度
├── providers/     LLM 适配层 (Anthropic / OpenAI)
├── skills/        Skill 引擎 · 解析 · 激活协议
├── tools/         28+ 工具实现
├── commands/      CLI 入口 (chat / config / feishu / skill)
├── feishu/        飞书 WebSocket 集成
├── catscompany/   CatsCompany IM 集成
├── bridge/        进程间通信
├── theme/         黑金配色
└── utils/         日志 · 配置 · 安全 · Token 估算
skills/            Skill 定义 (Markdown + Python)
tools/             外部工具扩展
deploy/            Docker 部署配置
```

<br/>

## 🗺️ Roadmap

- [x] Multi-Agent 协作系统
- [x] 13 Skills + Skill 引擎
- [x] 28+ 内置工具
- [x] LLM Failover Chain
- [x] 飞书 Bot
- [x] Python 工具扩展
- [x] 上下文压缩 & Token 估算
- [ ] 插件市场
- [ ] 更多 IM（微信 / 钉钉）
- [ ] Web UI
- [ ] 记忆系统增强

<br/>

## 🤝 Contributing

```bash
fork → git checkout -b feat/xxx → commit → push → PR
```

欢迎任何形式的贡献 — Issue、PR、Skill、Tool 都行。

<br/>

## 📄 License

[MIT](./LICENSE)

---

<div align="center">

**如果觉得有用，点个 ⭐ 就是最大的支持。**

Built with 🖤 by **CatCompany**

</div>
