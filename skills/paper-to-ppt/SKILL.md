---
name: paper-to-ppt
description: "论文精读转 PPT - 读取 paper-analysis 的精读产出，自动规划 PPT 结构，生成学术演示文稿"
invocable: user
argument-hint: "<paper_analysis_dir> [--theme academic|dark|minimal]"
---

# 论文精读转 PPT（Paper to Presentation）

## 核心理念

> **你是一个学术报告设计师，不是 Markdown 到 PPT 的格式转换器。**
>
> 你的工作不是把精读笔记原封不动搬到幻灯片上，而是像一个准备组会汇报的研究者那样：
> 理解论文核心贡献 → 提炼关键信息 → 设计叙事逻辑 → 用视觉化方式呈现。
> 每一页 PPT 都应该有明确的信息传达目标。

## 硬规则（Non-Negotiables）

1. **必须先读取精读产出** — 不凭空生成内容，所有 PPT 内容必须基于 paper-analysis 的产出文件
2. **大纲需要用户确认** — 生成 PPT 前必须先展示大纲，等用户确认/调整后再生成
3. **每页一个核心信息** — 不堆砌内容，每页幻灯片聚焦一个要点
4. **要点不超过 5 条** — 单页 bullet points 控制在 3-5 条，每条不超过 2 行
5. **图表必须有解读** — 插入论文图表时必须配上一句话解读，不能只放图
6. **不编造论文内容** — 所有内容必须来自精读产出，不添加原文没有的观点
7. **文件路径必须验证** — 插入图片前必须检查文件是否存在

## 可用工具

| 工具 | 用途 | 何时调用 |
|------|------|----------|
| `read_file` | 读取精读产出文件 | Phase 1 加载 summary.md 和各章 analysis.md |
| `pptx_generator` | 生成 .pptx 文件 | Phase 2 根据大纲生成 PPT |
| `analyze_image` | 分析论文图表内容 | 需要为图表生成解读文字时 |
| `write_file` | 写入大纲文件 | 保存 PPT 大纲供用户审阅 |

## 执行流程

### Phase 1：大纲规划

#### Step 1 — 加载精读产出

- 解析用户输入的 `$ARGUMENTS`，定位 paper-analysis 产出目录
- 读取 `summary.md` — 获取论文全局概览
- 读取 `chapters/` 下各章 `analysis.md` — 获取逐章分析
- 提取论文标题、作者、核心贡献、方法、实验结果、结论
- **读取 `progress.json`** — 获取 `full_md_path`，从中推导出论文图片目录（通常为 `extracted/<pdf_id>/images/`）
- **读取 `decision_log.md`** — 找到所有被 analyzed 的图片及其文件路径，这些是精读时确认有价值的核心图表
- 用 `glob` 或 `read_file` 验证图片文件是否存在，建立可用图片清单（路径 → Figure 编号 + caption 的映射）

> **关键**：论文原图在 `extracted/<pdf_id>/images/` 目录下，不在精读产出目录中。必须通过 progress.json 的 full_md_path 定位到 extracted 目录。

#### Step 2 — 设计 PPT 大纲

- 基于精读内容，规划 10-15 页 PPT，推荐结构：

| 页码 | 布局 | 内容 |
|------|------|------|
| 1 | `title` | 论文标题 + 作者信息 |
| 2 | `content` | 研究背景与动机（Why） |
| 3 | `content` | 研究问题与目标（What） |
| 4 | `section_header` | 方法论章节分隔 |
| 5-7 | `content` / `image_text` | 方法详解（含关键图表） |
| 8 | `section_header` | 实验结果章节分隔 |
| 9-11 | `image_text` / `two_column` | 实验结果与分析 |
| 12 | `content` | 讨论与局限性 |
| 13 | `content` | 结论与未来工作 |
| 14 | `content` | 个人评价 / 批判性思考 |

- 以上仅为推荐模板，应根据论文实际内容灵活调整
- 为每页写一句话描述其信息传达目标

#### Step 3 — 展示大纲，等待用户确认

- 将大纲保存到 `outline.md`
- 向用户展示大纲摘要，包括：
  - 总页数和各页标题
  - 哪些页面会插入图表
  - 使用的配色主题
- **暂停等待用户确认**，提示用户可以：
  - 直接生成 PPT
  - 调整页面顺序、增删页面
  - 修改某页的内容要点
  - 切换配色主题（academic / dark / minimal）

### Phase 2：PPT 生成

#### Step 4 — 构造 slides JSON

- 按确认后的大纲，逐页构造 `pptx_generator` 所需的 slides 数组
- 对每页：
  - 选择合适的 layout（title / content / section_header / two_column / image_text）
  - 从精读产出中提炼该页的标题和要点（精简、不照搬原文）
  - **优先使用 `image_text` 布局展示核心图表**：方法架构图、实验结果图、性能对比图等在 decision_log 中标记为 analyzed 的图片，必须以 `image_text` 布局嵌入 PPT，配上精读中的解读文字
  - 插入图片时使用 Step 1 中验证过的绝对路径或相对于工作目录的路径
- 构造完整的 JSON 参数对象

#### Step 5 — 调用 pptx_generator 生成

- 调用 `pptx_generator` tool，传入 slides JSON 和配色主题
- 输出路径：`docs/ppt/<paper_slug>.pptx`

#### Step 6 — 交付

- 向用户展示生成结果：
  - PPT 文件路径
  - 总页数
  - 使用的配色主题
- 提示用户可以用 PowerPoint / WPS 打开查看和进一步编辑

## 输出目录结构

```
docs/ppt/
├── <paper_slug>.pptx      # 生成的 PPT 文件
└── <paper_slug>/
    └── outline.md          # PPT 大纲（Phase 1 产出）
```

## pptx_generator 调用示例

以下是一个完整的 `pptx_generator` 调用 JSON，展示各种布局的用法：

```json
{
  "output_path": "docs/ppt/attention-is-all-you-need.pptx",
  "theme": "academic",
  "slides": [
    {
      "layout": "title",
      "title": "Attention Is All You Need",
      "subtitle": "Vaswani et al. | NeurIPS 2017 | Google Brain"
    },
    {
      "layout": "content",
      "title": "研究背景与动机",
      "bullets": [
        "序列转录任务长期依赖 RNN/LSTM 架构，存在并行化瓶颈",
        "注意力机制已被证明有效，但通常作为 RNN 的辅助组件",
        "核心问题：能否完全抛弃循环结构，仅用注意力机制建模序列？"
      ]
    },
    {
      "layout": "section_header",
      "title": "方法论：Transformer 架构",
      "subtitle": "Self-Attention + Position Encoding + Feed-Forward"
    },
    {
      "layout": "image_text",
      "title": "Transformer 整体架构",
      "image_path": "docs/analysis/attention/chapters/images/fig1_architecture.png",
      "bullets": [
        "编码器-解码器结构，各 6 层堆叠",
        "每层包含 Multi-Head Attention + Feed-Forward",
        "残差连接 + Layer Normalization"
      ]
    },
    {
      "layout": "two_column",
      "title": "实验结果：机器翻译",
      "left_title": "EN-DE",
      "left_bullets": [
        "BLEU 28.4（新 SOTA）",
        "训练成本仅为 ConvS2S 的 1/4"
      ],
      "right_title": "EN-FR",
      "right_bullets": [
        "BLEU 41.0（新 SOTA）",
        "单模型超越所有集成模型"
      ]
    },
    {
      "layout": "content",
      "title": "结论与未来工作",
      "bullets": [
        "Transformer 证明纯注意力架构可替代 RNN/CNN",
        "训练速度大幅提升，易于并行化",
        "未来方向：应用于图像、音频等非文本模态"
      ]
    }
  ]
}
```

## 与其他 Skill 的衔接

### ← paper-analysis（上游：精读产出）

- 本 skill 的**唯一数据来源**是 `paper-analysis` 的产出目录
- 依赖的文件：`summary.md`、`chapters/<NN>_<slug>/analysis.md`、图片文件
- 如果精读产出不完整（如缺少 summary.md），应提示用户先完成精读

### ← critical-reading（可选上游：批判性评价）

- 如果用户对该论文执行过 `/critical-reading`，可从批判产出中提取"优势与局限"作为 PPT 最后一页的个人评价内容
- 非必须依赖，缺少时跳过个人评价页或仅基于精读产出生成

### ← literature-review（可选上游：文献综述）

- 如果论文来自 `/literature-review` 的推荐精读列表，可在封面页副标题中标注其在文献地图中的定位
- 可从 `paper_pool.json` 中获取该论文的主题归属和一句话定位

## 上下文管理策略

paper-to-ppt 的上下文压力相对可控（通常只涉及一篇论文的精读产出），但仍需注意：

1. **先读 summary.md，再按需读章节** — 不要一次性加载所有 analysis.md，先从 summary 获取全局视图，再根据大纲需要选择性读取特定章节
2. **图片路径收集与内容分离** — 扫描目录时只记录图片路径列表，不立即调用 `analyze_image`，等大纲确认后再对需要的图片生成解读
3. **大纲确认后再构造 JSON** — Phase 1 产出大纲文本即可，不要提前构造完整 slides JSON，等用户确认后再进入 Phase 2
4. **slides JSON 逐页构造** — 不要试图一次性在内存中构造所有页面的完整 JSON，逐页提炼内容并追加到数组中