<div align="center">
  <img src="assets/banner.png" alt="XiaoBa Banner" width="100%">

  # 🐱 XiaoBa - 世界上最拟人的 AI Agent

  **不是工具，是伙伴 | 像人一样思考和交流的智能助手**

  [![Release](https://img.shields.io/github/v/release/buildsense-ai/XiaoBa-CLI)](https://github.com/buildsense-ai/XiaoBa-CLI/releases)
  [![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
  [![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)](https://github.com/buildsense-ai/XiaoBa-CLI)

  [快速开始](#-快速开始) • [功能特性](#-功能特性) • [下载安装](#-下载安装) • [文档](#-文档)
</div>

---

## 💡 什么是 XiaoBa？

XiaoBa 不是传统的 AI 助手，它是一个**真正拟人化的 Agent**。

- 🗣️ **像人一样交流** - 不用表格、进度条、Markdown 格式，就像在微信上聊天
- 🧠 **像人一样思考** - 遇到问题会自己想办法解决，不会动不动就问你
- 🤝 **像人一样工作** - 交代任务就去做，做完了告诉你结果，不啰嗦
- 💭 **有情感感知** - 能理解你的情绪，在你沮丧时给予支持

**传统 AI：**
```
用户：帮我读一下这篇论文
AI：好的！我将为您执行以下步骤：
1. ✅ 下载论文
2. ⏳ 分析内容
3. ⏳ 生成摘要
...
```

**XiaoBa：**
```
用户：帮我读一下这篇论文
小八：好的老师，我先看看。
（默默工作...）
小八：读完了，这篇主要讲...
```

---

## ✨ 功能特性

### 🖥️ 桌面应用
- **跨平台支持** - Windows、macOS、Linux 全平台覆盖
- **Electron 打包** - 原生体验，开箱即用
- **可视化 Dashboard** - 一键启停服务，实时查看日志

### 🤖 多平台机器人
- **飞书机器人** - 企业协作，团队共享
- **微信机器人** - 个人助手，随时随地
- **Cats Company** - 社区平台接入

### 🔌 强大的 Skill 系统
- **可扩展架构** - 通过 Skill 插件无限扩展能力
- **官方 Skill Hub** - 社区共享，一键安装
- **自定义 Skill** - 支持 Python/TypeScript 编写专属技能

### 🎯 智能交互
- **拟人化对话** - 自然流畅，不像机器人
- **情感感知** - 理解你的情绪状态
- **主动解决问题** - 遇到错误会自己想办法，不轻易求助
- **群聊社交** - 懂得什么时候该说话，什么时候该沉默

### 💾 智能会话管理
- **持久化存储** - JSONL 格式，每条消息独立一行，永不丢失
- **自动归档** - 会话结束自动归档，保持工作区整洁
- **完整日志** - 记录每轮对话的用户输入、AI 回复、工具调用、Token 消耗
- **按日期分类** - 自动按日期和会话类型组织日志，方便追溯
- **数据分析** - 支持日报生成、Skill 提取、行为分析

---

## 🚀 快速开始

### Windows 用户
1. 下载 [XiaoBa Setup 0.1.0.exe](https://github.com/buildsense-ai/XiaoBa-CLI/releases/latest)
2. 双击安装
3. 启动应用，配置 API Key
4. 在 Dashboard 中启动所需的机器人服务

### macOS 用户
1. 下载 [XiaoBa-0.1.0-arm64.dmg](https://github.com/buildsense-ai/XiaoBa-CLI/releases/latest)
2. 双击安装
3. 启动应用，配置 API Key
4. 在 Dashboard 中启动所需的机器人服务

### 配置说明
复制 `.env.example` 为 `.env`，填入你的配置：
```bash
# LLM 配置
GAUZ_LLM_PROVIDER=anthropic
GAUZ_LLM_API_KEY=your_api_key

# 飞书机器人（可选）
FEISHU_APP_ID=your_app_id
FEISHU_APP_SECRET=your_app_secret

# 微信机器人（可选）
WEIXIN_TOKEN=your_token
```

---

## 🛠️ 开发

```bash
# 安装依赖
npm install

# 开发模式
npm run electron:dev

# 构建
npm run electron:build:win   # Windows
npm run electron:build:mac   # macOS
npm run electron:build:linux # Linux
```

---

## 📚 文档

- [Skill 开发指南](https://github.com/buildsense-ai/XiaoBa-Skill-Hub)
- [API 文档](docs/API.md)
- [配置说明](docs/CONFIG.md)

---

## 🏪 Skill Hub

访问 [XiaoBa-Skill-Hub](https://github.com/buildsense-ai/XiaoBa-Skill-Hub) 获取更多社区 Skills。

---

## 📄 License

Apache-2.0 © CatCompany

---

<div align="center">
  Made with ❤️ by CatCompany
</div>
