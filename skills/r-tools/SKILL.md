---
name: r-tools
description: "R 语言生信工具封装。集成 Seurat、DESeq2、ggplot2 等 R 包，支持单细胞和 RNA-seq 分析。"
invocable: user
autoInvocable: true
argument-hint: "<操作> [参数]"
r-dependencies:
  - "Seurat"
  - "DESeq2"
  - "clusterProfiler"
  - "ggplot2"
  - "tidyverse"
---

# R Tools

R 语言生信分析工具封装（Seurat/DESeq2/tidyverse）。

## 安装 R 依赖

```r
# 在 R 中运行
install.packages(c('Seurat', 'DESeq2', 'clusterProfiler', 'ggplot2', 'tidyverse'))

# 或通过 BiocManager
if (!requireNamespace("BiocManager", quietly = TRUE))
    install.packages("BiocManager")
BiocManager::install(c('DESeq2', 'edgeR', 'clusterProfiler'))
```

## 操作命令

### 1. Seurat 单细胞分析

```bash
python skills/r-tools/r_tool.py seurat \
  --data rna_counts.csv \
  --samples samples.csv \
  --group-by condition \
  --output seurat_results
```

### 2. DESeq2 差异分析

```bash
python skills/r-tools/r_tool.py deseq2 \
  --counts counts_matrix.csv \
  --coldata metadata.csv \
  --design "~ condition" \
  --output deseq2_results
```

### 3. GO 富集分析

```bash
python skills/r-tools/r_tool.py go-enrich \
  --genes deg_genes.txt \
  --species human \
  --output go_results
```

### 4. 降维可视化

```bash
python skills/r-tools/r_tool.py visualize \
  --seurat seurat_object.rds \
  --method umap \
  --color-by cluster \
  --output plot.png
```

## 常用 R 代码模板

### Seurat 基本流程
```r
# 加载数据
data <- Read10X(data.dir = "filtered_feature_bc_matrix/")
seurat_obj <- CreateSeuratObject(counts = data, project = "project")

# QC
seurat_obj <- PercentageFeatureSet(seurat_obj, pattern = "^MT-", col.name = "percent.mt")
seurat_obj <- subset(seurat_obj, subset = nFeature_RNA > 200 & percent.mt < 20)

# 标准化
seurat_obj <- NormalizeData(seurat_obj)
seurat_obj <- FindVariableFeatures(seurat_obj, nfeatures = 2000)
seurat_obj <- ScaleData(seurat_obj)

# 降维聚类
seurat_obj <- RunPCA(seurat_obj)
seurat_obj <- RunUMAP(seurat_obj, dims = 1:30)
seurat_obj <- FindNeighbors(seurat_obj, dims = 1:30)
seurat_obj <- FindClusters(seurat_obj, resolution = 0.5)

# 保存
saveRDS(seurat_obj, "seurat_object.rds")
```

### DESeq2 差异分析
```r
library(DESeq2)

# 创建 DESeq2 数据集
dds <- DESeqDataSetFromMatrix(countData = counts,
                              colData = coldata,
                              design = ~ condition)

# 过滤低表达基因
keep <- rowSums(counts(dds) >= 10) >= 3
dds <- dds[keep,]

# 差异分析
dds <- DESeq(dds)
results <- results(dds, contrast = c("condition", "tumor", "normal"))

# 显著性基因
sig_genes <- results[which(results$padj < 0.05 & abs(results$log2FoldChange) > 1),]
```

## 输出

- RDS 对象（Seurat）
- 差异分析结果（CSV）
- GO/KEGG 富集结果
- 可视化图表
