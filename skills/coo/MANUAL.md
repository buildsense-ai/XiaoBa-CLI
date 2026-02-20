# COO 操作手册

> 本文件是 COO 的详细操作参考。COO 可根据实际需要修改本文件，每次修改需在修改处注明原因。
> 使命定义在 system prompt 中，不在此文件范围内。

## 数据文件

所有数据存储在 `skills/coo/data/` 目录下。以下是初始结构，**可根据实际需要扩展字段或新增文件**：

| 文件 | 用途 |
|------|------|
| `task_pool.json` | 任务/事项记录 |
| `members.json` | 成员信息（人类 + agent） |
| `reminders.json` | 提醒/定时触发调度表 |
| `member_logs/` | 按 member 分文件的进度日志 |
| `daily_log/YYYY-MM-DD.md` | 每日摘要 |

## 激活方式

### 1. Reactive（被动）

CEO 或 agent 发消息触发：
- 直接命令（`propose`、`status`、`update` 等）
- 自由文本汇报（COO 解析后更新记录）
- agent 主动推送进度（双向信息流，不只是 COO 去拉）

收到输入时，除了处理当前请求，还要**扫描上下文**：这条信息是否意味着某个相关事项需要跟进？

### 2. Proactive（主动）

由 `reminders.json` 驱动，框架层 scheduler 定期检查到期 reminder，激活 COO 执行对应动作。

reminder 数据结构：

```json
{
  "id": "R-001",
  "type": "task_check | daily_summary | conflict_escalation | custom",
  "description": "检查记忆模块重构进度",
  "target_task": "T-003",
  "trigger_at": "2026-02-18T09:00:00",
  "repeat": "once | daily | weekly | every_N_hours",
  "repeat_interval_hours": null,
  "action": "检查 T-003 进度，如果超过2天没更新就通过 send_message 问 hanyuan",
  "created": "2026-02-16",
  "last_triggered": null,
  "active": true
}
```

**COO 在以下时机应自动创建 reminder：**
- 新任务设了 due date → 创建到期前 1 天的提醒
- 任务标记 in_progress → 创建 2 天后的进度检查
- 有人说"我过两天搞完" → 创建对应时间的跟进提醒
- 每日摘要 → 默认 daily repeat
- 方向冲突/优先级矛盾/模糊决策点 → 创建晨会前触发的 reminder，上浮给人决策

**注意：定时扫描器是框架层能力。COO skill 只负责读写 reminders.json，不负责调度本身。**

## 成员数据结构（members.json）

成员分为 human 和 agent 两类，通过 `type` 字段区分。

### 人类成员字段

```json
{
  "name": "hanyuan",
  "type": "human",
  "role": "CEO",
  "status": "active",
  "joined": "2026-02-18",
  "channel": "feishu",
  "strengths": ["架构设计", "产品方向"],
  "work_rhythm": "晚上效率高",
  "notes": "COO的观察笔记，持续积累"
}
```

### Agent 成员字段

```json
{
  "name": "deploy-agent",
  "type": "agent",
  "role": "云端部署Agent",
  "status": "active | building | deploying | offline",
  "joined": "2026-02-19",
  "related_task": "T-005",
  "invoke_method": "调用方式描述",
  "has_memory": false,
  "capabilities": ["能力1", "能力2"],
  "reliability": "未评估 | 低 | 中 | 高",
  "notes": "COO的观察笔记，持续积累"
}
```

**reliability 评估标准**：基于历史交互，考察任务完成率、是否需要人工干预、输出质量稳定性。COO 在每次与 agent 相关的交互后更新。

## member_logs 日志格式

存储位置：`skills/coo/data/member_logs/{member_name}.md`

每条日志追加写入，格式：

```markdown
## YYYY-MM-DD HH:MM

- **来源**：自主汇报 | COO巡视 | CEO转述
- **关联任务**：T-XXX
- **内容**：具体进展或状态描述
```

COO 在以下时机写入 member_logs：
- 收到成员的进度汇报时
- 巡视中发现状态变化时
- CEO 转述某成员情况时

## 任务数据结构（初始模板，可演化）

`task_pool.json` 中每个任务的初始字段：

```json
{
  "id": "T-001",
  "title": "任务标题",
  "description": "详细描述",
  "owner": "hanyuan",
  "status": "proposed | todo | in_progress | blocked | in_review | done | cancelled",
  "priority": "critical | high | medium | low",
  "depends_on": ["T-000"],
  "blocks": ["T-002"],
  "proposed_by": "hanyuan",
  "tags": ["memory", "core"],
  "created": "2026-02-16",
  "updated": "2026-02-16",
  "due": "2026-02-20",
  "notes": "最新进展备注"
}
```

## 交互命令

### 任务管理

| 命令 | 说明 |
|------|------|
| `propose <描述>` | 提交新任务到任务池（状态为 proposed，等待确认优先级） |
| `pickup <task_id>` | 认领任务，状态变为 in_progress |
| `update <task_id> <内容>` | 更新任务进度或备注 |
| `done <task_id>` | 标记任务完成 |
| `block <task_id> <原因>` | 标记任务阻塞，记录原因 |
| `cancel <task_id> <原因>` | 取消任务 |
| `reprioritize <task_id> <priority>` | 调整优先级 |

### 信息查询

| 命令 | 说明 |
|------|------|
| `status` | 全局进度摘要 |
| `status <member>` | 某人的任务清单和进度 |
| `board` | 看板视图 |
| `blockers` | 列出所有阻塞项和阻塞链 |
| `overdue` | 列出所有超期任务 |

### 汇报与规划

| 命令 | 说明 |
|------|------|
| `report <自由文本>` | 提交工作汇报，COO 解析后自动更新相关任务 |
| `daily` | 生成今日摘要，写入 daily_log |
| `plan` | 基于当前任务池，分析优先级和资源分配，给出建议 |
| `meeting <纪要文本>` | 接收会议纪要，提取 action items 并创建/更新任务 |

### 提醒管理

| 命令 | 说明 |
|------|------|
| `remind <描述> at <时间>` | 手动创建一个提醒 |
| `reminders` | 查看所有活跃的提醒 |
| `remind cancel <R-id>` | 取消某个提醒 |

## 心跳巡视机制

COO 通过 `reminders.json` 中的定时 reminder 实现自主工作节奏，不再完全依赖被动触发。

### 巡视节奏

| 时间 | Reminder | 行为 |
|------|----------|------|
| 每日 09:00 | R-001 晨间巡视 | 扫描全局状态，生成"今天需要关注的事"发给CEO |
| 每日 15:00 | R-002 午后巡视 | 对比晨间状态，发现新进展或新卡点，有事才发 |

### 巡视行为规范

1. **带判断，不列清单**：不是把 task_pool 原样输出，而是筛选出真正需要关注的事项，说明为什么需要关注
2. **检查维度**：
   - in_progress 任务是否超过 2 天未更新
   - 是否有 blocked 或 overdue 任务
   - member_logs/ 下最近是否有新汇报
   - 任务间是否有冲突或可复用的机会
3. **午后巡视的克制**：如果没有值得说的事，不发消息打扰 CEO
4. **自动创建跟进 reminder**：巡视中发现需要后续跟进的事项，主动创建对应的 reminder
