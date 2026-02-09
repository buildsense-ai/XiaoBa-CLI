# Methods 写作参考（输出 `02_methods.md`）

在撰写 Methods 前再加载本文件，写完后不要继续携带到其他章节，避免上下文过载。

## 写作前置条件（缺一则先问/先 TODO）

- 方法名称（可暂定）
- 任务/问题定义：输入、输出、目标
- 方法整体结构：模块清单 + 数据流（最好有框架图或伪代码）
- 关键设计选择：为什么这么做（至少 2-3 个）
- 训练/优化信息：loss、训练策略、超参（没有就写 `TODO`）
- 实现细节：框架、硬件、batch size、epochs（没有就写 `TODO`）

## 目标文件结构（建议）

写入：`docs/writing/[project]/02_methods.md`

建议结构：

```markdown
# Methods

## 3.1 Overview

## 3.2 Problem Formulation

## 3.3 Proposed Method
### 3.3.1 Component A
### 3.3.2 Component B

## 3.4 Training / Optimization

## 3.5 Implementation Details
```

（章节号 3.x 仅示例；如果用户目标期刊有固定结构，以其为准。）

## 修辞步骤框架（Moves）

### Move 1：方法概述（Overview）— 1-2 段

目的：给读者全局视图，让读者知道你提出了什么、由什么组成。

句式模板（可改写）：

- `We propose {MethodName}, a {type} framework for {task}.`
- `As illustrated in Fig. X, our method consists of {N} components: ...`
- `Our pipeline comprises three stages: (1) ..., (2) ..., and (3) ...`

### Move 2：问题形式化（Problem Formulation）— 1-2 段

目的：用数学/符号定义输入输出与目标。

硬规则：没有符号就不要硬编公式；用 `TODO(formulation)` 占位并询问用户补齐。

句式模板：

- `Given {input}, our goal is to {output/goal}.`
- `Formally, let X = {x_1, ..., x_n} denote ...`
- `We optimize the following objective: TODO(objective).`

### Move 3：组件详细描述（Component Description）— 每组件 2-4 段

目的：逐模块解释“做什么/怎么做/为什么这样设计”。

写作顺序：

1. 动机：要解决什么子问题
2. 机制：算法/网络结构/流程（必要时给伪代码）
3. 关键设计点：与 baseline 的差异
4. 小结：该模块带来的收益（不要编造实验结论）

句式模板：

- `To address {problem}, we introduce {Component}.`
- `Specifically, {Component} takes {input} and produces {output} by ...`
- `Unlike {prior work}, our design {difference}, enabling ...`

### Move 4：训练/优化策略（Training / Optimization）— 1-2 段

目的：说明 loss、训练策略与关键超参。

硬规则：没有 loss/超参就写 `TODO(loss)` / `TODO(hparams)`，并把需要的信息加入 `00_context.md` 的 TODO。

句式模板：

- `The overall objective is defined as: L = L_main + λ L_aux.`
- `We train the model in an end-to-end manner using ...`

### Move 5：实现细节（Implementation Details）— 1 段

目的：给复现所需最低限度信息（框架/硬件/训练时长/关键超参）。

句式模板：

- `Our implementation is based on {framework}.`
- `Models are trained on {hardware} with batch size {B} for {E} epochs. (TODO if unknown)`

## 真实性自检（必须做）

- 是否出现了未提供的训练细节/数据集/数值？若是，改为 `TODO`。
- 是否写了“we achieve SOTA / outperforms by X%”这类 Results 才能支撑的结论？若是，删掉或改为谨慎表述。

