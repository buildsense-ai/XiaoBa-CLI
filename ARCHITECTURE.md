# CatsCo 架构文档

**版本**: 1.0
**更新**: 2026-03-07

---

## 概览

CatsCo 是一个可扩展的 AI Agent Runtime，采用三层架构设计。

```
┌─────────────────────────────────────┐
│         AI Agent Runtime            │
├─────────────────────────────────────┤
│  Skill 层 (扩展层)                   │
│  - 8 个 skills                      │
│  - SKILL.md 定义                    │
│  - 热加载支持                        │
├─────────────────────────────────────┤
│  Tool 层 (基础层)                    │
│  - 9 个核心工具                      │
│  - TypeScript 实现                  │
│  - 权限控制                          │
└─────────────────────────────────────┘
```

---

## 核心组件

### 1. Tool 层 (ToolManager)

**职责**: 注册和管理基础工具

**注册的工具** (9个):
- `read` - 读取文件
- `write` - 写入文件
- `edit` - 编辑文件
- `glob` - 文件搜索
- `grep` - 内容搜索
- `bash` - 命令执行
- `skill` - 调用 skill
- `send_file` - 发送文件
- `thinking` - 内部推理（用户不可见）

**代码位置**: `src/tools/`

**工作流程**:
```
ToolManager.registerTool()
  ↓
转换为 JSON Schema
  ↓
注入 AI Provider
  ↓
AI 调用工具
  ↓
ToolManager.execute()
```

---

### 2. Skill 层

**职责**: 提供专业能力模块

**Skill 结构**:
```
skills/my-skill/
├── SKILL.md          # 必需：定义 + prompt
├── *.py / *.sh       # 可选：辅助脚本
└── *.md              # 可选：说明文档
```

**SKILL.md 格式**:
```markdown
---
name: my-skill
description: 描述
version: 1.0.0
---

你是一个专业的...
[prompt 内容]
```

**热加载**:
```bash
# AI 调用
skill reload

# 返回
{"__reload_skills__": true, "message": "已重新加载 N 个 skills"}
```

**代码位置**: `skills/`, `src/skills/skill-manager.ts`

---

### 3. 运行模式

#### Message Mode (消息模式)
- AI 文本输出自动转发给用户
- 使用 `thinking` 工具进行内部推理
- 适合 IM 平台集成

#### Ultra Mode (超级模式)
- AI 必须调用 `reply` 工具发送消息
- 使用 `pause_turn` 结束回合
- 更精确的控制

**切换**:
```bash
GAUZ_MESSAGE_MODE=message  # 或 ultra
```

---

## 数据流

### 用户消息处理
```
用户消息
  ↓
SessionManager
  ↓
AgentSession
  ↓
ConversationRunner
  ↓
AI Provider (Claude/GPT)
  ↓
工具调用
  ↓
ToolManager.execute()
  ↓
返回结果
  ↓
AI 生成回复
  ↓
自动转发 (message mode) / reply 工具 (ultra mode)
```

### Skill 激活
```
用户: "使用 paper-analysis"
  ↓
AI 调用 skill 工具
  ↓
SkillManager.getSkill()
  ↓
返回激活信号
  ↓
ConversationRunner 注入 skill prompt
  ↓
AI 进入 skill 模式
```

---

## 关键设计

### 1. 工具与 Skill 的关系

**工具 (Tool)**:
- TypeScript 实现
- 注册到 ToolManager
- 直接暴露给 AI

**Skill**:
- Markdown 定义
- 通过 `skill` 工具激活
- 可包含辅助脚本（通过 bash 工具调用）

**示例**:
```
AI 想执行 deploy-agent skill 中的脚本
  ↓
调用 skill 工具激活 deploy-agent
  ↓
Skill prompt 指导 AI
  ↓
AI 调用 bash 工具执行 scripts/deploy.sh
```

### 2. 脚本执行

**原则**: 所有脚本通过 bash 工具执行

```
Skill 的 .py/.sh 文件
  ↓
不注册为独立工具
  ↓
Skill prompt 指导 AI 如何调用
  ↓
AI 使用 bash 工具执行
```

### 3. 热加载机制

```typescript
// agent-session.ts
const needReloadSkills = this.messages.slice(-10).some(msg => {
  if (msg.role === 'tool') {
    const parsed = JSON.parse(msg.content);
    return parsed.__reload_skills__ === true;
  }
});

if (needReloadSkills) {
  await this.services.skillManager.loadSkills();
}
```

---

## 扩展指南

### 添加新工具

1. 创建 `src/tools/my-tool.ts`:
```typescript
export class MyTool implements Tool {
  definition: ToolDefinition = {
    name: 'my_tool',
    description: '...',
    parameters: { ... }
  };

  async execute(args: any): Promise<string> {
    // 实现
  }
}
```

2. 注册到 ToolManager:
```typescript
// src/tools/tool-manager.ts
this.registerTool(new MyTool());
```

### 添加新 Skill

1. 创建目录:
```bash
mkdir skills/my-skill
```

2. 创建 SKILL.md:
```markdown
---
name: my-skill
description: 我的 skill
---

你是一个专业的...
```

3. 可选：添加脚本
```bash
# skills/my-skill/helper.sh
echo "helper script"
```

4. 在 SKILL.md 中说明如何使用脚本

---

## 配置

### 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `GAUZ_MESSAGE_MODE` | 运行模式 | `ultra` |
| `GAUZ_LLM_PROVIDER` | LLM 提供商 | - |
| `GAUZ_LLM_MODEL` | 模型名称 | - |
| `GAUZ_LLM_API_KEY` | API Key | - |

### 工具白名单

```bash
GAUZ_TOOL_ALLOW=read,write,bash,skill
```

---

## 部署

### 本地运行
```bash
npm run build
node dist/index.js chat
```

### IM 平台
```bash
# 飞书
node dist/index.js feishu

# CatsCompany
node dist/index.js catscompany
```

### Docker
```bash
docker compose up -d
```

---

## 故障排查

### Skill 未加载
```bash
# 检查 SKILL.md 格式
# 调用 skill reload
```

### 工具调用失败
```bash
# 检查日志
tail -f logs/$(date +%Y-%m-%d)/*.log

# 检查工具白名单
echo $GAUZ_TOOL_ALLOW
```

---

**文档版本**: 1.0
**最后更新**: 2026-03-07
