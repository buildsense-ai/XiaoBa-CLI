---
name: sc-qc
description: "单细胞高级 QC 工具。提供批次效应校正、双细胞检测、细胞周期分析、线粒体过滤等高级质控功能。"
invocable: user
autoInvocable: true
argument-hint: "<h5ad文件路径> [操作]"
python-dependencies:
  - "scanpy>=1.9.0"
---

# Sc QC

单细胞高级质控与批次校正工具。

## 安装依赖

```bash
pip install harmonypy scrublet
```

## 命令参考

### 批次效应校正

```bash
python skills/sc-qc/sc_qc_tool.py <file.h5ad> batch --batch-key batch
```

自动使用 Harmony 或 ComBat 校正批次效应

### 双细胞检测

```bash
python skills/sc-qc/sc_qc_tool.py <file.h5ad> doublet --expected-doublets 50
```

自动检测并标记双细胞

### 移除双细胞

```bash
python skills/sc-qc/sc_qc_tool.py <file.h5ad> filter-doublets
```

### 细胞周期分析

```bash
python skills/sc-qc/sc_qc_tool.py <file.h5ad> cellcycle --species human
```

识别 G1/S/G2M 各周期细胞

### 线粒体过滤

```bash
python skills/sc-qc/sc_qc_tool.py <file.h5ad> mito --percent-mito 20
```

过滤线粒体基因表达过高的细胞

### SoupX 污染校正

```bash
python skills/sc-qc/sc_qc_tool.py <file.h5ad> soupx --contamination 0.05
```

校正环境 RNA 污染

## 完整 QC 流程

```bash
# 1. 双细胞检测 + 移除
python skills/sc-qc/sc_qc_tool.py adata.h5ad doublet
python skills/sc-qc/sc_qc_tool.py adata_doublets.h5ad filter-doublets

# 2. 线粒体过滤
python skills/sc-qc/sc_qc_tool.py adata_singlets.h5ad mito --percent-mito 20

# 3. 批次校正
python skills/sc-qc/sc_qc_tool.py adata_mito_filtered.h5ad batch --batch-key batch

# 4. 细胞周期（可选）
python skills/sc-qc/sc_qc_tool.py adata_batch_corrected.h5ad cellcycle
```

## 常用参数

| 参数 | 说明 |
|------|------|
| `--batch-key` | 批次字段名 |
| `--percent-mito` | 线粒体阈值（默认20%） |
| `--contamination` | SoupX 污染比例 |
| `--species` | human 或 mouse |
