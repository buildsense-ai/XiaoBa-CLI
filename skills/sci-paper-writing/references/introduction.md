# Introduction 写作参考（输出 `05_introduction.md`）

在撰写 Introduction 前再加载本文件。建议在 Methods/Results/Discussion 都有初稿后再写 Introduction（避免贡献定位不准）。

## 写作前置条件

- 你能用 1 句话说清楚：研究问题 + 为什么重要
- 你能列出 3-4 条明确贡献（与 baseline 的差异要具体）
- 至少有一张主结果表格（否则 Introduction 里不要写强结论）

## 目标文件结构（建议）

写入：`docs/writing/[project]/05_introduction.md`

```markdown
# Introduction

## 1.1 Background and Motivation

## 1.2 Problem Statement

## 1.3 Challenges and Gap in Prior Work

## 1.4 Our Approach and Contributions

## 1.5 Paper Organization
```

## 修辞框架：Swales CARS（Create A Research Space）

### Move 1：建立研究领域（Establish Territory）— 2-3 段

目的：背景 + 重要性 + 领域现状。

句式模板：

- `{Field} has attracted increasing attention due to ...`
- `Recent advances in {X} have enabled ...`

### Move 2：建立研究缺口（Establish Niche）— 2-3 段

目的：指出 prior work 的具体局限，论证“为什么需要你这篇论文”。

硬规则：不要用空泛的“still challenging”；要具体到：什么条件下失败/代价大/假设不成立。

句式模板：

- `However, existing methods often {limitation}, which leads to ...`
- `Despite the progress, {issue} remains challenging due to ...`
- `A key limitation is that ...`

引用规则：没有真实文献就用 `REF_TODO`，不要编造。

### Move 3：占据研究空间（Occupy Niche）— 2-3 段

目的：提出你的方法 + 核心 idea + 贡献清单 +（可选）结果亮点。

贡献写法（推荐 3-4 条，动词开头，具体可验证）：

- `We propose ...`
- `We design ...`
- `We conduct ...`
- `Extensive experiments ...`（只有当你真的有结果表时）

句式模板：

- `In this paper, we propose {MethodName}, which ...`
- `The main contributions are summarized as follows:`

### Move 4（可选）：文章结构（Paper Organization）— 1 段

目的：指路。

句式模板：

- `The remainder of this paper is organized as follows. Section 2 ...`

## 真实性自检（必须做）

- Introduction 是否出现具体数值/大幅提升？若 Results 未提供证据，改为弱断言或删除。
- 是否出现虚构引用？改 `REF_TODO` 并清点。

