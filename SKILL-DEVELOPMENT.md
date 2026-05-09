# Skill 开发指南

**版本**: 1.0
**更新**: 2026-03-07

---

## 什么是 Skill

Skill 是 CatsCo 的扩展模块，用于提供专业能力。

**特点**:
- Markdown 定义，零代码
- 热加载支持
- 自包含（可带辅助脚本）

---

## Skill 结构

```
skills/my-skill/
├── SKILL.md          # 必需：定义 + prompt
├── helper.py         # 可选：辅助脚本
├── deploy.sh         # 可选：部署脚本
└── README.md         # 可选：说明文档
```

---

## SKILL.md 格式

### 基本格式

```markdown
---
name: my-skill
description: 简短描述
version: 1.0.0
---

你是一个专业的 [角色]。

## 工作流程

1. 第一步
2. 第二步
3. 第三步

## 可用工具

- read: 读取文件
- bash: 执行命令

## 示例

用户: "帮我做 X"
你: [如何响应]
```

### Frontmatter 字段

| 字段 | 必需 | 说明 |
|------|------|------|
| `name` | ✅ | Skill 名称（小写，连字符） |
| `description` | ✅ | 简短描述 |
| `version` | ✅ | 版本号 |
| `userInvocable` | ❌ | 是否允许用户调用（默认 true） |

---

## 开发步骤

### 1. 创建目录

```bash
mkdir skills/my-skill
cd skills/my-skill
```

### 2. 编写 SKILL.md

```markdown
---
name: my-skill
description: 我的自定义 Skill
version: 1.0.0
---

你是一个专业的 [角色]，负责 [任务]。

## 工作流程

1. 理解用户需求
2. 执行具体操作
3. 返回结果

## 注意事项

- 注意点 1
- 注意点 2
```

### 3. 测试 Skill

```bash
# 启动 runtime
node dist/index.js chat

# 激活 skill
> 使用 my-skill

# 或直接调用
> skill my-skill
```

### 4. 热加载

修改 SKILL.md 后：

```bash
# AI 调用
> skill reload

# 新版本立即生效
```

---

## 使用辅助脚本

### 添加脚本

```bash
# skills/my-skill/helper.sh
#!/bin/bash
echo "Hello from helper"
```

### 在 SKILL.md 中说明

```markdown
---
name: my-skill
description: 带脚本的 Skill
---

你是一个专业的助手。

## 可用脚本

本 skill 包含以下辅助脚本：

- `helper.sh`: 执行辅助任务
  - 用法: `bash skills/my-skill/helper.sh`
  - 输出: 处理结果

## 工作流程

1. 当用户请求 X 时
2. 调用 `bash skills/my-skill/helper.sh`
3. 解析输出并返回
```

### 重要原则

**脚本不会自动注册为工具**，必须通过 `bash` 工具调用：

```
AI 想执行脚本
  ↓
调用 bash 工具
  ↓
bash skills/my-skill/helper.sh
```

---

## 最佳实践

### 1. Prompt 设计

**清晰的角色定义**:
```markdown
你是一个专业的论文分析师，擅长提取关键信息和评估研究质量。
```

**明确的工作流程**:
```markdown
## 工作流程

1. 读取论文文件
2. 分析结构和内容
3. 生成结构化报告
```

**具体的示例**:
```markdown
## 示例

用户: "分析这篇论文"
你:
1. 调用 read 读取文件
2. 分析摘要、方法、结果
3. 返回结构化分析
```

### 2. 工具使用

**列出可用工具**:
```markdown
## 可用工具

- read: 读取文件内容
- write: 写入分析报告
- bash: 执行辅助脚本
```

**说明使用场景**:
```markdown
- 需要读取文件时，使用 read 工具
- 需要生成报告时，使用 write 工具
- 需要复杂处理时，调用 bash 执行脚本
```

### 3. 错误处理

```markdown
## 错误处理

- 文件不存在: 提示用户提供正确路径
- 脚本执行失败: 检查日志并报告错误
- 格式不支持: 说明支持的格式
```

---

## 示例 Skill

### 简单 Skill (无脚本)

```markdown
---
name: code-reviewer
description: 代码审查助手
version: 1.0.0
---

你是一个专业的代码审查员。

## 工作流程

1. 使用 read 读取代码文件
2. 检查代码质量、安全性、性能
3. 返回审查报告

## 审查要点

- 代码风格
- 潜在 bug
- 安全漏洞
- 性能问题

## 输出格式

**审查结果**:
- ✅ 通过项
- ⚠️ 警告项
- ❌ 问题项
```

### 复杂 Skill (带脚本)

```markdown
---
name: deploy-agent
description: Agent 部署管理
version: 1.0.0
---

你是 Agent 部署专家。

## 可用脚本

- `scripts/check-ssh.sh <host>`: 检查 SSH 连接
- `scripts/deploy.sh <host> <runtime>`: 部署 runtime

## 工作流程

1. 询问部署目标（服务器、runtime）
2. 调用 check-ssh.sh 验证连接
3. 调用 deploy.sh 执行部署
4. 验证部署结果

## 示例

用户: "部署到 server1"
你:
1. `bash skills/deploy-agent/scripts/check-ssh.sh server1`
2. 确认连接成功
3. `bash skills/deploy-agent/scripts/deploy.sh server1 catsco`
4. 报告部署状态
```

---

## 调试技巧

### 查看日志

```bash
tail -f logs/$(date +%Y-%m-%d)/*.log
```

### 测试脚本

```bash
# 直接测试脚本
bash skills/my-skill/helper.sh

# 检查返回值
echo $?
```

### 验证 Skill 加载

```bash
# 启动后检查日志
grep "已加载.*skills" logs/$(date +%Y-%m-%d)/*.log
```

---

## 常见问题

### Q: Skill 修改后未生效？

A: 调用 `skill reload` 热加载

### Q: 脚本无法执行？

A: 检查：
1. 脚本是否有执行权限 (`chmod +x`)
2. 路径是否正确
3. 依赖是否安装

### Q: Skill 未被加载？

A: 检查：
1. SKILL.md 格式是否正确
2. frontmatter 是否完整
3. 文件名是否为 SKILL.md

---

## 发布 Skill

### 1. 测试完整性

```bash
# 测试所有功能
# 测试错误处理
# 测试边界情况
```

### 2. 编写文档

创建 README.md：
```markdown
# My Skill

## 功能

...

## 使用方法

...

## 依赖

...
```

### 3. 提交 PR

```bash
git checkout -b feat/my-skill
git add skills/my-skill/
git commit -m "feat: add my-skill"
git push origin feat/my-skill
```

---

**文档版本**: 1.0
**最后更新**: 2026-03-07
