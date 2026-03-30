---
name: rna-seq
description: "RNA-seq 完整分析流程。提供质控、比对、定量、差异表达、功能富集分析。"
invocable: user
autoInvocable: true
argument-hint: "<操作> [文件路径]"
python-dependencies:
  - "scanpy>=1.9.0"
  - "DESeq2"  # via rpy2 or conda
  - "pandas>=1.5"
---

# RNA-Seq

RNA-seq 完整分析流程。

## 安装依赖

```bash
# Python 依赖
pip install scanpy pandas rpy2

# R 依赖（通过 R 安装）
# install.packages(c('DESeq2', 'edgeR', 'clusterProfiler'))

# 或使用 conda
conda install -c bioconda star subread salmon
```

## 核心流程

```
原始数据 (FASTQ)
    ↓ 质控 (FastQC)
    ↓ 比对 (STAR/Hisat2)
    ↓ 定量 (featureCounts/salmon)
    ↓ 标准化 (DESeq2/edgeR)
    ↓ 差异表达
    ↓ 富集分析 (GO/KEGG)
    ↓ 可视化
```

## 操作命令

### 1. 质控

```bash
# FastQC 质控（需要安装 fastqc）
fastqc input_R1.fastq input_R2.fastq -o qc_output/
```

### 2. 获取公开数据

```python
python -c "
import scanpy as sc
# 从 GEO 读取 RNA-seq 数据（已处理好的 counts 矩阵）
adata = sc.read_text('matrix.csv')
adata = adata.T  # 转置：基因在列，样本在行
print(f'样本: {adata.n_obs}, 基因: {adata.n_vars}')
"
```

### 3. 读取已处理数据

```python
python skills/rna-seq/rna_seq_tool.py load --matrix counts.csv --samples samples.csv
```

### 4. 差异表达分析 (DESeq2)

```python
python skills/rna-seq/rna_seq_tool.py deseq2 --counts counts.csv --samples samples.csv --condition condition
```

### 5. GO/KEGG 富集分析

```python
python skills/rna-seq/rna_seq_tool.py enrich --genes deg_genes.csv --species human
```

### 6. 可视化

```python
python skills/rna-seq/rna_seq_tool.py volcano --degs deg_results.csv --fc-col log2FoldChange --pval-col padj
python skills/rna-seq/rna_seq_tool.py heatmap --degs deg_results.csv --counts counts.csv --top-n 50
```

## 输出文件

- `deseq2_results.csv` - 差异表达结果
- `go_enrichment.csv` - GO 富集结果
- `kegg_enrichment.csv` - KEGG 富集结果
- `volcano_plot.png` - 火山图
- `heatmap_plot.png` - 热图

## 常用分析场景

### 比较肿瘤 vs 正常
```bash
python skills/rna-seq/rna_seq_tool.py deseq2 \
  --counts tumor_normal_counts.csv \
  --samples samples.csv \
  --condition group \
  --contrast "tumor,normal"
```

### 时间序列分析
```bash
python skills/rna-seq/rna_seq_tool.py timecourse \
  --counts time_series_counts.csv \
  --samples samples.csv \
  --time-col timepoint
```

### 单基因批量查询
```bash
python skills/rna-seq/rna_seq_tool.py gene-query \
  --gene BRCA1,TP53,EGFR \
  --database tcga
```
