# Step 09-12: 高级分析

## 目的

提供可选的高级分析功能，包括轨迹分析、RNA Velocity、CellChat 细胞互作、SCENIC 转录因子分析。

---

## Step 09: 轨迹分析 (Trajectory Analysis)

### 目的

推断细胞的发育轨迹，探索细胞状态转换。

### 方法选择

| 方法 | 适用场景 | 优点 |
|------|---------|------|
| PAGA | 大数据集，粗略轨迹 | 快速，可视化好 |
| Monocle3 | 精确轨迹 | 支持分支 |
| Slingshot | 简单轨迹 | 易于使用 |
| Pseudotime | 连续状态 | 单调轨迹 |

### 执行流程

```python
import scanpy as sc
import scvelo as scv

adata = sc.read_h5ad('05_annotation/annotated.h5ad')

# 方法 A: PAGA
sc.tl.paga(adata, groups='cell_type')
sc.pl.paga(adata, plot=False)
sc.tl.umap(adata, init_pos='paga')

# 方法 B: Palantir (连续分化)
from palantir import Palantir

# 只选择感兴趣的细胞
stem_cells = adata[adata.obs['cell_type'].isin(['HSC', 'MPP', 'LMPP'])]
pr_res = Palantir.run_palantir(
    stem_cells,
    knn=30,
    n_components=5
)

# 添加 pseudotime
adata.obs['palantir_pseudotime'] = 'NaN'
adata.obs.loc[pr_res.ms_data.index, 'palantir_pseudotime'] = pr_res.pseudotime
```

### Few-shot
```
Agent:
[执行轨迹分析]

"【轨迹分析完成】✓

方法: PAGA

发现的主要轨迹：
1. HSC → MPP → Lymphoid (T cell trajectory)
2. HSC → MPP → Myeloid (Monocyte trajectory)

Pseudotime 范围: 0 - 100

关键分支点：
- Branch 1: T cell vs Myeloid 分化
- Branch 2: Monocyte vs DC 分化

正在进行可视化..."
```

---

## Step 10: RNA Velocity

### 目的

利用 unspliced/spliced mRNA 比例，推断基因表达方向和细胞未来状态。

### 执行流程

```python
import scvelo as scv

# 方法 A: 使用 loom 文件
adata = scv.read('velocity/possorted_genome_bam_*.loom')
adata.var_names_make_unique()

# 估计 RNA velocity
scv.pp.filter_and_normalize(adata)
scv.pp.moments(adata)
scv.tl.velocity(adata, mode='stochastic')
scv.tl.velocity_graph(adata)

# 计算 UMAP（基于 scVI 或已有点）
scv.tl.velocity_embedding(adata, basis='umap')

# 保存
adata.write('10_velocity/velocity.h5ad')
```

### Few-shot
```
Agent:
[执行 RNA Velocity]

"【RNA Velocity 完成】✓

分析结果：
- 整体分化方向: T cell trajectory 清晰
- 关键基因: Id2, Tcf7 表达变化明显
- 预测未来状态: 一群 progenitor 倾向于向 T cell 分化

可视化已保存到 10_velocity/velocity_stream.png
```

---

## Step 11: CellChat 细胞互作分析

### 目的

分析细胞间的配体-受体通讯，揭示细胞互作网络。

### 执行流程

```python
import cellchat as cc

# 准备数据
adata = sc.read_h5ad('05_annotation/annotated.h5ad')

# 创建 CellChat 对象
cellchat = cc.CellChat.create(adata, group.by='cell_type')

# 使用 mouse 配体-受体数据库
cellchat.use.database('mouse')

# 识别过表达的配体和受体
cellchat.identify_over_expressed_genes()
cellchat.identify_over_expressed_interactions()

# 计算通讯概率
cellchat.compute_comm_prob(force_recompute=True)

# 过滤显著通讯
cellchat.filter_dim(arguments.dim-1) # 按概率过滤
```

### Few-shot
```
Agent:
[执行 CellChat]

"【CellChat 分析完成】✓

显著细胞互作数: 127 对

主要通讯模式：
1. Macrophages → T cells: 免疫调节相关
   - CXCL12-CXCR4
   - IL10-IL10RA

2. T cells → B cells: 免疫激活
   - CD40-CD40LG
   - CD28-CD86

3. Endothelial → Fibroblasts: 组织稳态
   - VEGFA-FLT1

可视化已保存到 11_cellchat/ 目录
```

---

## Step 12: SCENIC 转录因子分析

### 目的

识别转录因子活性，揭示基因调控网络。

### 执行流程

```python
import scenic

# 步骤 1: 初始化
session = scenic.session_from_adatas([adata], adatas_names=['my_dataset'])

# 步骤 2: 过滤
scenic.add_filtering_filters(session, min_genes=10, min_cells=10)

# 步骤 3: 降维
scenic.add_dimensionality_reduction(session)

# 步骤 4: GENIE3 转录因子调控网络推断
scenic.add_grnboost2(session)

# 步骤 5: 注册分析
scenic.add_scoring(session)

# 步骤 6: 生成报告
scenic.create_report(session)
```

### Few-shot
```
Agent:
[执行 SCENIC]

"【SCENIC 分析完成】✓

识别到显著活性转录因子: 45 个

Top 转录因子：
1. SPI1 (Macrophages 特异性, AUC=0.89)
2. TBX21 (NK cells 特异性, AUC=0.85)
3. IRF4 (Activated T cells, AUC=0.82)
4. GATA3 (Th2 cells, AUC=0.78)

调控网络已保存到 12_scenic/ 目录
```

---

## 决策点

| 高级分析 | 何时做 | 前提条件 |
|---------|-------|---------|
| Trajectory | 探索细胞发育 | 有分化相关假设 |
| RNA Velocity | 需要预测未来状态 | 需要 loom 文件 |
| CellChat | 研究细胞互作 | 注释完成 |
| SCENIC | 找关键转录因子 | > 5000 cells |

## 输出

所有高级分析结果保存在对应目录：
- `09_trajectory/`: 轨迹分析结果
- `10_velocity/`: RNA Velocity 结果
- `11_cellchat/`: 细胞互作结果
- `12_scenic/`: 转录因子分析结果
