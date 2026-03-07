<div align="center">

```
██╗  ██╗██╗ █████╗  ██████╗ ██████╗  █████╗
╚██╗██╔╝██║██╔══██╗██╔═══██╗██╔══██╗██╔══██╗
 ╚███╔╝ ██║███████║██║   ██║██████╔╝███████║
 ██╔██╗ ██║██╔══██║██║   ██║██╔══██╗██╔══██╗
██╔╝ ██╗██║██║  ██║╚██████╔╝██████╔╝██║  ██║
╚═╝  ╚═╝╚═╝╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚═╝  ╚═╝
```

**Your AI. Your Rules. Your Terminal.**

An extensible AI Agent Runtime that runs in your terminal,</br>
connects to your IM platforms, and bends to your will.

[![Node](https://img.shields.io/badge/node-%3E%3D18-black?style=for-the-badge&logo=nodedotjs&logoColor=%23f0db4f&labelColor=0a0a0a)](https://nodejs.org)
[![TS](https://img.shields.io/badge/typescript-5.3-black?style=for-the-badge&logo=typescript&logoColor=%233178c6&labelColor=0a0a0a)](https://typescriptlang.org)
[![MIT](https://img.shields.io/badge/license-MIT-black?style=for-the-badge&labelColor=0a0a0a&color=f5c542)](./LICENSE)

<br/>

---

**8 Skills** · **9 Core Tools** · **Hot-Reload** · **Multi-LLM** · **IM Integration**

[Quick Start](#-quick-start) · [Architecture](#-architecture) · [Skills](#-skills) · [Configuration](#%EF%B8%8F-configuration) · [Documentation](#-documentation)

</div>

<br/>

## ⚡ Quick Start

```bash
git clone https://github.com/buildsense-ai/XiaoBa-CLI.git
cd XiaoBa-CLI
npm install
cp .env.example .env   # 填入你的 API Key
npm run build
```

```bash
# 交互模式
node dist/index.js chat

# 飞书 Bot
node dist/index.js feishu

# CatsCompany Bot
node dist/index.js catscompany
```

<br/>

## 🏗️ Architecture

XiaoBa-CLI 采用三层架构设计：

```
┌─────────────────────────────────────┐
│         AI Agent Runtime            │
├─────────────────────────────────────┤
│  Skill 层 (扩展层)                   │
│  - 8 个 skills                      │
│  - Markdown 定义                    │
│  - 热加载支持                        │
├─────────────────────────────────────┤
│  Tool 层 (基础层)                    │
│  - 9 个核心工具                      │
│  - TypeScript 实现                  │
│  - 权限控制                          │
└─────────────────────────────────────┘
```

### Core Tools (9)

| Tool | 功能 |
|------|------|
| `read` | 读取文件 |
| `write` | 写入文件 |
| `edit` | 编辑文件 |
| `glob` | 文件搜索 (支持 glob 模式) |
| `grep` | 内容搜索 (正则表达式) |
| `bash` | 命令执行 |
| `skill` | 调用 skill (支持 `skill reload` 热加载) |
| `send_file` | 发送文件 |
| `thinking` / `reply` | 消息工具 (根据模式) |

### Skills (11)

可插拔的专业能力模块，Markdown 定义，零代码扩展。

| Skill | 功能 |
|-------|------|
| `sub-agent` | 后台子任务执行 |
| `academic-search` | 学术论文搜索 |
| `image-analysis` | 图片分析 OCR |
| `feishu-collab` | 飞书群协作 |
| `multi-agent` | 多智能体协作 |
| `context-recall` | 上下文回忆 |
| `task-planning` | 任务规划拆分 |
| `web-research` | 网络研究 |
| `deploy-agent` | Agent 部署 |
| `agent-browser` | 浏览器自动化 |
| `devops-manager` | DevOps 管理 |

<br/>

## 🔥 Features

### 🔄 Hot Reload

修改 skill 无需重启：

```bash
# AI 调用
skill reload

# 新 skill 立即生效
```

### 🎯 Two Modes

**Message Mode** (推荐 IM 平台):
- AI 文本输出自动转发
- 使用 `thinking` 工具内部推理
- 自然对话体验

**Ultra Mode** (精确控制):
- AI 必须调用 `reply` 工具
- 使用 `pause_turn` 结束回合
- 完全可控

```bash
GAUZ_MESSAGE_MODE=message  # 或 ultra
```

### 🔗 Multi-LLM Support

支持任何 OpenAI 兼容 API：
- Claude (Anthropic)
- GPT (OpenAI)
- DeepSeek
- 自定义 Provider

### 📱 IM Integration

- **飞书 (Lark)** - WebSocket 长连接
- **CatsCompany** - 自定义 IM

<br/>

## 🎯 Skills

### 创建自定义 Skill

1. 创建目录和文件：
```bash
mkdir skills/my-skill
```

2. 创建 `skills/my-skill/SKILL.md`：
```markdown
---
name: my-skill
description: 我的自定义 Skill
version: 1.0.0
---

你是一个专业的...
[在这里写 prompt]
```

3. 可选：添加辅助脚本
```bash
# skills/my-skill/helper.sh
echo "helper script"
```

4. 在 SKILL.md 中说明如何使用脚本

5. 热加载生效：
```bash
# AI 调用
skill reload
```

**注意**: 脚本通过 `bash` 工具执行，不会自动注册为独立工具。

<br/>

## ⚙️ Configuration

复制 `.env.example` → `.env`：

```bash
# LLM 配置
GAUZ_LLM_PROVIDER=anthropic
GAUZ_LLM_MODEL=claude-opus-4-6
GAUZ_LLM_API_KEY=your-key

# 运行模式
GAUZ_MESSAGE_MODE=message

# 工具白名单 (可选)
GAUZ_TOOL_ALLOW=read,write,bash,skill

# 飞书 Bot (可选)
FEISHU_APP_ID=your-app-id
FEISHU_APP_SECRET=your-secret
```

<br/>

## 📚 Documentation

- [ARCHITECTURE.md](./ARCHITECTURE.md) - 架构设计详解
- [SKILL-DEVELOPMENT.md](./SKILL-DEVELOPMENT.md) - Skill 开发指南 (即将推出)

<br/>

## 🤝 Contributing

```bash
fork → git checkout -b feat/xxx → commit → push → PR
```

欢迎贡献 Issue、PR、Skill、Tool。

<br/>

## 📄 License

[MIT](./LICENSE)

---

<div align="center">

**如果觉得有用，点个 ⭐ 就是最大的支持。**

Built with 🖤 by **CatCompany**

</div>
