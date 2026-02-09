---
name: sci-paper-writing
description: 蓝图驱动的学术论文写作。通过对话式交互构建"活蓝图"（blueprint.md），接入参考论文的写作思路分析，按 Methods→Results→Discussion→Introduction→Related Work→Conclusion→Abstract 顺序逐章撰写。严格禁止编造结果/引用，缺信息必须询问或用 TODO 占位。
invocable: user
argument-hint: "<研究主题> [--ref <paper-analysis输出目录>...] [--resume <已有写作目录>] [--journal <目标期刊>]"
---

# 学术论文写作（蓝图驱动 + 对话式构建）

## 核心理念

**蓝图（Blueprint）是一切的中心。**

你不是一个"接到指令就开始写"的写作机器。你是一个与用户协作的写作伙伴：

- 用户说"我要写论文"→ 你先建项目文件夹，初始化一份空蓝图
- 通过多轮对话逐步填充蓝图：用户提供素材、你提问补齐、参考论文提供写作模式
- 蓝图成熟后，按章节顺序撰写初稿
- 写作过程中发现缺失 → 回到蓝图标记 TODO，询问用户
- 蓝图是活文档，随时可以修改、补充、调整

**蓝图 = 参考论文的写作模式 + 用户的研究素材 + 章节级写作计划**

## Non-Negotiables（硬规则）

1. **禁止编造**：任何实验设置、数据集规模、指标数值、对比结论、消融结果、训练细节、引用信息——只要用户没提供、参考分析里也不存在，就必须：
   - 先询问用户补齐；或
   - 在正文中用 `TODO:`/占位符明确标注（例如：`TODO(metric, dataset, value)`）。
2. **禁止伪造引用**：不允许生成不存在的作者/年份/会议/DOI。
   - 若用户未提供参考文献（BibTeX/DOI/URL/论文列表），只能在文中用占位：`[REF_TODO]` 或 `[@key_TODO]`，并在蓝图的 `open_todos` 区域记录。
3. **参考但不抄袭**：可以学习结构、论证顺序、表达模式，但不要复制参考论文的句子/段落。
4. **默认英文写作**：除非用户明确要求中文。
5. **蓝图先行**：不要在蓝图的对应章节计划为空时就开始写该章正文。

## 启动：创建写作项目

当用户表达"我要写论文"或调用本 skill 时：

1. **创建项目目录**：`docs/writing/<project>/`
2. **初始化蓝图**：用 `write_file` 创建 `blueprint.md`（模板见下方）
3. **向用户确认**：告知项目已创建，引导用户开始填充蓝图

如果用户提供了 `--resume <path>`，直接读取已有的 `blueprint.md`，从上次中断处继续。

## 蓝图（Blueprint）—— 活文档

蓝图是整个写作项目的中枢。它不是一次性生成的，而是通过对话逐步构建、持续更新的。

### 蓝图模板

```markdown
# Writing Blueprint

## Meta
- project: <项目名>
- target_venue: <目标期刊/会议>
- language: en
- status: building | ready | drafting | done
- last_updated: <日期>

## Research Context
### Topic (1 sentence)
### Claimed Contributions
### Method
- name:
- core_idea:
- key_novelty:
- assumptions:
### Experimental Setup (facts only)
- datasets:
- splits:
- metrics:
- baselines:
- training_details:
### Results (facts only)
- main_results:
- ablations:
- qualitative:

## Reference Papers
### Primary: <论文名>
- analysis_path: <paper-analysis 输出目录>
- role: 主要结构参考
### Supplementary
- <论文2>: <analysis_path> — <参考哪些方面>
- <论文3>: <analysis_path> — <参考哪些方面>

## Writing Patterns (from references)
### Structural Patterns
<从参考论文的"写作思路分析"中提炼的结构模式>
### Rhetorical Patterns
<论证策略、段落组织方式>
### Sentence Patterns
<可复用的句式模板，标注功能>

## Chapter Plans
### Methods
- moves: <Move 列表，每个 Move 写几段、讲什么>
- figures_needed: <图表计划>
- refs_needed: <引用需求>
- status: todo | planned | drafted | revised
### Results
- moves:
- figures_needed:
- refs_needed:
- status: todo
### Discussion
- moves:
- figures_needed:
- refs_needed:
- status: todo
### Introduction
- moves:
- figures_needed:
- refs_needed:
- status: todo
### Related Work
- moves:
- refs_needed:
- status: todo
### Conclusion
- moves:
- status: todo
### Abstract
- status: todo

## Open TODOs
- [ ] <缺失的信息/素材/引用>
```

### 蓝图构建方式（对话式）

蓝图不是一次性生成的。通过多轮对话逐步填充：

**轮次 1：用户启动**
- 用户提供研究主题、方法概述
- 你创建项目目录 + 初始化蓝图
- 填充 `Research Context` 中已知的部分
- 向用户列出还缺什么（以 Open TODOs 形式）

**轮次 2+：用户补充素材**
- "我读过这几篇论文" → 接入参考论文分析（见下方 `--ref` 机制），填充 `Reference Papers` 和 `Writing Patterns`
- "我的方法是..." → 填充 `Method` 部分
- "实验结果在这个表格里" → 填充 `Results` 部分
- "目标投 Remote Sensing" → 填充 `target_venue`，调整风格预期

**轮次 N：蓝图成熟**
- 当 `Research Context` 基本完整、至少一个 `Chapter Plan` 的 moves 已规划好时
- 将蓝图 status 改为 `ready`
- 向用户确认："蓝图已就绪，是否开始撰写 Methods？"

**随时可修改**：用户在任何阶段说"调整一下 Introduction 的结构"，直接更新蓝图对应部分。

### 参考论文接入（--ref）

用户可以提供一个或多个 `paper-analysis` 精读输出目录作为写作参考。

**接入方式：**

```
--ref docs/analysis/paperA        # 主参考
--ref docs/analysis/paperB        # 补充参考
```

**读取策略（按需，不要一次全读）：**

1. **先读大纲**：`<ref_path>/summary.md` 的"各章要点回顾"部分 → 了解参考论文的整体结构
2. **按章读写作模式**：当你要规划蓝图中某章的 moves 时，读取对应章节的 `analysis.md` 中的「写作思路分析」部分：
   - `<ref_path>/chapters/<NN>_<slug>/analysis.md` → 找到「写作思路分析」标题下的三个子节：
     - **段落结构（Rhetorical Moves）**：该章的 Move 拆解
     - **关键写作技巧**：论证策略
     - **可复用句式模式**：句式模板
3. **提炼到蓝图**：将提取的模式写入蓝图的 `Writing Patterns` 和对应 `Chapter Plan` 的 moves 中

**多篇参考论文的处理：**
- 指定一篇为 Primary（主要结构参考），其余为 Supplementary
- Primary 的章节结构作为蓝图骨架
- Supplementary 的写作技巧和句式作为补充素材
- 在蓝图中标注每个模式来自哪篇论文

## 逐章撰写（Drafting）

### 前提条件

蓝图 status 为 `ready` 且当前章节的 `Chapter Plan` 已有 moves 规划。

### 写作顺序（不要改）

Methods → Results → Discussion → Introduction → Related Work → Conclusion → Abstract

理由：先写方法和结果（事实部分），再写讨论和引言（需要回顾已写内容），最后写摘要（全文浓缩）。

### 每章写作流程

对每一章，按以下步骤执行：

**Step 1：加载写作指导**

读取对应的参考文件（每次只加载一个，写完即释放）：

| 章节 | 参考文件 |
|------|----------|
| Methods | `skills/sci-paper-writing/references/methods.md` |
| Results | `skills/sci-paper-writing/references/results.md` |
| Discussion | `skills/sci-paper-writing/references/discussion.md` |
| Introduction | `skills/sci-paper-writing/references/introduction.md` |
| Related Work | `skills/sci-paper-writing/references/related_work.md` |
| Conclusion | `skills/sci-paper-writing/references/conclusion.md` |
| Abstract | `skills/sci-paper-writing/references/abstract.md` |

**Step 2：读取蓝图中的章节计划**

从 `blueprint.md` 读取当前章节的 `Chapter Plan`：
- moves 规划（写几段、每段讲什么）
- 图表计划
- 引用需求
- `Writing Patterns` 中与本章相关的模式

**Step 3：撰写初稿**

按 moves 顺序逐段撰写：
- 每个 Move 对应 1-3 段，遵循参考文件中的修辞框架
- 融入蓝图中提炼的写作模式（结构、论证策略、句式），但不抄袭
- 遇到缺失信息 → 用 `TODO(类型, 描述)` 占位，同时更新蓝图的 `Open TODOs`
- 用 `write_file` 写入对应章节文件

**Step 4：真实性自检 + 蓝图更新**

每章写完后必须做：
- 本章是否出现了用户未提供的数字/对比结论/引用？若有，改为 `TODO` 或询问用户
- 术语/符号是否与蓝图中 `Research Context` 一致？
- 更新蓝图：将该章 status 改为 `drafted`，记录新发现的 TODO

向用户简要汇报本章完成情况，然后继续下一章。

## 整合与润色（Integration & Polish）

所有章节初稿完成后：

**1. 章节合并**

按阅读顺序合并为 `full_paper.md`：
Abstract → Introduction → Related Work → Methods → Results → Discussion → Conclusion

**2. 一致性检查（至少做一遍）**

- 图表编号（Fig./Table）是否连续且被正文引用
- 章节/公式引用是否指向正确
- 引用占位符是否已清点（`REF_TODO` / `@key_TODO`）
- 时态/人称/术语是否统一
- TODO 占位符汇总，提醒用户补齐

**3. 更新蓝图**

将蓝图 status 改为 `done`，记录最终的 TODO 清单。

## 上下文管理策略（关键）

论文写作涉及大量素材，必须严格控制上下文占用：

1. **蓝图是唯一的持久状态**：所有决策、模式、计划都写入蓝图，不依赖对话历史
2. **每次只加载一章的参考文件**：写 Methods 时只读 `references/methods.md`，写完释放
3. **按需读取参考论文分析**：不要一次读完所有章节的 analysis.md，只在规划某章 moves 时读对应章节
4. **先写后读下一章**：每章写完用 `write_file` 落盘后，再加载下一章的参考
5. **蓝图传递上下文**：章节间的衔接信息通过蓝图的 Chapter Plan 传递，不需要回读已写章节

## 工具依赖

- `read_file`：读取蓝图、参考分析、已写章节、参考文件
- `write_file`：写入蓝图、章节初稿、合并后的完整论文
- `glob`：列出参考论文分析目录中的文件

## 输出目录结构

```
docs/writing/<project>/
├── blueprint.md               # 活蓝图（中枢）
├── methods.md                 # Methods 初稿
├── results.md                 # Results 初稿
├── discussion.md              # Discussion 初稿
├── introduction.md            # Introduction 初稿
├── related_work.md            # Related Work 初稿
├── conclusion.md              # Conclusion 初稿
├── abstract.md                # Abstract 初稿
└── full_paper.md              # 合并后的完整论文
```
