---
name: sc-interpret
description: "单细胞数据解读工具。提供差异表达分析、细胞注释、可视化（dotplot、热图、小提琴图）。"
invocable: user
autoInvocable: true
argument-hint: "<h5ad文件路径> [操作]"
python-dependencies:
  - "scanpy>=1.9.0"
---

# Sc Interpret

单细胞数据解读与可视化工具，基于 Scanpy。

## 命令参考

### 差异表达分析

```bash
python skills/sc-interpret/sc_interpret_tool.py <file.h5ad> rank --groupby leiden
```

输出每个 cluster 的 top marker genes

### 自动细胞注释

```bash
python skills/sc-interpret/sc_interpret_tool.py <file.h5ad> annotate
```

基于内置 marker genes 库自动推断细胞类型

### 绘制 Dotplot

```bash
python skills/sc-interpret/sc_interpret_tool.py <file.h5ad> dotplot --genes "CD3D,CD19,MS4A1"
```

### 绘制热图

```bash
python skills/sc-interpret/sc_interpret_tool.py <file.h5ad> heatmap --genes "CD3D,CD19,MS4A1"
```

### 绘制小提琴图

```bash
python skills/sc-interpret/sc_interpret_tool.py <file.h5ad> violin --genes "CD3D,CD19,MS4A1"
```

### 导出 Marker 表格

```bash
python skills/sc-interpret/sc_interpret_tool.py <file.h5ad> markers --top-n 10
```

导出 CSV：cluster、gene、score、pval

## 内置 Marker Genes

| 细胞类型 | Markers |
|----------|---------|
| B cells | CD19, CD79A, MS4A1 |
| T cells | CD3D, CD3E, CD2 |
| CD8+ T | CD8A, CD8B |
| CD4+ T | CD4, IL7R |
| NK cells | NKG7, GNLY |
| Monocytes | CD14, CD68 |
| Macrophages | CD163, C1QA |
| Neutrophils | S100A8, S100A9 |
| Fibroblasts | COL1A1, FN1 |
| Endothelial | PECAM1, VWF |

## 完整使用流程

```bash
# 1. 差异表达
python skills/sc-interpret/sc_interpret_tool.py adata_analyzed.h5ad rank

# 2. 细胞注释
python skills/sc-interpret/sc_interpret_tool.py adata_analyzed.h5ad annotate

# 3. 可视化关键基因
python skills/sc-interpret/sc_interpret_tool.py adata_analyzed.h5ad dotplot --genes "CD3D,CD19,CD14"
```
