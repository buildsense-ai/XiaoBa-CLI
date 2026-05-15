# Step 04: 聚类可视化

## 目的

对整合后的细胞进行聚类分组，发现不同的细胞群体，并通过 UMAP/t-SNE 进行可视化。

## 触发条件

样本整合完成后。

## 执行流程

### 1. 构建邻居图

```python
import scanpy as sc

adata = sc.read_h5ad('03_integration/integrated.h5ad')

# 使用校正后的 PCA 或 scVI 嵌入
sc.pp.neighbors(adata, use_rep='X_pca', n_neighbors=15, n_pcs=50)
```

### 2. Leiden 聚类（推荐）

```python
# Leiden 聚类，多个分辨率
resolutions = [0.2, 0.4, 0.6, 0.8, 1.0]

for res in resolutions:
    sc.tl.leiden(adata, resolution=res, key_added=f'leiden_{res}')
```

### 3. UMAP 可视化

```python
# 计算 UMAP
sc.tl.umap(adata)

# 保存结果
adata.write('04_clustering/clustered.h5ad')
```

### 4. 可视化

```python
import matplotlib.pyplot as plt

# 按聚类着色
sc.pl.umap(adata, color='leiden_0.4', save='_clusters.png')

# 按样本着色（检查批次效应）
sc.pl.umap(adata, color='sample', save='_samples.png')

# 按 QC 指标着色（检查过滤效果）
sc.pl.umap(adata, color='pct_mito', save='_mito.png')
```

## 聚类参数选择

| 参数 | 默认值 | 调整依据 |
|------|--------|---------|
| n_neighbors | 15 | 大=大cluster，细分少；小=小cluster，细分多 |
| resolution | 0.4 | 大=多cluster；小=少cluster |
| n_pcs | 50 | 数据复杂时增大 |

## 聚类数量评估

### 肘部法则

```python
# 计算 silhouette score
from sklearn.metrics import silhouette_score
import numpy as np

scores = {}
for res in [0.2, 0.4, 0.6, 0.8, 1.0]:
    labels = adata.obs[f'leiden_{res}']
    score = silhouette_score(adata.obsm['X_umap'], labels)
    scores[res] = score
    n_clusters = len(labels.unique())
    print(f"Resolution {res}: {n_clusters} clusters, silhouette={score:.3f}")
```

### 推荐标准

| 细胞数 | 推荐分辨率 | 预期 cluster 数 |
|--------|-----------|----------------|
| < 5000 | 0.2-0.4 | 5-15 |
| 5000-20000 | 0.4-0.6 | 10-25 |
| > 20000 | 0.6-0.8 | 15-40 |

## 输出

- `clustered.h5ad`: 聚类结果
- `umap_clusters.png`: 聚类 UMAP 图
- `umap_samples.png`: 样本分布图

## Few-shot Examples

### Example 1: 正常聚类
```
Agent:
[执行聚类]

"【聚类完成】✓

Resolution 0.4 结果：
- 聚类数: 12 clusters
- Silhouette score: 0.72

主要 cluster：
- Cluster 0: 1,234 cells (16%)
- Cluster 1: 987 cells (13%)
- Cluster 2: 876 cells (11%)
- ...（共12个cluster）

正在生成可视化..."
```

### Example 2: cluster 过多
```
Agent:
[执行聚类]

"【聚类完成】⚠️

Resolution 0.4 结果：
- 聚类数: 45 clusters ⚠️
- 许多 cluster < 50 cells

建议：
1. 降低分辨率到 0.2-0.3
2. 或合并小 cluster

使用 resolution=0.2 重新聚类？"
```

### Example 3: 查看聚类质量
```
Agent:
[执行聚类]

"【聚类可视化】✓

观察 UMAP：
✓ 样本混匀（无明显批次效应）
✓ 主要细胞群体分离清晰
✓ 无明显混合的异常区域

下一步进行细胞注释..."
```

## 决策点

| 情况 | 判断 | 行动 |
|------|------|------|
| cluster 数 < 5 | 分辨率太低 | 提高 resolution |
| cluster 数 > 50 | 分辨率太高 | 降低 resolution |
| 某 cluster 极大 | 可能过度聚集 | 检查 marker |
| silhouette < 0.3 | 聚类质量差 | 检查整合效果 |
