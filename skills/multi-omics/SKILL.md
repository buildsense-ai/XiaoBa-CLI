---
name: multi-omics
description: "多组学整合分析。整合单细胞转录组、蛋白质组、表观遗传等多组学数据进行联合分析。"
invocable: user
autoInvocable: true
argument-hint: "<操作> [数据文件]"
python-dependencies:
  - "scanpy>=1.9.0"
  - "anndata>=0.8"
---

# Multi-Omics

多组学整合分析工具。

## 什么是多组学

将不同层面的生物数据联合分析：
- **基因组** - DNA 变异 (SNV, CNV)
- **转录组** - RNA 表达
- **蛋白质组** - 蛋白表达
- **表观遗传** - 甲基化、ATAC-seq
- **代谢组** - 代谢物

## 安装依赖

```bash
pip install scanpy anndata muon
```

## 操作命令

### 1. 加载多组学数据

```python
python skills/multi-omics/multi_omics_tool.py load \
  --rna rna.h5ad \
  --protein protein.h5ad
```

### 2. 数据整合

```python
python skills/multi-omics/multi_omics_tool.py integrate \
  --rna rna_qc.h5ad \
  --atac atac.h5ad \
  --method harmony
```

### 3. MOFA+ 降维

```python
python skills/multi-omics/multi_omics_tool.py mofa \
  --rna counts.csv \
  --protein protein.csv \
  --output mofa_results.h5ad
```

### 4. 相关性分析

```python
python skills/multi-omics/multi_omics_tool.py correlate \
  --rna rna.h5ad \
  --protein protein.h5ad
```

### 5. 降维可视化

```python
python skills/multi-omics/multi_omics_tool.py visualize \
  --mofa mofa.h5ad \
  --method umap
```

## 常见应用场景

### CITE-seq（RNA + 蛋白）
```bash
python skills/multi-omics/multi_omics_tool.py cite-seq \
  --data citeseq.h5ad
```

### scRNA-seq + ATAC-seq
```bash
python skills/multi-omics/multi_omics_tool.py integrate \
  --rna scrna.h5ad \
  --atac scatac.h5ad \
  --method wnn
```

### 代谢组 + 转录组
```bash
python skills/multi-omics/multi_omics_tool.py metabolomics \
  --rna rna.h5ad \
  --metabolites metabolites.csv
```

## 输出

- 整合后的 AnnData 对象
- MOFA 降维结果
- 相关性分析表格
- 可视化图表
