# XiaoBa AI 助手 🤖

> 一个采用黑金配色的智能命令行 AI 对话助手

[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3.3-blue.svg)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## 特性

- 🎨 **精美界面** - 黑金配色主题，优雅的命令行体验
- 💬 **智能对话** - 支持上下文连续对话
- 🔌 **灵活配置** - 支持多种 AI API 提供商（OpenAI、DeepSeek 等）
- ⚡ **快速启动** - 输入 `xiaoba` 即可开始对话
- 🛠️ **易于扩展** - 模块化设计，易于添加新功能

## 快速开始

### 安装

```bash
# 克隆项目
git clone https://github.com/your-username/XiaoBa.git
cd XiaoBa

# 安装依赖
npm install

# 配置环境变量
cp .env.example .env
# 编辑 .env 文件，填入你的 API 密钥

# 构建并全局安装
npm run build
npm link  # Windows 需要管理员权限
```

### 配置

```bash
xiaoba config
```

### 使用

```bash
# 开始对话（交互模式）
xiaoba

# 发送单条消息
xiaoba chat -m "你好"
```

## 截图

```
    ╔═══════════════════════════════════╗
    ║                                   ║
    ║         XiaoBa AI 助手            ║
    ║                                   ║
    ║      您的智能命令行伙伴           ║
    ║                                   ║
    ╚═══════════════════════════════════╝

你: 你好

XiaoBa: 你好！我是 XiaoBa，很高兴为你服务...
```

## 支持的 API 提供商

- ✅ OpenAI (GPT-3.5, GPT-4)
- ✅ DeepSeek
- ✅ 任何兼容 OpenAI API 格式的服务

## 详细文档

- [部署文档](./DEPLOY.md) - 详细的安装、配置和使用指南
- [常见问题](./DEPLOY.md#常见问题) - 遇到问题？先看这里

## 项目结构

```
XiaoBa/
├── src/                    # 源代码
│   ├── commands/          # 命令处理（chat, config）
│   ├── theme/            # 黑金配色主题
│   ├── types/            # TypeScript 类型定义
│   ├── utils/            # 工具函数
│   └── index.ts          # CLI 入口
├── skills/               # Skill 技能（规划中）
├── prompts/              # 提示词库（规划中）
├── tools/                # 工具集（规划中）
└── dist/                 # 构建输出
```

## 技术栈

- **语言：** TypeScript
- **运行时：** Node.js >= 18.0.0
- **CLI 框架：** Commander.js
- **交互界面：** Inquirer.js
- **样式：** Chalk（黑金配色）
- **HTTP 客户端：** Axios

## 开发

```bash
npm run dev       # 开发模式（使用 tsx）
npm run build     # 构建项目
npm run watch     # 监听模式
```

## 路线图

- [x] 基础对话功能
- [x] 配置管理
- [x] 黑金配色主题
- [ ] Skill 系统集成
- [ ] 工具调用能力
- [ ] 文件系统操作
- [ ] 记忆系统完善
- [ ] 插件系统

## 贡献

欢迎提交 Issue 和 Pull Request！

## 许可证

[MIT](./LICENSE)

## 致谢

灵感来源于 Claude Code / Cursor AI 助手。

---

**星标支持** ⭐ 如果这个项目对你有帮助，请给个 Star！
