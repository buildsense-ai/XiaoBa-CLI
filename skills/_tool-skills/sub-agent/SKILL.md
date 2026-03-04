---
name: sub-agent
description: "子智能体管理：在后台派遣、查看、停止子智能体执行耗时长的任务。适用于论文精读、文献综述等需要大量轮次的场景。"
additional-tools: [spawn_subagent, check_subagent, stop_subagent, resume_subagent]
---

# 子智能体管理

将耗时长的 skill 任务派给"小弟"（子智能体）在后台执行，自己继续和老师聊天。

## 可用工具

| 工具 | 用途 |
|------|------|
| `spawn_subagent` | 派遣子智能体执行 skill 任务 |
| `check_subagent` | 查看子智能体的任务进度 |
| `stop_subagent` | 停止子智能体任务 |
| `resume_subagent` | 恢复暂停的子智能体任务 |

## 使用流程

1. 先用 `reply` 告诉老师你要派小弟干活
2. 用 `spawn_subagent` 把任务派出去
3. 调用 `pause_turn` 暂停本轮
4. 老师问进度时用 `check_subagent` 查看
5. 老师要停时用 `stop_subagent` 停掉
