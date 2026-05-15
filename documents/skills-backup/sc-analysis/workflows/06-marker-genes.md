# Step 06: Marker 基因鉴定

## 目的

识别每个细胞类型的特征基因，用于后续分析和验证细胞注释。

## 触发条件

细胞注释完成后，或用户要求"找 marker"时。

## 执行流程

### 1. 计算差异表达基因

```python
import scanpy as sc
import pandas as pd

adata = sc.read_h5ad('05_annotation/annotated.h5ad')

# 使用 Wilcoxon 检验
sc.tl.rank_genes_groups(
    adata,
    groupby='cell_type',  # 或 'leiden_0.4'
    method='wilcoxon',
    key_added='rank_genes'
)

# 获取结果
result = adata.uns['rank_genes']
groups = result['names'].dtype.names

# 转换为 DataFrame
marker_list = []
for group in groups:
    group_dict = result['names'][group][:50]  # 每个 cluster 取前 50
    scores = result['scores'][group][:50]
    pvals = result['pvals_adj'][group][:50]
    logfc = result['logfoldchanges'][group][:50]
    
    for i, gene in enumerate(group_dict):
        marker_list.append({
            'cluster': group,
            'gene': gene,
            'score': scores[i],
            'pvalue_adj': pvals[i],
            'log2FC': logfc[i]
        })

markers_df = pd.DataFrame(marker_list)
markers_df.to_csv('06_markers/markers.csv', index=False)
```

### 2. 筛选显著 marker

```python
# 筛选标准
significant_markers = markers_df[
    (markers_df['pvalue_adj'] < 0.05) &
    (markers_df['log2FC'] > 0.25) &
    (markers_df['score'] > 1.0)
]

# 每个 cluster 取 top 20
top_markers = significant_markers.groupby('cluster').head(20)
top_markers.to_csv('06_markers/top_markers.csv', index=False)
```

### 3. 可视化

```python
import matplotlib.pyplot as plt

# 热图
sc.pl.rank_genes_groups_heatmap(
    adata,
    n_genes=10,
    groupby='cell_type',
    save='_markers_heatmap.png'
)

# Dotplot（推荐）
sc.pl.rank_genes_groups_dotplot(
    adata,
    n_genes=10,
    groupby='cell_type',
    save='_markers_dotplot.png'
)

# Violin plot
sc.pl.rank_genes_groups_stacked_violin(
    adata,
    n_genes=5,
    groupby='cell_type',
    save='_markers_violin.png'
)
```

## Marker 筛选标准

| 参数 | 推荐值 | 说明 |
|------|--------|------|
| pvalue_adj | < 0.05 | FDR 校正后 p 值 |
| log2FC | > 0.25 | 至少 1.2 倍差异 |
| min_pct | 0.1 | 至少 10% 细胞表达 |
| score | > 1.0 | Wilcoxon 统计量 |

## 输出

- `markers.csv`: 所有 marker 基因
- `top_markers.csv`: 筛选后的 top marker
- `markers_heatmap.png`: 热图
- `markers_dotplot.png`: Dotplot

## Few-shot Examples

### Example 1: 正常结果
```
Agent:
[计算 marker]

"【Marker 鉴定完成】✓

共鉴定到 1,234 个显著 marker（p<0.05, log2FC>0.25）

Top marker 展示：

T cells:
1. CD3D (score=156.2)
2. TRAC (score=142.8)
3. IL7R (score=128.5)

B cells:
1. CD79A (score=189.3)
2. MS4A1 (score=167.2)
3. IGHM (score=145.1)

Macrophages:
1. ADGRE1 (score=134.5)
2. C1QA (score=121.3)
3. C1QB (score=118.7)

正在生成可视化..."
```

### Example 2: Marker 不足
```
Agent:
[计算 marker]

"【Marker 鉴定】⚠️

问题：
- 部分 cluster marker 数量过少
- Cluster 8: 只有 12 个显著 marker
- Cluster 10: 没有显著 marker

可能原因：
1. Cluster 太小（<50 cells）
2. Cluster 可能是 doublet
3. 注释可能需要调整

建议：
1. 检查 Cluster 8 和 10 的细胞数
2. 查看是否需要调整注释

要继续差异分析吗？"
```

## 决策点

| 情况 | 判断 | 行动 |
|------|------|------|
| marker 基因太少 | cluster 可能不准 | 检查 cluster 质量 |
| 某类型 marker 太相似 | cluster 可能需要合并 | 考虑合并相似 cluster |
| 新的高特异性 marker | 发现新的 marker | 标记为潜在新 marker |
