# GauzMem 记忆系统重构需求文档

> 基于 XiaoBa COO agent 实际运行的 context debug log 分析，以及对 GauzMem 架构的审视，整理出以下改进方向。

## 背景

当前 GauzMem 作为 XiaoBa agent 的长期记忆服务运行，暴露出几个核心问题：

1. Recall 返回大量低质量 fact（如 agent 回复 "ok" 的记录），占用 context window token
2. Metabolism 的 decay 基于物理时间（wall clock），与 agent 的实际活跃节奏不匹配
3. 记忆以 project_id（用户账号）为隔离单位，而非以 agent 为中心
4. 部署复杂度高（6 个外部服务），不适合单 agent 快速部署场景

## 一、Life Clock — Agent 主观时间

### 问题

当前 metabolism 用物理时间做 decay：`exp(-(wall_seconds - 86400) / tau)`，tau=14天。

这对 agent 是错的：
- Agent 密集工作 2 小时处理 50 条消息，这 2 小时相当于人类"一整天"，但 wall clock 只过了 2 小时，decay 几乎为零
- Agent 停机 8 小时，wall clock 过了 8 小时，记忆无差别衰减，但 agent 没有"体验"这段时间
- 人类的遗忘是在清醒时发生的，睡眠反而巩固记忆。Agent 停机 ≈ 睡眠，不应衰减

### 方案

引入 agent 级别的 life_clock（逻辑时钟），tick 单位 = agent 活动量。

tick 来源（初步）：每次 writeMessage 调用 = 1 tick。这是 agent "醒着"的最小可观测单位。

decay 函数改为：`exp(-ticks_since_last_ref / tau_ticks)`

tau_ticks 的含义变成"经过多少次活动后，未被引用的记忆衰减到 1/e"。

### 实现要点

- facts 表新增 `created_at_tick` 和 `last_ref_at_tick` 字段
- 每个 agent（project_id + agent_id）维护一个 `current_tick` 计数器
- writeMessage 时 current_tick++
- metabolism 计算 quality_score 时用 tick 差值替代时间差值
- 物理时间戳保留（用于人类查看、排序），但不参与 decay 计算

## 二、Decay 函数重设计 — 先快后慢

### 问题

当前纯指数衰减是匀速的。人类记忆的遗忘曲线（Ebbinghaus）是先快后慢：新信息如果短期内没被巩固就快速遗忘，一旦巩固则进入长期记忆。

### 方案

双速 decay，由 recall 事件切换：

- 未被 recall 过的 fact：用 tau_fast（如 50 ticks）
- 被 recall 过的 fact：用 tau_slow（如 500 ticks）
- 每次有效 recall 重置 decay 起点（last_ref_at_tick = current_tick）

公式：
```
tau = recall_count > 0 ? tau_slow : tau_fast
time_score = exp(-(current_tick - last_ref_at_tick) / tau)
```

这样：
- "ok" 这种从未被有效 recall 的 fact，50 个 tick 后就衰减到 0.37，很快被清理
- 被反复 recall 的重要记忆，衰减极慢，且每次 recall 都刷新起点

### 参数建议（需实测调整）

- tau_fast: 30-50 ticks（未巩固记忆的半衰期）
- tau_slow: 300-500 ticks（已巩固记忆的半衰期）
- freshness_boost 保护期：从 7 天改为 10-20 ticks

## 三、Recall 与 Metabolism 打通

### 问题

当前 metabolism 计算了 quality_score，但 recall 阶段完全不用它。recall 只看：
- 向量相似度 >= min_relevance（seed 阶段）
- relation confidence >= min_confidence（BFS 扩展阶段）

BFS 扩展出来的 fact 没有任何质量过滤，只要图上连着就拉出来。

### 方案

BFS 扩展阶段加入 quality_score 门控：

```python
# _mysql_graph_expand 或 _neo4j_graph_expand 中
# 扩展出的 fact 需要 quality_score >= quality_gate 才纳入结果
```

quality_gate 可以比 cleanup_threshold 高（比如 0.3），这样：
- cleanup_threshold=0.2 以下的被物理删除
- 0.2~0.3 之间的还活着但不会被 recall 拉出来
- 0.3 以上的正常参与 recall

这给了一个缓冲区：fact 不会突然消失，而是先变得"想不起来"，再慢慢被清理。

## 四、记忆隔离 — 以 Agent 为中心

### 问题

当前 GauzMem 以 project_id 隔离记忆，project_id 通常对应一个用户账号。但一个用户可能运行多个 agent（COO、dev agent、browser agent），它们的记忆不应混在一起。

### 方案

隔离维度从 `project_id` 扩展为 `project_id + agent_id`：

- 每个 agent 有独立的记忆空间、独立的 life_clock、独立的 metabolism 节奏
- Qdrant collection 按 agent_id 分区（或用 payload filter）
- MySQL facts 表加 agent_id 字段
- 跨 agent 记忆共享是显式的（通过 API 调用），不是隐式混合

### 迁移

- 现有数据默认 agent_id = "default"
- 新写入的数据带上 agent_id
- recall 时按 agent_id 过滤

## 五、部署简化 — 单 Agent 模式

### 问题

当前部署需要 6 个外部服务（MySQL、Neo4j、Qdrant、Redis、MinIO）+ 认证系统（JWT、API Key、OAuth）。对于"一个云端 agent + 一个记忆服务"的场景过于复杂。

### 方案：提供 lite 部署模式

保留完整版作为多租户/企业版，新增 lite 模式：

**可剥离的组件：**
- 认证系统（JWT/API Key/OAuth）→ lite 模式下跳过，或单 token 验证
- Redis → 内存队列（单 agent 不需要分布式任务队列）
- MinIO → 本地文件系统（单 agent 不需要对象存储）
- Neo4j → 可选。图扩展可以纯用 MySQL relations 表（当前已支持 MySQL fallback）
- OAuth 路由、用户管理路由 → lite 模式不注册

**最小依赖栈：**
- MySQL（或 SQLite）+ Qdrant + LLM API
- 单进程，同步 pipeline
- 环境变量配置，无需 .env 文件（有默认值）

**实现方式：**
- config.py 新增 `GAUZ_LITE_MODE=true`
- app.py 启动时根据 lite mode 跳过不需要的服务初始化
- 路由注册时跳过 auth/admin/files 等路由
- docker-compose.lite.yml 只包含 MySQL + Qdrant

## 优先级建议

| 优先级 | 改动 | 理由 |
|--------|------|------|
| P0 | Life Clock + Decay 重设计 | 解决 recall 噪音的根本原因，当前 metabolism 在错误的时间轴上运行 |
| P1 | Recall 与 Metabolism 打通 | BFS 扩展加 quality_score 门控，立竿见影减少噪音 |
| P2 | 记忆隔离（agent_id） | 多 agent 场景的基础，但当前只有一个 agent 在跑，不紧急 |
| P3 | 部署简化（lite mode） | 降低部署门槛，但不影响功能 |

## 验证方式

每个改动落地后，用 XiaoBa 的 context-reviewer skill 跑一批新 log，对比：
- recall 的 facts_count 和 token 占比是否下降
- 低质量 fact（如 "ok"）是否不再出现
- 有价值的记忆是否仍然被正确召回
