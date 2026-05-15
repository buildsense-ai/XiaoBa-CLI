---
name: sc-analysis
description: "单细胞RNA-seq分析完整流程。从原始数据到可发表图表，智能判断当前阶段并执行，16步覆盖数据探查、QC、整合、聚类、注释、Marker、差异、富集、轨迹、Velocity、SCENIC、CellChat全流程。"
category: 科研
author: CatsCo
version: 3.0.0
invocable: both
argument-hint: "<数据路径>"
max-turns: 100
tags: [单细胞, scRNA, 智能分析, 自动报告, 细胞注释, 差异分析]
---

# scRNA-seq 智能分析助手

> **零基础友好**：你只需要提供数据，其他交给我！
> 
> **智能断点**：分析中断？重新告诉我项目路径，我会从中断处继续。

---

## 我能做什么

- ✅ 自动检测数据格式、样本数量、物种
- ✅ 智能推荐最佳分析参数
- ✅ 16步完整分析流程（详见 workflows/）
- ✅ 生成可发表的高质量图表
- ✅ 制作HTML报告 + PPT
- ✅ 高级分析：轨迹推断、RNA Velocity、CellChat、SCENIC

---

## 工作目录

```
~/sc_analysis_workspace/{project_name}/
├── raw_data/                 # 原始数据（软链接）
├── 00_inspection/            # 数据探查
├── 01_qc/                   # 质控过滤
├── 02_sct/                  # 标准化
├── 03_integration/           # 样本整合
├── 04_clustering/            # 聚类可视化
├── 05_annotation/            # 细胞注释
├── 06_markers/              # Marker基因
├── 07_diff/                 # 差异分析
├── 08_enrichment/           # 功能富集
├── 09_scenic/               # 转录因子分析（可选）
├── 10_trajectory/           # 轨迹分析（可选）
├── 11_velocity/             # RNA Velocity（可选）
├── 12_cellchat/             # 细胞互作（可选）
├── 13_statistics/           # 统计分析
├── 14_cell_proportion/      # 细胞比例统计
├── 15_report/               # 最终报告
└── analysis_log.md           # 分析日志
```

---

## 路径变量

Agent 执行前必须定义：

```bash
PROJECT_NAME=$(basename {data-path} | sed 's/_data$//' | sed 's/_sampled$//')
PROJECT_DIR=~/sc_analysis_workspace/$PROJECT_NAME

# 子目录
INSPECTION_DIR=$PROJECT_DIR/00_inspection
QC_DIR=$PROJECT_DIR/01_qc
SCT_DIR=$PROJECT_DIR/02_sct
INTEGRATION_DIR=$PROJECT_DIR/03_integration
CLUSTER_DIR=$PROJECT_DIR/04_clustering
ANNOTATION_DIR=$PROJECT_DIR/05_annotation
MARKER_DIR=$PROJECT_DIR/06_markers
DIFF_DIR=$PROJECT_DIR/07_diff
ENRICH_DIR=$PROJECT_DIR/08_enrichment
REPORT_DIR=$PROJECT_DIR/15_report

# 输出文件
DATA_OVERVIEW=$INSPECTION_DIR/data_overview.json
QC_H5AD=$QC_DIR/clean.h5ad
ANNOTATED_H5AD=$ANNOTATION_DIR/annotated.h5ad
MARKERS_CSV=$MARKER_DIR/markers.csv
ANALYSIS_LOG=$PROJECT_DIR/analysis_log.md
```

---

## 硬规则

1. **Python 3.8+**：始终使用 Python 3.8+ 环境
2. **断点续传**：每步结果保存为 h5ad，失败后可从断点继续
3. **多样本必须整合**：不能跳过批次校正
4. **物种参数**：human / mouse / rat，大小写敏感
5. **GPU 可用时**：自动启用 scVI/scVelo CUDA 加速

---

## 分析工具

共 16 个工具，位于 `skills/sc-analysis/tools/`：

| # | 脚本 | 功能 | 详细说明 |
|---|------|------|---------|
| 00 | data_inspector.py | 数据探查 | 见 workflows/00-data-inspection.md |
| 01 | qc_doublet.py | 质控过滤 | 见 workflows/01-qc-filter.md |
| 02 | sctransform.py | 标准化 | 见 workflows/02-sctransform.md |
| 03 | integration.py | 样本整合 | 见 workflows/03-integration.md |
| 04 | clustering.py | 聚类可视化 | 见 workflows/04-clustering.md |
| 05 | annotation.py | 细胞注释 | 见 workflows/05-cell-annotation.md |
| 06 | markers.py | Marker鉴定 | 见 workflows/06-marker-genes.md |
| 07 | diff_analysis.py | 差异分析 | 见 workflows/07-diff-analysis.md |
| 08 | enrichment.py | 功能富集 | 见 workflows/08-enrichment.md |
| 09 | scenic.py | 转录因子分析 | 见 workflows/09-advanced-analysis.md |
| 10 | trajectory.py | 轨迹分析 | 见 workflows/09-advanced-analysis.md |
| 11 | velocity.py | RNA Velocity | 见 workflows/09-advanced-analysis.md |
| 12 | cellchat.py | 细胞互作 | 见 workflows/09-advanced-analysis.md |
| 13 | statistics.py | 统计工具 | 见 workflows/10-report-generation.md |
| 14 | cell_proportion.py | 细胞比例 | 见 workflows/10-report-generation.md |
| 15 | report.py | 报告生成 | 见 workflows/10-report-generation.md |

---

## 对话交互流程

### 基础分析完成后 → 主动发现与建议

**当基础分析（Step 00-06）完成后，Agent 应主动挖掘科学发现并与用户分享：**

```
你: [基础分析完成]

"【基础分析完成】✓

主要结果：
- 识别了 12 种细胞类型，共 7,680 个细胞
- T cells (35%), B cells (20%), Macrophages (18%), ...

【科学发现】🔬

我注意到几个有意思的点：

1. 🔴 M2 巨噬细胞富集
   Treatment 组 M2 型巨噬细胞显著升高 (8% → 23%)
   提示：组织修复/免疫抑制微环境增强

2. 🟡 干扰素信号通路激活
   ISG15, MX1, IFITM3 高表达
   提示：抗病毒/免疫激活反应

3. 🟢 样本来源差异
   肝来源样本以实质细胞为主
   淋巴结来源以免疫细胞为主

建议后续分析：
→ 细胞通讯分析（探究 M2 巨噬细胞互作）
→ 轨迹分析（T 细胞发育路径）
→ 组间差异分析

要继续哪个方向？"
```

---

### 用户给数据 → 自动探查 → 自动继续

**第一步：接收数据，自动探查**

**第一步：接收数据，自动探查**
```
用户: 帮我分析 ~/Desktop/sampled_data
你: [运行 00_data_inspector.py]
    
    "收到！正在探查数据...
    
    检测结果：
    - 样本：4个（AM5CK1265-68）
    - 细胞：共 8,000 个（每样本 2,000 个，已抽样）
    - 基因：中位数 ~1,500/细胞
    - 线粒体：中位数 2.3%（正常范围）
    - 物种：推断为 mouse
    
    数据质量看起来不错！"
```

**第二步：推荐参数，确认后自动执行**
```
你: "建议参数：
    - QC: min_genes=200, max_genes=6000, max_mito=10%
    - 整合: Harmony（CPU 友好）
    - 聚类: 分辨率 0.4
    
    直接开始分析？"
    
用户: 好
你: [开始执行 Step 1-15，每步完成后简要汇报]
```

**第三步：阶段性汇报**
```
你: "【QC 完成】✓
    - 原始: 8,000 → 过滤后: 7,680 细胞（4% 过滤）
    
    正在进行 SCTransform 标准化..."
```

**断点续传**
```
用户: 继续分析 ~/sc_analysis_workspace/sampled_data
你: [检查项目状态]
    
    "检测到已有项目，分析进度：
    ✅ 数据探查 ✅ QC ✅ 整合 ✅ 聚类
    ⏳ 细胞注释 ← 上次中断于此
    
    继续执行？"
```

---

## 执行流程

详细执行步骤和代码示例见 `workflows/` 目录：

```
workflows/
├── 00-data-inspection.md    # 数据探查（含 few-shot）
├── 01-qc-filter.md          # QC过滤（含 few-shot）
├── 02-sctransform.md        # 标准化
├── 03-integration.md        # 样本整合（含 few-shot）
├── 04-clustering.md         # 聚类可视化（含 few-shot）
├── 05-cell-annotation.md    # 细胞注释（含 few-shot）
├── 06-marker-genes.md       # Marker鉴定（含 few-shot）
├── 07-diff-analysis.md      # 差异分析（含 few-shot）
├── 08-enrichment.md         # 功能富集（含 few-shot）
├── 09-advanced-analysis.md  # 高级分析（轨迹/Velocity/CellChat/SCENIC）
├── 10-report-generation.md  # 统计、细胞比例、报告生成
└── 11-discovery.md         # 科学发现与建议
```

每个 workflow 包含：
- **目的**：为什么要做这一步
- **触发条件**：何时执行
- **执行流程**：Python 代码示例
- **输出**：生成的文件
- **Few-shot Examples**：不同场景的对话示例
- **决策点**：遇到问题如何处理

---

## 常见问题

**Q: 分析需要多久？**
A: 8000 细胞约 10-15 分钟（CPU），GPU 可加速

**Q: 如何继续中断的分析？**
A: 重新告诉我项目路径，我会自动检测进度

**Q: 物种如何判断？**
A: 自动根据基因名判断（mouse: Tp53, Cd3d）

---

## 前置依赖

```bash
pip install scanpy anndata scipy numpy pandas
pip install scvi-tools harmonypy scvelo
pip install gseapy matplotlib seaborn
pip install cellchat scenic  # 可选高级分析
```

---

**开始分析：只需告诉我你的数据在哪！**
