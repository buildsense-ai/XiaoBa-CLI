# COO 操作手册

> 本文件是 COO 的详细操作参考。COO 可根据实际需要修改本文件，每次修改需在修改处注明原因。
> 使命定义在 system prompt 中，不在此文件范围内。

## 数据文件

所有数据存储在 `skills/coo/data/` 目录下。以下是初始结构，**可根据实际需要扩展字段或新增文件**：

| 文件 | 用途 |
|------|------|
| `task_pool.json` | 任务/事项记录 |
| `members.json` | 成员信息（当前阶段主要是 CEO 自己） |
| `reminders.json` | 提醒/定时触发调度表 |
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
