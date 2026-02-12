# XiaoBa 技术蓝图：对齐 MIT 研究生级科研能力

## 1. 目标与边界

### 1.1 目标
把 XiaoBa 从“能写能跑的工程助手”升级为“能提出、验证、反驳、复现科研结论的研究型 Agent”，在特定领域达到或超过多数 MIT 研究生的产出质量与稳定性。

### 1.2 边界
- 不追求通用 AGI。
- 先在 1-2 个垂直方向做深（例如遥感、CAD 成本分析、论文精读写作）。
- 以“证据充分、可复现、能过审”为第一优先级，而不是“回复快、看起来聪明”。

---

## 2. 能力差距总览（XiaoBa vs MIT 研究生）

| 能力维度 | XiaoBa 当前状态 | MIT 研究生典型能力 | 差距等级 |
|---|---|---|---|
| 问题选择与研究价值判断 | 偏执行，缺研究选题评估 | 能判断 novelty、impact、feasibility | 极高 |
| 假设构建与可证伪设计 | 缺标准化假设引擎 | 会把问题转成可证伪假设 | 极高 |
| 证据链管理 | 有工具输出，无严格证据账本 | 结论可追溯到实验与文献 | 极高 |
| 反证与对照意识 | 主要正向执行 | 主动找反例、做消融与对照 | 高 |
| 统计方法学 | 缺 power analysis/显著性流程 | 能设计合理统计验证 | 高 |
| 实验复现性 | 局部可复现，缺全链闭环 | 具备环境/数据/参数复现实践 | 高 |
| 审稿对抗能力 | 缺 reviewer 模拟 | 能预判审稿攻击点 | 高 |
| 研究叙事与写作克制 | 可产出文本，claim 校准弱 | 会控制结论强度与外推边界 | 中高 |
| 跨论文综合与争议处理 | 有检索与解析，综合框架弱 | 能整合冲突证据并形成立场 | 中高 |
| 研究节奏管理 | 有任务工具，但科研节奏模型不足 | 能平衡探索、验证、收敛 | 中 |

---

## 3. 必补的 10 项核心能力

1. 研究问题评分能力  
输入问题后输出 `Novelty / Impact / Feasibility / Risk` 四维评分与理由。

2. 假设模板化能力  
统一格式：`Hypothesis -> Falsifiable Prediction -> Minimal Experiment -> Kill Criteria`。

3. 证据账本能力  
每条结论必须绑定来源（文献/实验/脚本/数据版本），否则不能进入最终报告。

4. 反证优先能力  
默认生成“可能推翻当前结论”的最小实验，而不是只强化已有观点。

5. 对照与消融能力  
自动生成 baseline、ablation 矩阵，确保不是“偶然有效”。

6. 统计严谨能力  
内置统计检验策略选择、样本量建议、置信区间与效应量输出。

7. 复现实验能力  
自动产出并验证 `run_manifest`，支持一键重跑。

8. 审稿人模拟能力  
模拟方法学审稿人、实验审稿人、写作审稿人进行攻击性检查。

9. 结论强度校准能力  
区分“观察到相关”与“支持因果”，限制过度外推。

10. 研究记忆图谱能力  
把事实、假设、实验、结论关联成可查询图，不靠纯文本记忆。

---

## 4. 目标架构蓝图

## 4.1 系统分层

### A. Research Control Plane（科研控制平面）
- `problem-framing-engine`
- `hypothesis-engine`
- `reviewer-arena`
- `claim-calibrator`

### B. Evidence & Repro Plane（证据与复现平面）
- `evidence-ledger`
- `experiment-orchestrator`
- `repro-packager`
- `result-registry`

### C. Knowledge Plane（知识平面）
- `paper-graph-store`
- `memory-graph-store`
- `citation-consistency-checker`

### D. Interaction Plane（交互平面）
- `cli-surface`
- `feishu-surface`
- `report-exporter`

## 4.2 核心数据流

1. 用户提出研究任务  
2. `problem-framing-engine` 产出研究问题定义与可行性评估  
3. `hypothesis-engine` 生成候选假设与可证伪计划  
4. `experiment-orchestrator` 调度实验与工具链  
5. `evidence-ledger` 记录所有中间证据  
6. `reviewer-arena` 主动挑刺并返回修复任务  
7. `claim-calibrator` 压缩结论强度  
8. `report-exporter` 输出可审稿版本

---

## 5. 关键模块设计

## 5.1 Evidence Ledger（证据账本）

### 最小数据结构
```json
{
  "claim_id": "C-2026-001",
  "claim_text": "方法A在数据集X上优于baseline",
  "supporting_evidence": [
    {"type": "experiment", "id": "EXP-11", "artifact": "results/exp11.json"},
    {"type": "paper", "id": "DOI:10.xxxx/xxxx"}
  ],
  "counter_evidence": [],
  "confidence": 0.74,
  "status": "provisional"
}
```

### 规则
- 没有 `supporting_evidence` 的 claim 禁止进入摘要。
- 有 `counter_evidence` 且未解释时，claim 不能标记为 final。

## 5.2 Hypothesis Engine（假设引擎）

### 输出模板
```yaml
hypothesis: H1
statement: "在早期时序下，级联学习可提升分类稳定性"
falsifiable_prediction: "若H1为假，模型在T<=3阶段F1不会显著高于baseline"
minimal_experiment:
  dataset: "CLEC"
  metric: "macro-F1"
  test: "paired bootstrap"
kill_criteria:
  - "effect_size < 0.01"
  - "p_value > 0.05"
```

## 5.3 Reviewer Arena（审稿人竞技场）

### 角色
- `method_reviewer`: 攻击方法合理性与假设可证伪性
- `experiment_reviewer`: 攻击对照、消融、统计
- `writing_reviewer`: 攻击叙事夸大、引用不一致

### 输出
- `major_issues`
- `minor_issues`
- `required_experiments`
- `rewrite_requirements`

---

## 6. 与当前 XiaoBa 代码的落地映射

1. 在 `src/core/conversation-runner.ts` 增加“结论提交闸门”  
结论输出前调用 `evidence-ledger` 校验。

2. 在 `src/tools/` 新增工具
- `hypothesis_tool`
- `evidence_log_tool`
- `counter_evidence_tool`
- `reviewer_arena_tool`
- `repro_manifest_tool`
- `stats_check_tool`

3. 在 `src/core/agent-session.ts` 增加科研模式会话状态
- 当前研究问题
- 活跃假设集合
- claim 状态机

4. 在 `tools/python/` 增补实验与统计脚本
- bootstrap/permutation test
- power analysis
- reproducibility validation

---

## 7. 90 天实施路线图

## Phase 1（第 1-3 周）：可信输出基础
- 上线 `evidence-ledger`（最小可用版）
- claim 无证据禁出
- 引用一致性检查（文中 claim 与引用 ID 对齐）

验收指标：
- 结论可追溯率 >= 90%
- 无证据结论泄漏率 <= 5%

## Phase 2（第 4-6 周）：可证伪研究循环
- 上线 `hypothesis-engine`
- 上线 `counter_evidence_tool`
- 自动生成最小反证实验

验收指标：
- 每个主结论至少 1 个反证实验
- 被反证推翻的低质量结论占比提升（说明系统不再盲信）

## Phase 3（第 7-9 周）：审稿对抗
- 上线 `reviewer-arena`
- 自动把 major issues 回灌到任务计划

验收指标：
- 预审 major issues 关闭率 >= 75%
- 报告中“过强结论”比例下降 >= 50%

## Phase 4（第 10-12 周）：复现闭环
- 上线 `repro-packager` + `run_manifest`
- 一键重跑验证

验收指标：
- 一键复现成功率 >= 85%
- 关键实验结果偏差在容忍阈值内

---

## 8. 达到“强于 MIT 研究生”的量化标准（垂直领域）

1. 证据完备度  
主结论中，证据可追溯率 >= 95%。

2. 反证覆盖度  
每个主结论至少包含 1 个反证或负对照。

3. 复现稳定性  
同版本重复运行，核心指标波动 <= 预设阈值。

4. 审稿抗压能力  
模拟审稿 major issue 平均 < 2 条/稿。

5. 研究吞吐  
在保证上述质量门槛下，周产出（实验轮次+可提交报告）高于目标团队基线。

---

## 9. 主要风险与防护

1. 风险：系统过于复杂，开发期拖长  
防护：所有模块先做最小可用版，先上线“证据闸门”。

2. 风险：工具多但科研质量没提升  
防护：每阶段绑定硬 KPI，不达标不进入下一阶段。

3. 风险：模型幻觉污染账本  
防护：证据写入必须携带 artifact 或外部来源 ID，禁止纯自然语言 claim 直入账本。

4. 风险：只会“看起来像科研”  
防护：优先负结果管理与反证实验，拒绝单向叙事。

---

## 10. 一句话路线

XiaoBa 要超过 MIT 研究生，不是“更会说”，而是“更难错、更能证伪、更可复现”。  
先把证据账本和假设反证循环做出来，再谈更大的智能。
