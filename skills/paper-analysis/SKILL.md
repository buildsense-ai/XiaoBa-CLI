---
name: paper-analysis
description: 论文精读（Agent-native）：像人一样逐章顺序阅读，基于累积的阅读理解自主判断图表是否需要多模态分析。
invocable: user
argument-hint: "<pdf_path_or_url> [--resume <已有分析目录>]"
max-turns: 150
---

# 论文精读（Agent-native 版）

## 核心理念

你是一个正在精读论文的研究者。你要**像人一样阅读**：

- 先翻目录，了解论文结构
- 逐章顺序阅读，每读完一段都在积累理解
- 遇到图表时，基于你已经读过的内容来判断要不要仔细看
- 每章读完写一份分析笔记，带着理解进入下一章
- 最后做全文总结

**你自己就是精读的主体，不要把精读委托给任何"控制器"工具。**

## 硬规则（Non-Negotiables）

1. **进度文件只写一次**：在 Step 2 初始化 `progress.json`（含 pdf_path、full_md_path、章节列表）。之后**不再更新** progress.json——每章完成的标志是对应的 `chapters/<NN>_<slug>/analysis.md` 文件存在。断点续跑时通过检查文件系统判断进度，不依赖 progress.json 中的 status 字段。
2. **图表决策必须记录**：每遇到一个 image block，必须在 `decision_log.md` 追加一条记录（看了/没看/理由）。不记录 = 违规。
3. **先写日志再写分析**：处理完一个 image block 后，先追加 decision_log，再继续阅读下一个 block。不要攒到章节末尾批量补写。

## 可用工具

| 工具 | 用途 | 何时调用 |
|------|------|----------|
| `paper_parser` | PDF 解析（MinerU） | Step 1，仅一次 |
| `markdown_chunker` | 切分章节和块 | Step 2 获取大纲 + Step 3 逐章获取块 |
| `analyze_image` | 读取图片 + 多模态分析（一步完成） | 当你决定要深度分析某张图时 |
| `write_file` | 写入分析文件 | 每章分析完后写入 |

## 脚本调用方式

本 skill 的 Python 脚本位于 `skills/paper-analysis/` 和 `tools/shared/` 目录下，通过 `execute_shell` 调用。

**paper_parser**（解析 PDF）：
```bash
python skills/paper-analysis/paper_parser_tool.py '{"pdf_path": "<path_or_url>", "extract_sections": true, "extract_metadata": true}'
```

**markdown_chunker**（切分章节）：
```bash
python skills/paper-analysis/markdown_chunker_tool.py '{"full_md_path": "<path>", "outline_only": true, "chapter_level": 1}'
```

**analyze_image**（多模态图片分析）：
```bash
python tools/shared/analyze_image_tool.py '{"file_path": "<image_path>", "prompt": "<具体问题>"}'
```

所有脚本接收 JSON 字符串作为参数，返回 JSON 结果到 stdout。

## 执行流程

### 断点续跑（--resume）

如果用户提供了 `--resume <已有分析目录>`：

1. 读取 `<path>/progress.json` 获取 `full_md_path` 和章节列表
2. 扫描 `<path>/chapters/` 目录，检查哪些章节已有 `analysis.md` 文件
3. 跳过已有 `analysis.md` 的章节，从第一个缺失的章节开始
4. `decision_log.md` 保持追加，不清空已有记录

不需要重新执行 Step 1 和 Step 2（PDF 已解析，大纲已获取），直接进入 Step 3。

### Step 1：解析 PDF

`pdf_path` 支持两种输入：
- **本地文件路径**：如 `extracted/pdf_xxx/xxx.pdf`，会先上传 MinIO 再提交 MinerU 解析
- **远程 URL**：如 `https://arxiv.org/pdf/2511.16518`，直接提交 MinerU 解析，无需下载

调用 `paper_parser`：

```json
{
  "pdf_path": "<pdf_path_or_url>",
  "extract_sections": true,
  "extract_metadata": true
}
```

检查返回结果：
- `full_md_path` 非空 → 继续 Step 2
- 失败或 `full_md_path` 为空 → 走降级路径（见末尾）

### Step 2：获取论文大纲

调用 `markdown_chunker`（仅拿大纲，不拿正文）：

```json
{
  "full_md_path": "<full_md_path>",
  "outline_only": true,
  "chapter_level": 1,
  "skip_first_heading": true,
  "keep_empty_chapters": false
}
```

拿到大纲后，**过滤掉非正文章节**（如 References、Acknowledgments、Appendix），这些章节不进入逐章精读流程，也不写入 `progress.json`。

然后向用户简要报告论文结构：
- 论文标题
- 共几章，各章标题
- 各章的 block 统计（多少文本块、图片、表格）

这一步让你和用户都对论文有全局认知，再开始逐章精读。

**初始化进度文件**：用 `write_file` 创建 `progress.json`（仅此一次，后续不再更新）：

```json
{
  "pdf_path": "<pdf_path>",
  "full_md_path": "<full_md_path>",
  "total_chapters": <N>,
  "chapters": [
    {"index": 1, "title": "<章节标题>", "chunk_indices": [<对应的 chunk index>]},
    {"index": 2, "title": "<章节标题>", "chunk_indices": [<对应的 chunk index>]}
  ]
}
```

**路径**：`docs/analysis/<pdf_stem>/progress.json`

同时创建空的 `decision_log.md`：

```markdown
# Decision Log

| 章节 | Block | 类型 | 决策 | 理由 |
|------|-------|------|------|------|
```

**路径**：`docs/analysis/<pdf_stem>/decision_log.md`

### Step 3：逐章精读（核心）

对大纲中的每一章，按顺序执行：

#### 3a. 获取本章的 blocks

```json
{
  "full_md_path": "<full_md_path>",
  "chapter_selector": "<chapter_index>",
  "chapter_level": 1,
  "include_heading_blocks": true,
  "resolve_images": true,
  "max_text_block_chars": 3000,
  "skip_first_heading": true,
  "keep_empty_chapters": false
}
```

注意 `max_text_block_chars` 设为 3000（而非默认 1200），保持段落语义完整性。

#### 3b. 顺序阅读 blocks

按返回顺序逐块阅读。**阅读时同时关注两个维度：内容（写了什么）和写法（怎么写的）。**

对每种 block 类型：

**text 块**：阅读理解内容的同时，注意段落的修辞功能（是在建立背景、构建gap、描述方法、还是解读结果？），以及段间的过渡方式和关键句式。

**heading 块**：标记小节边界，同时记录章节的组织逻辑（小节之间是什么关系：递进、并列、总分？）。

**table 块**：阅读数据含义的同时，注意作者如何在正文中引用和解读表格（先总述趋势还是先指向表格？）。

**image 块**：这是关键——见下方「图表决策策略」。

#### 3c. 图表决策策略

遇到 image block 时，你已经读过了前面的所有内容，拥有充分的上下文。基于你的理解来决定：

**需要调用 analyze_image 深度分析的情况：**
- 核心实验结果图（性能对比、精度曲线、消融实验）
- 方法论架构图/流程图，且正文描述不够清晰或你需要验证理解
- 图中包含正文未充分描述的关键细节（如复杂的网络结构、多步骤流程）
- 你对正文的描述有疑问，需要看图来确认

**不需要调用 analyze_image 的情况：**
- 研究区域/地理位置图（正文已描述清楚）
- 正文已经完整解释了图表的所有关键信息
- 纯装饰性、示意性的简单图
- 与论文核心贡献关系不大的补充图

**执行方式：**

当你决定要看图时，只需一次调用：
```json
{
  "file_path": "<resolved_path>",
  "prompt": "<基于上下文的具体问题>"
}
```
工具：`analyze_image`。它内部完成图片读取 + 多模态分析，只返回文字结果，base64 不会进入对话历史。

当你决定不看图时：
- 基于 caption 和上下文直接给出简要说明
- 在分析中注明"基于图注和正文描述"

**关键原则：你的 prompt 应该是具体的、基于上下文的问题，而不是泛泛的"请分析这张图"。**

好的 prompt 示例：
- "这张图展示了 proposed method 与 baseline 在 4 个数据集上的 F1 对比，请读取具体数值并指出哪些数据集提升最显著"
- "这是网络架构图，请确认 encoder 部分是否使用了 skip connection，以及 feature fusion 的具体方式"

差的 prompt 示例：
- "请分析这张图"
- "这张图讲了什么"

**决策日志记录（硬规则）：**

每处理完一个 image block（无论看不看），立即用 `write_file` 向 `decision_log.md` 追加一行：

```
| <章节名> | <block_id/figure_id> | image | analyzed / skipped | <一句话理由> |
```

不要攒到章节末尾批量补写。

#### 3d. 写入章节分析

每章读完后，用 `write_file` 写入分析文件：

**路径**：`docs/analysis/<pdf_stem>/chapters/<NN>_<slug>/analysis.md`

**内容结构**：

```markdown
# <章节标题>

## 本章讲了什么
<核心内容概述，3-5 句话>

## 关键要点
- <要点 1>
- <要点 2>
- ...

## 图表分析
### Figure X: <caption>
<你的分析，说明是否调用了 analyze_image>

### Table Y: <caption>
<数据解读>

## 写作思路分析

### 段落结构（Rhetorical Moves）
- **Move N（功能，X 段）**：这几段做了什么、为什么这样安排、段间如何过渡
- ...（逐 Move 拆解，标注每个 Move 包含几段、各段的功能）

### 关键写作技巧
- <技巧 1>：具体说明作者用了什么论证策略（如"分流汇聚式 gap 构建""先肯定再指出共同局限"）
- <技巧 2>：...

### 可复用句式模式
- <功能>："<从原文提取的句式模板，将具体内容替换为占位符>"
- <功能>："<...>"
（提取 3-5 个本章有代表性的句式，标注其修辞功能）

## 章节小结
<2-3 句话的精炼总结，用于携带进下一章的上下文>
```

写完后，向用户简要汇报本章的核心发现。

然后继续下一章。

### Step 4：全文总结

所有章节读完后，用 `write_file` 写入全文总结：

**路径**：`docs/analysis/<pdf_stem>/summary.md`

**内容结构**：

```markdown
# <论文标题> — 精读总结

## 论文概览
<一段话概括论文的研究问题、方法、核心贡献>

## 各章要点回顾
### <章节1标题>
<2-3 句精炼回顾>
### <章节2标题>
...

## 核心贡献与创新点
- <贡献 1>
- <贡献 2>

## 方法论评价
<方法的优势、局限性、适用场景>

## 实验评价
<实验设计是否充分、结果是否支持结论、有无遗漏的对比>

## 图表使用评价
<哪些图表最有价值、哪些可以改进、图文配合是否得当>

## 写作与结构评价
<论文的组织逻辑、论证链条、语言质量>

## 延伸思考
<可能的改进方向、与相关工作的联系、对读者的启发>
```

## 上下文管理策略（关键）

论文内容量大，DeepSeek 上下文窗口为 128K tokens。必须严格控制：

1. **逐章获取**：每次只用 `markdown_chunker(chapter_selector=N)` 获取一章的 blocks，绝不一次获取全部
2. **先写后读下一章**：每章分析完后，先用 `write_file` 写入 analysis.md，再获取下一章的 blocks。这样你的分析已经持久化，不依赖对话历史
3. **章节小结传递**：每章分析末尾的「章节小结」（2-3 句话）就是你带入下一章的"记忆"
4. **不要回头重读**：除非用户明确要求，不重新获取已读章节的 blocks
5. **图片用 `analyze_image`**：该工具内部处理 base64，只返回文字结果，不会撑爆上下文
6. **控制单章 block 量**：如果某章 block 数量特别多（>30），可以用 `chapter_selector` 配合小节标题分批获取

## 输出目录结构

```
docs/analysis/<pdf_stem>/
├── progress.json                       # 进度文件（断点续跑依据）
├── decision_log.md                     # 图表决策日志（可审计）
├── summary.md                          # 全文总结
└── chapters/
    ├── 01_introduction/
    │   └── analysis.md                 # 第1章分析
    ├── 02_study-area/
    │   └── analysis.md
    ├── 03_methodology/
    │   └── analysis.md
    └── ...
```

## 降级路径

仅当以下情况才降级：
- `paper_parser` 失败
- `full_md_path` 为空或文件不存在

降级做法：
- 使用 `read_file` 直接读取 PDF 内容
- 明确告知用户：无法获取图片路径，因此无法进行图表多模态分析
- 仍然按章节结构组织分析，但精度会降低
