# Step 03: 样本整合

## 目的

合并多个样本的数据，校正批次效应，使细胞按生物学状态而非技术来源聚类。

## 触发条件

SCTransform 完成后，或用户确认参数时。

## 方法选择

| 方法 | 适用场景 | 优点 | 缺点 |
|------|---------|------|------|
| Harmony | 通用，<10万细胞 | 快速、CPU友好 | 可能过度校正 |
| scVI | <5万细胞，效果最好 | 深度学习，效果好 | 需要GPU |
| BBKNN | >10万细胞 | 极快 | 分辨率略低 |
| Seurat CCA | 异质性数据 | 保留生物变异 | 计算量大 |

## 执行流程

### 1. Harmony 整合（推荐）

```python
import scanpy as sc
import harmonypy as hm

adata = sc.read_h5ad('02_sct/sct.h5ad')

# PCA
sc.tl.pca(adata, svd_solver='arpack')

# Harmony 整合
ho = hm.run_harmony(adata.obsm['X_pca'], adata.obs, ['sample'])

# 替换 PCA 坐标
adata.obsm['X_pca'] = ho.Z_corr.T

# UMAP
sc.pp.neighbors(adata, use_rep='X_pca')
sc.tl.umap(adata)
```

### 2. scVI 整合

```python
import scvi

scvi.settings.seed = 42

# 设置 upRNA 数据
scvi.model.SCVI.setup_anndata(adata, layer='counts', batch_key='sample')

# 训练模型
model = scvi.model.SCVI(adata)
model.train()

# 获取潜在空间
adata.obsm['X_scVI'] = model.get_latent_representation()

# 基于 scVI 的邻居和 UMAP
sc.pp.neighbors(adata, use_rep='X_scVI')
sc.tl.umap(adata)
```

### 3. BBKNN 整合

```python
import scanpy as sc
import bbknn

adata = sc.read_h5ad('02_sct/sct.h5ad')

# PCA
sc.tl.pca(adata, svd_solver='arpack')

# BBKNN 邻居
bbknn.knn_graph(adata, batch_key='sample')

# UMAP
sc.tl.umap(adata)
```

## 整合质量评估

### 检查批次校正效果

```python
# 批次混匀度（越接近 0越好）
from scib.metrics import silhouette

batch_score = silhouette(adata, batch_key='sample', embed='X_pca')

# 生物保存度（越接近 1越好）
bio_score = silhouette(adata, group_key='cell_type', embed='X_pca')

print(f"批次效应校正评分: {batch_score:.3f}")
print(f"生物变异保存评分: {bio_score:.3f}")
```

### 可视化检查

```python
import scanpy as sc

# UMAP 按样本着色
sc.pl.umap(adata, color='sample', save='_by_sample.png')

# UMAP 按基因着色（检查 marker 是否分离）
sc.pl.umap(adata, color=['Cd3d', 'Cd79a', 'Adgre1'], save='_markers.png')
```

## 输出

- `integrated.h5ad`: 整合后的数据（包含 X_pca, X_umap）
- `batch_correction.png`: 批次校正前后对比图

## Few-shot Examples

### Example 1: Harmony 整合
```
Agent:
[执行整合]

"【样本整合完成】✓

方法: Harmony
批次变量: sample

校正效果：
- 校正前各样本明显分离 ⚠️
- 校正后样本混匀 ✓
- 细胞按生物学特征聚类

正在进行聚类可视化..."
```

### Example 2: 整合效果差
```
Agent:
[执行整合]

"【样本整合】⚠️

警告：批次校正效果不理想

问题：
- 校正后样本仍有明显分离
- 可能是批次效应太强或生物学差异大

建议：
1. 检查样本制备是否有系统差异
2. 考虑用 scVI（需要 GPU）
3. 或降低 Harmony theta 参数

继续尝试聚类？"
```

## 决策点

| 情况 | 判断 | 行动 |
|------|------|------|
| 样本在 UMAP 上分离 | 批次效应 | 重新整合或调整参数 |
| 样本完全混合 | 正常 | 继续聚类 |
| 只有 1 个样本 | 无需整合 | 跳过整合 |
