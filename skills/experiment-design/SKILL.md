---
name: experiment-design
description: Design high-quality research experiments from XiaoBa paper-reading outputs. Use when the teacher asks to mine paper ideas, propose falsifiable hypotheses, validate literature evidence, and produce execution-ready artifacts (experiment-plan plus execution-contract) for downstream coding and training.
invocable: user
argument-hint: "<analysis_dir_or_topic> [--scope quick|deep] [--max-ideas N]"
max-turns: 120
allowed-tools:
  - read_file
  - write_file
  - glob
  - grep
  - search_papers
  - paper_detail
---

# 实验设计（Design-to-Execution Contract）

## 目标

把精读结果转成可执行实验规格，而不是停留在“想法”层面。

你负责：

1. 挖掘高价值实验机会点；
2. 生成可证伪假设；
3. 做最小必要文献补证并校验真实性；
4. 产出执行契约文档，让后续执行器可直接写代码并开跑。

你不负责：

1. 训练模型；
2. 运行 shell 命令；
3. 下载或清洗大规模数据。

## 参数策略

输入参数：

- `analysis_dir_or_topic`（必填）
- `--scope quick|deep`（可选）
- `--max-ideas N`（可选）

默认值：

- `scope=quick`
- `max-ideas=3`

scope 控制策略：

- `quick`: 每个假设最多 2 轮检索，保留前 3 个可执行假设。
- `deep`: 每个假设最多 4 轮检索，保留前 5 个可执行假设，并增加反证项。

## 硬规则

1. 不编造论文、指标、SOTA、代码入口。
2. 每条关键结论必须带 `evidence_refs`。
3. 每个实验必须包含 baseline、成功阈值、失败判据、fallback。
4. 文献条目必须先用 `paper_detail(action=detail)`核验，再写入补证文件。
5. 若代码仓库入口不明确，必须在输出里标记 `blocked` 和缺口清单。

## 输出目录与文件

统一写入：

`docs/experiments/<topic_slug>/`

必须生成 7 个文件：

1. `opportunity-map.md`
2. `hypotheses.json`
3. `literature-evidence.json`
4. `experiment-plan.yaml`
5. `execution-contract.yaml`
6. `repo-gap-report.md`
7. `handoff-to-exec.md`

## 执行流程

### Step 1. 定位输入资产

优先读取：

- `docs/analysis/**/chapters/**/analysis.md`
- `summary.md`
- `review.md`
- `progress.json`
- `decision_log.md`

若仅给 topic：

1. 用 `glob` 在 `docs/analysis/` 下找候选目录；
2. 无法确定时，先问 1 个澄清问题。

### Step 2. 机会点挖掘

按以下维度抽取机会点：

- 方法瓶颈
- 实验缺口
- 泛化/鲁棒性缺口
- 计算效率缺口

每个机会点至少包含：

- `id`
- `title`
- `why_promising`
- `risk`
- `evidence_refs[]`

### Step 3. 假设建模

每个机会点生成 1 个主假设：

- 可证伪；
- 有明确自变量和因变量；
- 有最小验证实验（MVP）。

### Step 4. 文献补证与真实性校验

按需调用：

1. `search_papers` 初筛；
2. `paper_detail(detail/references/citations/recommend)`定向补证。

每条文献必须记录：

- `verification.status`: `verified` | `unverified_rate_limited` | `unverified_not_found`
- `verification.checked_via`: `paper_detail`
- `verification.checked_at`: ISO8601
- `verification.citation_count`

若 `429` 或失败，不得伪装为已验证。

### Step 5. 设计实验矩阵

生成 `experiment-plan.yaml`：

- 每个实验一条主线；
- 明确 dataset/baseline/metrics/ablations/budget；
- 加入统计验收标准（均值、方差、显著性方法或置信区间方案）。

### Step 6. 生成执行契约

生成 `execution-contract.yaml`，作为后续代码生成输入。

若仓库内找不到训练入口或配置文件：

- `readiness.status=blocked`
- 在 `repo-gap-report.md` 写清楚缺什么。

### Step 7. 交接文档

`handoff-to-exec.md` 必须包含：

1. 优先级和执行顺序；
2. 每个实验的输入输出契约；
3. 结果回填路径规范；
4. blocked 项和解锁条件。

## Schema 约束

### hypotheses.json（关键字段）

```json
{
  "topic": "string",
  "source_analysis_dir": "string",
  "generated_at": "ISO8601",
  "scope": "quick|deep",
  "hypotheses": [
    {
      "id": "H1",
      "title": "string",
      "statement": "falsifiable statement",
      "independent_variables": ["string"],
      "dependent_variables": ["string"],
      "mvp_experiment": "string",
      "priority": 1,
      "scores": {
        "novelty": 0,
        "feasibility": 0,
        "expected_gain": 0,
        "evaluation_clarity": 0
      },
      "evidence_refs": [
        {
          "path": "docs/analysis/.../analysis.md",
          "locator": "section/paragraph",
          "snippet": "short quote"
        }
      ]
    }
  ]
}
```

### literature-evidence.json（关键字段）

```json
{
  "topic": "string",
  "generated_at": "ISO8601",
  "evidence": [
    {
      "hypothesis_id": "H1",
      "query": "string",
      "paper_id": "string",
      "title": "string",
      "year": 2025,
      "evidence_type": "support|challenge|baseline",
      "note": "string",
      "verification": {
        "status": "verified",
        "checked_via": "paper_detail",
        "checked_at": "ISO8601",
        "citation_count": 12
      }
    }
  ]
}
```

### execution-contract.yaml（必须新增）

```yaml
version: "1.0"
topic: "string"
generated_at: "ISO8601"
source_analysis_dir: "docs/analysis/..."
readiness:
  status: "ready|blocked"
  blockers:
    - "missing training entrypoint"
execution_target:
  framework: "pytorch|tensorflow|unknown"
  python: "3.10+"
  gpu: "string"
dataset_contract:
  path: "string"
  format: "csv|parquet|npy|custom"
  label_column: "string"
  time_column: "string|null"
  feature_columns: ["string"]
  split:
    train: "string|rule"
    val: "string|rule"
    test: "string|rule"
experiments:
  - experiment_id: "E1"
    hypothesis_id: "H1"
    priority: 1
    config_overrides:
      model: "string"
      optimizer: "string"
      seed: 42
    expected_outputs:
      - "results/E1/metrics.csv"
      - "results/E1/train_log.json"
acceptance_gates:
  - metric: "kappa"
    comparator: ">="
    threshold: 0.02
    aggregation: "mean_over_3_seeds"
    significance: "95% bootstrap CI excludes 0"
artifact_policy:
  root: "docs/experiments/<topic_slug>/results"
  overwrite: false
```

## 质量闸门（提交前必须满足）

1. 所有文献均有 `verification` 字段。
2. 所有 `generated_at` 使用当前时间的 ISO8601，不得写固定旧日期。
3. `handoff-to-exec.md` 中的训练入口要么可追溯到仓库文件，要么明确 `blocked`。
4. 每个实验具备可量化验收门槛和统计判据。
5. 所有证据路径统一为仓库相对路径（以 `docs/` 开头）。

## 汇报格式

对老师最终回复保持简洁，包含：

1. 本轮确定的前 N 个实验方向；
2. 哪些方向 `ready`、哪些 `blocked`；
3. 关键风险和解锁条件；
4. 输出文件路径清单。
