# Discussion 写作参考（输出 `04_discussion.md`）

在撰写 Discussion 前再加载本文件。Discussion 的核心是：**解释 + 定位 + 诚实**，但不新增未经证实的“结果”。

## 写作前置条件

- 已完成 `03_results.md`（至少主结果 + 消融草稿）
- 你能回答：方法为什么有效？在哪里失败？这对领域意味着什么？
- 有哪些局限是真实存在、且你愿意公开承认的？

## 目标文件结构（建议）

写入：`docs/writing/[project]/04_discussion.md`

```markdown
# Discussion

## 5.1 Interpretation of Results

## 5.2 Advantages and Practical Implications

## 5.3 Relation to Prior Work

## 5.4 Limitations

## 5.5 Future Work
```

## 修辞步骤框架（Moves）

### Move 1：结果解读（Result Interpretation）— 2-3 段

目的：回答“为什么有效”，把结果与设计动机对应起来。

句式模板：

- `The superior performance can be attributed to ...`
- `We hypothesize that the improvement stems from ..., which is supported by ...`
- `An interesting observation is that ..., suggesting ...`

硬规则：不要引入新实验结论；只能解释已有结果。

### Move 2：优势分析（Advantage Analysis）— 1-2 段

目的：总结优势，但必须有证据（来自 Results）。

句式模板：

- `Compared to existing approaches, our method offers: (1) ..., (2) ...`
- `In terms of {dimension}, our approach demonstrates ..., as evidenced by Table/Fig. X.`

### Move 3：与已有文献对话（Dialogue with Literature）— 1-2 段

目的：把你的发现放到研究谱系中，说明一致/不一致的地方。

硬规则：没有真实引用就使用 `REF_TODO`，不要编造作者/年份。

句式模板：

- `Our findings are consistent with [REF_TODO], which also reports ...`
- `In contrast to [REF_TODO], our results suggest ...`

### Move 4：局限性（Limitations）— 1-2 段

目的：诚实、具体、可操作地说明局限。

写法建议：

- 至少 2 条局限：数据依赖/泛化/计算成本/鲁棒性等
- 每条都给“原因 + 影响范围 + 可能缓解方向”

句式模板：

- `Despite promising results, our method has limitations.`
- `First, ..., which may limit its applicability to ...`

### Move 5：未来工作（Future Work）— 1 段

目的：基于局限给出合理扩展方向（不要许愿式吹牛）。

句式模板：

- `A promising direction is to ...`
- `We plan to extend our method to ...`

## 真实性自检（必须做）

- 是否出现“尚未做过的实验/未验证的结论”？删掉或改 `TODO(future experiment)`.
- 是否出现“引用看起来很真但其实不存在”？改 `REF_TODO` 并列到 `00_context.md` TODO。

