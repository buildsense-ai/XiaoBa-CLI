# Step 05: 细胞注释

## 目的

根据 marker 基因表达，给每个 cluster 分配细胞类型标签。

## 触发条件

聚类完成后，或用户要求"注释细胞"时。

## 方法

| 方法 | 适用场景 | 准确性 |
|------|---------|--------|
| 自动注释（已知组织） | 有成熟 marker 的组织 | 高 |
| SingleR | 无先验知识 | 中等 |
| 人工注释 | 所有情况 | 最高（需要人工确认） |

## 执行流程

### 1. 计算 cluster 的 marker 基因

```python
import scanpy as sc

adata = sc.read_h5ad('04_clustering/clustered.h5ad')

# 计算每个 cluster 的 marker
sc.tl.rank_genes_groups(adata, groupby='leiden_0.4', method='wilcoxon')
```

### 2. 自动注释（基于已知 marker）

```python
# 定义 marker 基因库
marker_genes = {
    'T cells': ['Cd3d', 'Cd3e', 'Trac'],
    'CD4+ T cells': ['Cd4', 'Il7r'],
    'CD8+ T cells': ['Cd8a', 'Cd8b1'],
    'NK cells': ['Nkg7', 'Gzma', 'Gzmb'],
    'B cells': ['Cd79a', 'Cd79b', 'Ms4a1'],
    'Macrophages': ['Adgre1', 'C1qa', 'C1qb'],
    'Monocytes': ['Ly6c2', 'Ccr2'],
    'Dendritic cells': ['Itgax', 'Itgae'],
    'Neutrophils': ['S100a8', 'S100a9', 'Csf3r'],
    'Mast cells': ['Cma1', 'Gata2'],
    'Endothelial cells': ['Pecam1', 'Cdh5'],
    'Fibroblasts': ['Col1a1', 'Col3a1', 'Pdgfra'],
    'Epithelial cells': ['Epcam', 'Krt8', 'Krt18'],
}

# 检查每个 cluster 的 marker 表达
for cluster in adata.obs['leiden_0.4'].unique():
    cluster_cells = adata[adata.obs['leiden_0.4'] == cluster]
    
    # 计算每个细胞类型的平均表达
    scores = {}
    for cell_type, markers in marker_genes.items():
        valid_markers = [m for m in markers if m in adata.var_names]
        if valid_markers:
            mean_expr = cluster_cells[:, valid_markers].X.mean()
            scores[cell_type] = mean_expr
    
    # 找到最高分的细胞类型
    best_match = max(scores, key=scores.get)
    
    print(f"Cluster {cluster}: {best_match} (score={scores[best_match]:.3f})")
```

### 3. SingleR 自动注释

```python
from celldex import MouseRNAseqData
import SingleR

# 加载参考数据
ref = MouseRNAseqData()

# 注释
pred = SingleR.SingleR(
    test=adata.X,
    ref=ref,
    labels=ref$main_types
)

# 添加到 obs
adata.obs['SingleR_pred'] = pred$labels
```

### 4. 人工确认和修正

```python
# 可视化关键 marker
sc.pl.umap(adata, color=['Cd3d', 'Cd79a', 'Adgre1', 'Nkg7'], 
           save='_key_markers.png')

# 显示每个 cluster 的 top marker
sc.pl.rank_genes_groups_dotplot(
    adata, 
    groupby='leiden_0.4',
    n_genes=5,
    save='_top_markers.png'
)

# 手动赋值
cell_type_map = {
    '0': 'T cells',
    '1': 'B cells',
    '2': 'Macrophages',
    '3': 'NK cells',
    '4': 'CD4+ T cells',
    '5': 'CD8+ T cells',
    # ...
}

adata.obs['cell_type'] = adata.obs['leiden_0.4'].map(cell_type_map)

# 保存
adata.write('05_annotation/annotated.h5ad')
```

## 输出

- `annotated.h5ad`: 带注释的数据
- `annotation.csv`: 注释结果表
- `dotplot_markers.png`: marker 表达图

## 常见细胞类型 marker

### 免疫细胞

| 细胞类型 | Marker | 说明 |
|---------|--------|------|
| T cells | CD3D, CD3E | 通用 T cell marker |
| CD4+ T | CD4, IL7R | 辅助 T 细胞 |
| CD8+ T | CD8A, CD8B1 | 细胞毒性 T 细胞 |
| Treg | FOXP3, IL2RA | 调节性 T 细胞 |
| NK | NKG7, GZMA | 自然杀伤细胞 |
| B cells | CD79A, MS4A1 | B 细胞 |
| Plasma | IGKC, JCHAIN | 浆细胞 |
| Mono | CD14, FCGR3A | 单核细胞 |
| Mac | ADGRE1, C1QA | 巨噬细胞 |
| DC | IRF4, CD1C | 树突状细胞 |
| Neutro | S100A8, S100A9 | 中性粒细胞 |

### 非免疫细胞

| 细胞类型 | Marker | 说明 |
|---------|--------|------|
| Endothelial | PECAM1, CDH5 | 内皮细胞 |
| Fibroblast | COL1A1, COL3A1 | 成纤维细胞 |
| Epithelial | EPCAM, KRT8 | 上皮细胞 |
| Myocyte | MYH1, MYH2 | 肌细胞 |
| Adipocyte | FABP4, PLIN1 | 脂肪细胞 |
| Hepatocyte | ALB, TTR | 肝细胞 |
| Neuron | RBFOX3, MAP2 | 神经元 |

## Few-shot Examples

### Example 1: 成功注释
```
Agent:
[执行注释]

"【细胞注释完成】✓

注释结果（12个cluster）：
- Cluster 0: T cells (1,234 cells) - Cd3d高表达
- Cluster 1: B cells (876 cells) - Cd79a高表达
- Cluster 2: Macrophages (756 cells) - Adgre1高表达
- Cluster 3: NK cells (432 cells) - Nkg7高表达
- Cluster 4: CD4+ T cells (654 cells) - Cd4高表达
- Cluster 5: CD8+ T cells (523 cells) - Cd8a高表达
- Cluster 6: Monocytes (298 cells) - Ly6c2高表达
- Cluster 7: Dendritic cells (187 cells) - Itgax高表达
- Cluster 8: Neutrophils (156 cells) - S100a8高表达
- Cluster 9: Fibroblasts (234 cells) - Col1a1高表达
- Cluster 10: Endothelial (198 cells) - Pecam1高表达
- Cluster 11: Mast cells (89 cells) - Cma1高表达

正在进行 Marker 基因鉴定..."
```

### Example 2: 注释不确定
```
Agent:
[执行注释]

"【细胞注释】⚠️ 部分不确定

无法确定类型的 cluster：
- Cluster 3: marker 不明确，可能是 progenitor 或 doublet
- Cluster 7: 同时表达 T 和 B marker，可能需要检查是否双细胞

建议：
1. 检查 doublet 检测结果
2. 或者提高分辨率再注释

继续还是重新聚类？"
```

## 决策点

| 情况 | 判断 | 行动 |
|------|------|------|
| marker 不明确 | 可能是新细胞类型 | 保留为 "Unknown"，后续分析 |
| 同时表达多种 marker | 疑似 doublet | 检查或移除 |
| 某些 cluster 很小 | 可能是噪声 | 考虑合并 |
