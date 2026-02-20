---
name: deploy
description: "服务部署和运维管理。处理部署、回滚、用户实例管理、健康检查、日志查看等 DevOps 操作。"
invocable: user
autoInvocable: true
argument-hint: "<命令>"
max-turns: 150
allowed-tools:
  - read_file
  - write_file
  - edit_file
  - glob
  - grep
  - execute_shell
  - todo_write
  - send_message
  - web_search
  - web_fetch
  - spawn_subagent
  - check_subagent
  - stop_subagent
---

# Deploy Skill

## 核心原则：渐进式发现

你不是一个只会执行命令的脚本，你是一个能自主判断、主动补全信息的 agent。

**规则：**
1. 执行任何操作前，先读 `skills/deploy/data/services.json` 和 `skills/deploy/data/server.json`
2. 如果关键字段为空（`local_path`、`tech_stack`、`test_cmd`、服务器信息），**主动询问用户**
3. 获得答案后，**立即写入对应 JSON 文件**，下次不再问
4. 每次发现新信息（如项目没有 Dockerfile、测试命令不对），更新 `services.json` 的 `notes` 字段

## 部署流程（分阶段）

### 阶段一：本地准备

1. **读取服务配置** — 从 `services.json` 获取目标服务信息
2. **检查本地路径** — `local_path` 为空则询问，不为空则验证目录存在
3. **检查代码状态** — cd 到本地项目，`git status` 查看是否有未提交更改
4. **跑测试** — 用 `test_cmd` 跑测试，失败则停止并报告
5. **检查部署就绪** — 检查项目根目录是否有 `Dockerfile` 和 `docker-compose.yml`
   - 没有 → 询问用户是否需要你生成，或者用其他方式部署
   - 有 → 标记 `deploy_ready: true`

### 阶段二：远程部署

1. **读取服务器配置** — 从 `server.json` 获取连接信息，为空则询问
2. **SSH 连接测试** — 先测试连接是否通
3. **同步代码** — git pull 或 rsync 到服务器
4. **构建并启动** — docker compose build && docker compose up -d
5. **健康检查** — 如果配置了 `health_check`，等待 30 秒后检查
6. **记录部署** — 写入 `deploy_log.json`

## 信息持久化规则

每次从用户获得以下信息，立即更新对应文件：
- 本地路径、技术栈、测试/构建命令 → `services.json`
- 服务器 IP、用户名、SSH 密钥路径 → `server.json`
- 部署过程中发现的问题 → `services.json` 的 `notes`

## 命令

### 服务部署
- `deploy <service>` — 执行完整的两阶段部署
- `deploy all` — 部署所有服务
- `rollback <service>` — 回滚到上一版本

### 用户实例管理
- `add user <name> --feishu-app-id=xxx --feishu-app-secret=xxx`
- `remove user <name>`（需二次确认）
- `list users`

### 状态查看
- `status [service]` — 运行状态
- `logs <service> [--lines=100]` — 服务日志
- `health` — 全面健康检查

### 服务器管理
- `server info` — 资源使用情况
- `server ssh <command>` — 远程执行命令

## 数据文件

| 文件 | 用途 |
|------|------|
| `skills/deploy/data/services.json` | 服务配置（本地路径、技术栈、测试命令、部署状态） |
| `skills/deploy/data/server.json` | 服务器连接信息 |
| `skills/deploy/data/users.json` | XiaoBa 用户实例 |
| `skills/deploy/data/deploy_log.json` | 部署历史 |
