# Results 写作参考（输出 `03_results.md`）

在撰写 Results 前再加载本文件。Results 的核心原则：**只写事实（facts）+ 最小必要解释**，不要抢 Discussion 的工作。

## 写作前置条件（缺一则先问/先 TODO）

- 数据集名称/来源/划分方式
- 指标定义（至少 1 个主指标）
- 对比方法列表（baselines）+ 公平设置说明
- 主要结果表（哪怕是草稿）
- 消融实验（如果论文声称有组件创新，则消融通常是必须的；没有就写 `TODO(ablation)`）
- 定性可视化（若任务需要；没有就写 `TODO(qualitative)`）

## 目标文件结构（建议）

写入：`docs/writing/[project]/03_results.md`

```markdown
# Results

## 4.1 Experimental Setup

## 4.2 Main Results

## 4.3 Detailed Analysis

## 4.4 Ablation Study

## 4.5 Qualitative Results (optional)
```

## 修辞步骤框架（Moves）

### Move 1：实验设置（Experimental Setup）— 2-3 段

目的：让读者理解结果的上下文（数据/指标/对比/实现差异）。

硬规则：不要编造数据规模、训练时长、baseline 配置；缺信息就 `TODO`。

句式模板：

- `We evaluate our method on {datasets}.`
- `Following prior work, we adopt {metrics} as the evaluation metric(s).`
- `We compare against {baselines}. For fair comparison, TODO(setting).`

### Move 2：主要结果（Main Results）— 2-3 段

目的：用 Table/Plot 给出主要对比，先总述趋势，再点关键数字。

写作顺序：

1. 指向表格：Table X
2. 一句话总结：你是否最好（若不是就老实写）
3. 点出最重要的 2-3 个对比差异（有数字才写数字）

句式模板：

- `Table X summarizes the comparison on {dataset}.`
- `Our method achieves the best performance on {metric} (TODO value if missing).`
- `Compared to {strongest baseline}, we obtain an improvement of TODO(delta).`

### Move 3：详细分析（Detailed Analysis）— 2-3 段

目的：解释“在哪些子场景更好/更差”，但不要上升到方法机制层面的长篇解释（留给 Discussion）。

句式模板：

- `To better understand the behavior of our method, we analyze ...`
- `Fig. X shows ..., where we observe that ...`

### Move 4：消融实验（Ablation Study）— 2-3 段

目的：验证各组件贡献，支持你的方法设计。

硬规则：没有消融数据就不要写“removing A leads to X% drop”；用 `TODO` 占位并请求数据。

句式模板：

- `We conduct ablation studies to validate each component (Table X).`
- `Removing {component} degrades performance by TODO(delta), indicating ...`

### Move 5：定性结果（Qualitative Results）— 1-2 段（可选）

目的：展示可视化对比，强调边界/细节/失败案例。

句式模板：

- `Fig. X presents qualitative comparisons with {baselines}.`
- `As highlighted, our method better captures ...`

## 真实性自检（必须做）

- 每个数字是否来自用户提供的表格/日志？否则改 `TODO`。
- 每个“优于/提升/显著”是否有可核对证据？否则改为弱断言或删掉。

