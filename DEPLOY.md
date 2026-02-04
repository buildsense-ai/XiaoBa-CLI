# XiaoBa 部署文档

## 快速开始

### 1. 克隆项目

```bash
git clone https://github.com/your-username/XiaoBa.git
cd XiaoBa
```

### 2. 安装依赖

```bash
npm install
```

### 3. 配置环境变量

复制环境变量模板文件：

```bash
cp .env.example .env
```

编辑 `.env` 文件，填入你的配置：

```env
# LLM 提供商配置
GAUZ_LLM_PROVIDER=openai
GAUZ_LLM_API_BASE=https://api.openai.com/v1/chat/completions
GAUZ_LLM_API_KEY=your-api-key-here
GAUZ_LLM_MODEL=gpt-3.5-turbo
```

**支持的 API 提供商：**
- OpenAI: `https://api.openai.com/v1/chat/completions`
- DeepSeek: `https://api.deepseek.com/v1/chat/completions`
- 其他兼容 OpenAI API 的服务

### 4. 构建项目

```bash
npm run build
```

### 5. 全局安装

#### Windows（需要管理员权限）

**方法一：npm link（推荐）**

以管理员身份打开 PowerShell：

```powershell
npm link
```

**方法二：全局安装**

```powershell
npm install -g .
```

#### Linux / macOS

```bash
sudo npm link
# 或
sudo npm install -g .
```

### 6. 验证安装

```bash
xiaoba --version
```

如果显示版本号，说明安装成功！

## 使用方法

### 首次配置

运行配置命令，设置 API 密钥等信息：

```bash
xiaoba config
```

配置文件将保存在 `~/.xiaoba/config.json`（Windows 为 `C:\Users\YourName\.xiaoba\config.json`）

### 开始对话

**交互式模式（推荐）：**

```bash
xiaoba
# 或
xiaoba chat -i
```

**单条消息模式：**

```bash
xiaoba chat -m "你好，介绍一下你自己"
```

**退出交互模式：**

在交互模式中输入 `exit` 或 `quit`

## 开发模式

### 开发调试

```bash
npm run dev
```

### 监听文件变化

```bash
npm run watch
```

### 重新构建

```bash
npm run build
```

## 配置说明

### 环境变量配置（.env）

| 变量名 | 说明 | 默认值 | 是否必需 |
|--------|------|--------|----------|
| `GAUZ_LLM_API_BASE` | API 端点地址 | - | 是 |
| `GAUZ_LLM_API_KEY` | API 密钥 | - | 是 |
| `GAUZ_LLM_MODEL` | 模型名称 | gpt-3.5-turbo | 是 |
| `GAUZ_LLM_PROVIDER` | 提供商标识 | openai | 否 |
| `GAUZ_MEM_ENABLED` | 是否启用记忆系统 | false | 否 |
| `GAUZ_MEM_BASE_URL` | 记忆系统地址 | - | 否 |
| `GAUZ_MEM_PROJECT_ID` | 项目ID | - | 否 |
| `GAUZ_MEM_USER_ID` | 用户ID | - | 否 |
| `GAUZ_MEM_AGENT_ID` | 代理ID | - | 否 |

### 运行时配置（~/.xiaoba/config.json）

可以通过 `xiaoba config` 命令修改，也可以手动编辑：

```json
{
  "apiUrl": "https://api.openai.com/v1/chat/completions",
  "apiKey": "your-api-key",
  "model": "gpt-3.5-turbo",
  "temperature": 0.7
}
```

## 常见问题

### Q: Windows 下 npm link 报权限错误

**A:** 需要以管理员身份运行 PowerShell：

1. 按 `Win + X`，选择"Windows PowerShell (管理员)"
2. 进入项目目录：`cd e:\项目代码\XiaoBa`
3. 运行：`npm link`

### Q: 提示 "API密钥未配置"

**A:** 需要先运行配置命令：

```bash
xiaoba config
```

输入你的 API 密钥和其他配置信息。

### Q: 如何更换 API 提供商？

**A:** 修改 `.env` 文件中的 `GAUZ_LLM_API_BASE` 和 `GAUZ_LLM_MODEL`，或运行 `xiaoba config` 重新配置。

### Q: 如何卸载？

**A:** 

```bash
npm unlink xiaoba-cli
# 或
npm uninstall -g xiaoba-cli
```

### Q: 构建后无法运行

**A:** 检查 `dist/index.js` 文件是否存在，以及文件首行是否有 `#!/usr/bin/env node`。

## 更新升级

### 拉取最新代码

```bash
git pull origin main
npm install
npm run build
```

如果是全局安装的，需要重新链接：

```bash
npm link
```

## 项目结构

```
XiaoBa/
├── src/                    # 源代码
│   ├── commands/          # 命令处理
│   │   ├── chat.ts       # 对话命令
│   │   └── config.ts     # 配置命令
│   ├── theme/            # 主题配色
│   │   └── colors.ts     # 黑金配色
│   ├── types/            # 类型定义
│   │   └── index.ts      
│   ├── utils/            # 工具函数
│   │   ├── ai-service.ts # AI服务封装
│   │   ├── config.ts     # 配置管理
│   │   └── logger.ts     # 日志输出
│   └── index.ts          # CLI入口
├── dist/                  # 构建输出
├── skills/               # Skill 技能（规划中）
├── prompts/              # 提示词（规划中）
├── tools/                # 工具集（规划中）
├── .env                  # 环境变量（不提交）
├── .env.example          # 环境变量模板
├── .gitignore           # Git忽略文件
├── package.json         # 项目配置
├── tsconfig.json        # TypeScript配置
├── README.md            # 项目说明
└── DEPLOY.md            # 部署文档（本文件）
```

## 技术栈

- **语言：** TypeScript
- **运行时：** Node.js >= 18.0.0
- **CLI框架：** Commander.js
- **交互界面：** Inquirer.js
- **样式：** Chalk（黑金配色主题）
- **HTTP客户端：** Axios

## 贡献指南

欢迎提交 Issue 和 Pull Request！

1. Fork 本项目
2. 创建你的特性分支 (`git checkout -b feature/AmazingFeature`)
3. 提交你的改动 (`git commit -m 'Add some AmazingFeature'`)
4. 推送到分支 (`git push origin feature/AmazingFeature`)
5. 开启一个 Pull Request

## 许可证

MIT License

## 联系方式

如有问题，欢迎提交 Issue 或通过以下方式联系：

- GitHub: [your-github-username]
- Email: [your-email]

---

**祝你使用愉快！** 🎉
