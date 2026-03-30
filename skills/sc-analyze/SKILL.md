---
name: sc-analyze
description: "单细胞降维与聚类工具。提供 PCA、UMAP、t-SNE、Leiden/Louvain 聚类功能。"
invocable: user
autoInvocable: true
argument-hint: "<h5ad文件路径> [操作]"
python-dependencies:
  - "scanpy>=1.9.0"
---

# Sc Analyze

单细胞数据降维聚类分析，基于 Scanpy。

## 命令参考

### 查看分析状态

```bash
python skills/sc-analyze/sc_analyze_tool.py <file.h5ad> info
```

显示：是否有 PCA/UMAP/t-SNE，聚类结果

### PCA 降维

```bash
python skills/sc-analyze/sc_analyze_tool.py <file.h5ad> pca --n-comps 50
```

### 计算邻域

```bash
python skills/sc-analyze/sc_analyze_tool.py <file.h5ad> neighbors --n-pcs 50 --n-neighbors 15
```

### UMAP 可视化

```bash
python skills/sc-analyze/sc_analyze_tool.py <file.h5ad> umap --min-dist 0.5
```

### t-SNE 可视化

```bash
python skills/sc-analyze/sc_analyze_tool.py <file.h5ad> tsne --perplexity 30
```

### Leiden 聚类

```bash
python skills/sc-analyze/sc_analyze_tool.py <file.h5ad> leiden --resolution 1.0
```

### Louvain 聚类

```bash
python skills/sc-analyze/sc_analyze_tool.py <file.h5ad> louvain --resolution 1.0
```

### 一键完整分析

```bash
python skills/sc-analyze/sc_analyze_tool.py <file.h5ad> full --n-pcs 50 --resolution 1.0
```

完整流程：PCA → neighbors → UMAP → Leiden

## 常用参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--n-comps` | 50 | PCA 主成分数 |
| `--n-neighbors` | 15 | 邻域数，越大越平滑 |
| `--resolution` | 1.0 | 聚类分辨率，越大簇越多 |
| `--min-dist` | 0.5 | UMAP 紧凑度 |

## 流程说明

```
预处理数据 → PCA(50) → neighbors(15) → UMAP → Leiden(1.0)
                               ↓
                        t-SNE (可选)
```
