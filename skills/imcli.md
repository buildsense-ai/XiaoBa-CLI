# IMCLI - 多 Agent 协作平台

通过 IMCLI 实现跨 CLI 工具的实时 Agent 协作。

## 核心概念

- **Hub**: WebSocket 服务器 (ws://localhost:3000)
- **Workspace**: 协作空间，类似聊天群组
- **Role**: Agent 角色标识（如 pm-1, backend-1, frontend-1）

## 命令行工具

IMCLI 提供命令行客户端，通过 `execute_shell` 调用。

### 1. 发送消息给特定 Agent

```bash
node path/to/imcli-client.js send --hub ws://localhost:3000 --workspace default --from your-role --to target-role --message "消息内容"
```

**示例**：PM 分配任务给后端
```bash
node imcli-client.js send --hub ws://localhost:3000 --workspace myproject --from pm-1 --to backend-1 --message "请实现用户注册API，包含邮箱验证和密码加密"
```

### 2. 广播消息给所有 Agent

```bash
node path/to/imcli-client.js broadcast --hub ws://localhost:3000 --workspace default --from your-role --message "广播内容"
```

**示例**：通知所有成员
```bash
node imcli-client.js broadcast --hub ws://localhost:3000 --workspace myproject --from pm-1 --message "第一阶段开发启动，请各自开始任务"
```

### 3. 查询在线 Agent 列表

```bash
node path/to/imcli-client.js list --hub ws://localhost:3000 --workspace default
```

返回 JSON 格式的成员列表。

## 协作模式

### PM 协调多人开发

1. **查看团队**：`list` 查看在线成员
2. **分配任务**：
   - `send --to backend-1 --message "实现用户注册API"`
   - `send --to frontend-1 --message "开发登录页面"`
   - `send --to qa-1 --message "准备测试用例"`
3. **同步进度**：`broadcast --message "今日任务已分配"`

### 开发者协作

收到任务后完成开发，然后通知相关方：
```bash
send --to pm-1 --message "用户注册API已完成: server.js"
send --to qa-1 --message "可以开始测试了"
```

### 跨角色协作

- **后端 → 前端**：API 接口文档
- **前端 → QA**：页面开发完成通知
- **QA → DevOps**：测试通过，请求部署
- **DevOps → 全员**：部署完成广播

## 使用建议

1. **明确角色**：使用清晰的角色名（pm-1, backend-1, frontend-1）
2. **任务具体**：消息包含明确的需求和产出
3. **及时反馈**：完成任务后立即通知相关方
4. **善用广播**：重要通知用 broadcast
