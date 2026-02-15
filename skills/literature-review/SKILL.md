---
name: literature-review
description: "系统性文献综述 - 给定研究主题，自动搜索、滚雪球扩展、筛选评分、主题聚类，生成结构化文献地图和综述文档。输出 paper_pool.json 供 paper-analysis / sci-paper-writing 消费"
invocable: user
argument-hint: "<研究主题> [--resume] [--phase2]"
---

# 系统性文献综述（Literature Review）

## 核心理念

> **你是一个系统性文献综述研究员，不是搜索引擎的前端。**
>
> 你的工作不是简单地把搜索结果罗列出来，而是像一个真正的研究者那样：
> 带着研究问题去搜索 → 从结果中识别种子论文 → 沿引用链滚雪球扩展 →
> 筛选去噪 → 按主题组织 → 综合叙述每个主题的研究脉络。

## 硬规则（Non-Negotiables）

1. **不编造论文** — 所有论文必须来自 `search_papers` 或 `paper_detail` 的真实返回结果
2. **不伪造引用数据** — citationCount、year、authors 等字段直接使用 API 返回值，不推测
3. **搜索必须多轮** — 至少 2 轮不同关键词组合，避免单一关键词的偏见
4. **滚雪球有边界** — 1 跳 + 推荐，不做 2 跳以上的引用链追踪
5. **去重是强制的** — 以 paperId 为主键去重，合并来自不同搜索轮次的同一论文
6. **主题聚类必须有依据** — 基于论文的 fieldsOfStudy、abstract 关键词、方法论相似性聚类，不凭空分类
7. **progress.json 必须维护** — 每完成一个步骤立即更新，支持 `--resume` 断点续做
8. **Phase 2 需要用户确认** — Phase 1 完成后必须暂停，等用户确认/调整后才进入 Phase 2
9. **paper_pool.json 是核心产出** — 格式必须稳定，供下游 skill 消费

## 可用工具

| 工具 | 用途 | 何时调用 |
|------|------|----------|
| `search_papers` | 搜索论文（Semantic Scholar / arXiv） | Phase 1 多轮搜索阶段 |
| `paper_detail(action=detail)` | 获取单篇论文详情（含 tldr） | 对种子论文补充详情 |
| `paper_detail(action=citations)` | 获取引用该论文的论文 | 滚雪球：前向追踪 |
| `paper_detail(action=references)` | 获取该论文引用的论文 | 滚雪球：后向追踪 |
| `paper_detail(action=recommend)` | 获取相似论文推荐 | 滚雪球：语义扩展 |
| `write_file` | 写入输出文件 | 每个步骤完成后写入产出 |
| `read_file` | 读取已有文件 | `--resume` 时加载 progress.json |

## 脚本调用方式

本 skill 的 Python 脚本位于 `skills/literature-review/` 目录下，通过 `execute_shell` 调用。

**search_papers**（搜索论文）：
```bash
python skills/literature-review/search_tool.py '{"query": "<关键词>", "source": "semantic_scholar", "limit": 30}'
```

**paper_detail**（论文详情/引用/推荐）：
```bash
python skills/literature-review/paper_detail_tool.py '{"action": "detail", "paper_id": "<paper_id>"}'
python skills/literature-review/paper_detail_tool.py '{"action": "citations", "paper_id": "<paper_id>", "limit": 20}'
python skills/literature-review/paper_detail_tool.py '{"action": "references", "paper_id": "<paper_id>", "limit": 20}'
python skills/literature-review/paper_detail_tool.py '{"action": "recommend", "paper_id": "<paper_id>", "limit": 10}'
```

所有脚本接收 JSON 字符串作为参数，返回 JSON 结果到 stdout。

## 执行流程

### Phase 1：文献地图（Literature Map）

#### Step 1 — 初始化

- 解析用户输入的研究主题 `$ARGUMENTS`
- 检查 `--resume` 标志：若有则读取 `progress.json` 恢复状态，跳到上次未完成的步骤
- 检查 `--phase2` 标志：若有则直接跳到 Phase 2（Step 8）
- 创建输出目录 `docs/literature-review/<topic_slug>/`
- 初始化 `progress.json`，记录主题和创建时间

#### Step 2 — 多轮搜索

- **Round 1（主题搜索）**：用用户原始主题作为关键词，分别在 Semantic Scholar 和 arXiv 搜索，每次 `limit=30`
- **Round 2（变体搜索）**：基于 Round 1 结果中高频出现的术语，构造 2-3 组同义词/变体关键词再搜索
- **Round 3（方法搜索）**：如果研究主题涉及特定方法论，用方法名 + 应用领域组合搜索
- 每轮搜索后立即将结果追加到内存中的候选池，并更新 `search_log.md`
- 总搜索量控制在 100-200 篇范围内
- 每轮搜索完成后更新 `progress.json` 中 `phase1.steps.search`

#### Step 3 — 种子论文筛选

- 从候选池中按以下规则筛选种子论文（10-15 篇）：
  - 引用量 Top-N（领域内的 seminal papers）
  - 最近 2-3 年的高相关论文（recent advances）
  - 多轮搜索中重复出现的论文（交叉验证的高相关性）
- 对种子论文调用 `paper_detail(action=detail)` 补充 tldr 和完整摘要
- 更新 `progress.json` 中 `phase1.steps.seed_selection`

#### Step 4 — 1跳滚雪球

- 对每篇种子论文依次执行（逐个处理，避免上下文爆炸）：
  - `paper_detail(action=citations, limit=20)` — 谁引用了它（前向追踪）
  - `paper_detail(action=references, limit=20)` — 它引用了谁（后向追踪）
  - `paper_detail(action=recommend, limit=10)` — 语义相似推荐
- 将滚雪球结果合并到候选池
- 以 `paperId` 为主键去重，合并来自不同来源的同一论文
- 每处理完一个种子论文，更新 `progress.json` 中 `phase1.steps.snowballing`（记录 seeds_processed / seeds_total）
- 更新 `search_log.md` 记录每个种子论文的滚雪球来源和新增论文数

#### Step 5 — 筛选评分

- 对候选池中所有论文进行评分（分批加载，每批 10-15 篇 abstract，评完写入分数后释放）
- 评分维度：
  - **相关性**（0-5）：基于 abstract 与研究主题的语义匹配度
  - **影响力**（0-5）：基于 citationCount 在该领域的相对排名
  - **时效性**（0-5）：越近的论文得分越高，5年内满分递减
  - **综合分** = 相关性×0.5 + 影响力×0.3 + 时效性×0.2
- 按综合分排序，保留 Top-50 进入最终论文池
- 标记 `recommended_for_deep_read: true` 的论文（Top-10，建议用户后续用 `/paper-analysis` 精读）
- 更新 `progress.json` 中 `phase1.steps.scoring`

#### Step 6 — 主题聚类

- 基于以下信号将论文分组为 3-7 个主题簇：
  - `fieldsOfStudy` 字段
  - abstract 中的高频方法/概念关键词
  - 引用关系（互相引用的论文倾向于同一主题）
- 为每个主题簇命名并写一句话描述
- 每篇论文标注所属主题（允许一篇论文属于多个主题）
- 仅加载 paper_pool 中的结构化字段（不加载完整 abstract），基于 fieldsOfStudy + 关键词聚类
- 更新 `progress.json` 中 `phase1.steps.clustering`

#### Step 7 — 输出 Phase 1 产出

- 写入 `paper_pool.json`（核心数据文件，格式见下方"核心数据格式"章节）
- 写入 `literature_map.md`（人类可读的文献地图，格式见下方"literature_map.md 输出格式"章节）
- 写入 `search_log.md`（搜索过程记录：每轮关键词、结果数、来源）
- 更新 `progress.json`，标记 Phase 1 完成
- **向用户展示文献地图摘要，包括：**
  - 论文池总数、主题簇数量
  - 每个主题簇的名称和论文数
  - Top-10 推荐精读论文列表
  - 初步观察到的研究趋势和潜在 Gap
- **暂停等待用户确认**，提示用户可以：
  - 直接进入 Phase 2（综述写作）
  - 调整主题分组或删除/添加论文后再进入 Phase 2
  - 选择部分论文用 `/paper-analysis` 精读后再继续

### Phase 2：综述写作（Literature Review）

> 用户通过 `--phase2` 或在 Phase 1 完成后确认进入

#### Step 8 — 加载文献地图

- 读取 `paper_pool.json` 和 `literature_map.md`
- 如果用户在 Phase 1 后做了调整（删除/添加论文、修改主题分组），以最新文件为准
- 验证数据完整性：确保每篇论文都有 paperId、title、themes 字段
- 更新 `progress.json`，标记 Phase 2 开始

#### Step 9 — 逐主题综述写作

- 创建 `themes/` 子目录
- 按主题簇顺序，对每个主题：
  - 加载该主题下所有论文的 abstract 和元数据（仅加载当前主题，写完释放再加载下一个）
  - 写综合叙述（**不是逐篇罗列**，而是按时间线/方法演进/观点对比组织）
  - 识别该主题内的共识、争议、未解决问题
  - 输出到 `themes/<NN>_<theme_slug>.md`
- 每写完一个主题，更新 `progress.json` 中对应 theme 的 status 为 done

#### Step 10 — 研究 Gap 分析

- 基于所有主题的综述，识别：
  - **研究空白**：哪些问题没人研究
  - **方法局限**：现有方法的共同短板
  - **数据缺口**：缺少哪类数据/实验
  - **潜在研究方向**：值得探索的新方向
- 更新 `progress.json` 中 `phase2.gap_analysis`

#### Step 11 — 生成完整综述文档

- 合并所有主题综述 + Gap 分析，生成 `review.md`，结构：
  1. **引言** — 研究问题 + 综述范围 + 方法论说明
  2. **各主题综述章节** — 从 `themes/*.md` 合并，保持叙述连贯
  3. **研究现状总结** — 跨主题的宏观总结
  4. **研究 Gap 与未来方向** — 从 Step 10 的分析整合
  5. **参考文献列表** — 所有引用论文的完整引用格式
- 更新 `progress.json`，标记 Phase 2 完成
- 向用户展示综述文档摘要和文件路径

## 输出目录结构

```
docs/literature-review/<topic_slug>/
├── progress.json          # 进度检查点（支持 --resume）
├── paper_pool.json        # 核心论文池（结构化数据，供下游 skill 消费）
├── search_log.md          # 搜索过程记录（每轮关键词、结果数、来源）
├── literature_map.md      # Phase 1 产出：文献地图（人类可读）
├── review.md              # Phase 2 产出：完整文献综述
└── themes/                # Phase 2 中间产出：逐主题综述
    ├── 01_<theme_slug>.md
    ├── 02_<theme_slug>.md
    └── ...
```

## 核心数据格式

### progress.json

```json
{
  "topic": "用户输入的研究主题",
  "topic_slug": "topic-slug-for-directory",
  "created_at": "2026-02-09T...",
  "phase": "phase1|phase2",
  "phase1": {
    "status": "pending|in_progress|done",
    "steps": {
      "search": { "status": "done", "rounds_completed": 3 },
      "seed_selection": { "status": "done", "seed_count": 12 },
      "snowballing": { "status": "in_progress", "seeds_processed": 5, "seeds_total": 12 },
      "scoring": { "status": "pending" },
      "clustering": { "status": "pending" },
      "output": { "status": "pending" }
    }
  },
  "phase2": {
    "status": "pending|in_progress|done",
    "themes": [
      { "index": 1, "name": "theme_name", "status": "pending|in_progress|done" }
    ],
    "gap_analysis": { "status": "pending" },
    "final_review": { "status": "pending" }
  },
  "stats": {
    "total_searched": 180,
    "after_snowball": 420,
    "after_dedup": 310,
    "final_pool": 50
  }
}
```

### paper_pool.json

```json
{
  "topic": "研究主题",
  "generated_at": "2026-02-09T...",
  "total": 50,
  "themes": [
    {
      "id": 1,
      "name": "主题名称",
      "description": "一句话描述",
      "paper_count": 15
    }
  ],
  "papers": [
    {
      "paperId": "abc123",
      "title": "Paper Title",
      "authors": ["Author A", "Author B"],
      "abstract": "摘要前500字...",
      "year": 2024,
      "citationCount": 128,
      "url": "https://...",
      "pdfUrl": "https://...",
      "venue": "NeurIPS",
      "fieldsOfStudy": ["Computer Science"],
      "source": "semantic_scholar",
      "discovered_via": "search_round1|snowball_citations|snowball_references|snowball_recommend",
      "seed_paper": false,
      "themes": [1, 3],
      "scores": {
        "relevance": 4.2,
        "impact": 3.8,
        "recency": 4.5,
        "overall": 4.2
      },
      "recommended_for_deep_read": true,
      "annotation": "XiaoBa 对该论文的一句话定位"
    }
  ]
}
```

## 与其他 Skill 的衔接

### → paper-analysis（精读）
- `paper_pool.json` 中 `recommended_for_deep_read: true` 的论文，用户可选择调用 `/paper-analysis` 精读
- 精读产出目录 `docs/analysis/<paper>/` 可反哺 Phase 2 的综述写作（更深入的理解）

### → critical-reading（批判）
- 精读后的论文可进一步调用 `/critical-reading` 进行批判性评估
- 批判结果可帮助用户判断哪些论文的结论可信、哪些需要谨慎引用

### → sci-paper-writing（写作）
- `paper_pool.json` 可直接作为 `blueprint.md` 中 Reference Papers 的数据来源
- `review.md` 的 Gap 分析可直接输入到 blueprint 的 Research Context
- `themes/*.md` 的综述内容可作为 Related Work 章节的初稿

## 上下文管理策略（关键）

literature-review 的特殊挑战：论文池可能有 50+ 篇论文，每篇都有 abstract，全部加载会爆上下文。

1. **搜索阶段**：每轮搜索结果处理完后，仅保留结构化摘要（paperId + title + year + citationCount），释放 abstract
2. **滚雪球阶段**：逐个种子论文处理，处理完一个写入文件后再处理下一个
3. **评分阶段**：分批加载论文 abstract 进行评分（每批 10-15 篇），评完写入分数后释放
4. **聚类阶段**：仅加载 paper_pool.json 中的结构化字段（不加载 abstract），基于 fieldsOfStudy + 关键词聚类
5. **Phase 2 写作**：逐主题加载该主题下论文的 abstract，写完一个主题后释放再加载下一个
6. **全程依赖文件**：不依赖对话历史中的论文数据，所有中间结果写入文件

## literature_map.md 输出格式

```markdown
# 文献地图：<研究主题>

> 生成时间：YYYY-MM-DD | 论文池：N 篇 | 主题簇：M 个

## 搜索概况
- 搜索轮次：3 轮（主题搜索 / 变体搜索 / 方法搜索）
- 原始候选：X 篇 → 滚雪球后：Y 篇 → 去重后：Z 篇 → 最终入池：N 篇

## 主题概览

### 主题 1：<名称>（K 篇）
<一段话描述该主题的研究脉络>

**核心论文：**
| # | 论文 | 年份 | 引用 | 定位 |
|---|------|------|------|------|
| 1 | Title (Author et al.) | 2024 | 128 | 一句话定位 |

### 主题 2：...

## 推荐精读论文（Top-10）
| # | 论文 | 综合分 | 推荐理由 |
|---|------|--------|----------|
| 1 | Title | 4.8 | 该领域奠基性工作，被引 500+ |

## 初步观察
- 研究趋势：...
- 潜在 Gap：...
- 建议下一步：...
```
