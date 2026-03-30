---
name: clinical-tools
description: "临床生信数据库工具。支持 TCGA/GEO 数据挖掘、临床信息分析、生存分析。"
invocable: user
autoInvocable: true
argument-hint: "<操作> [参数]"
python-dependencies:
  - "pandas>=1.5"
  - "lifelines>=0.27"
---

# Clinical Tools

临床生信数据挖掘工具。

## 安装依赖

```bash
pip install pandas lifelines scipy seaborn
```

## 支持的数据库

- **TCGA** - 33种癌症的癌症基因组计划
- **GEO** - 基因表达综合数据库
- **ICGC** - 国际癌症基因组联盟

## 操作命令

### 1. 获取 TCGA 数据

```python
python skills/clinical-tools/clinical_tool.py get-tcga \
  --cancer BRCA \
  --data-type expression \
  --save tcga_brca_expr.csv
```

### 2. 获取临床信息

```python
python skills/clinical-tools/clinical_tool.py clinical \
  --cancer LUAD \
  --save luad_clinical.csv
```

### 3. 生存分析

```python
python skills/clinical-tools/clinical_tool.py survival \
  --clinical luad_clinical.csv \
  --gene TP53 \
  --expression tcga_luad_expr.csv \
  --output survival_plot.png
```

### 4. 相关性分析

```python
python skills/clinical-tools/clinical_tool.py correlation \
  --expr tcga_expr.csv \
  --gene1 BRCA1 \
  --gene2 BRCA2
```

### 5. 批量基因分析

```python
python skills/clinical-tools/clinical_tool.py batch-genes \
  --cancer COAD \
  --genes TP53,KRAS,APC \
  --output batch_results.csv
```

## 常用分析场景

### 肿瘤分型
```bash
python skills/clinical-tools/clinical_tool.py subtypes \
  --cancer BRCA \
  --method consensus
```

### 预后标志物筛选
```bash
python skills/clinical-tools/clinical_tool.py biomarker \
  --cancer LUAD \
  --endpoint OS \
  --pval-threshold 0.05
```

### 药物敏感性分析
```bash
python skills/clinical-tools/clinical_tool.py drug-sensitivity \
  --cancer BRCA \
  --drug cisplatin
```

## 输出

- 表达矩阵 (CSV)
- 临床信息 (CSV)
- 生存曲线图 (PNG)
- 统计分析报告
