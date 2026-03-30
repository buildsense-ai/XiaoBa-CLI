---
name: db-tools
description: "生信数据库工具。支持 NCBI/Ensembl/UniProt/GeneCard 查询和批量下载。"
invocable: user
autoInvocable: true
argument-hint: "<操作> [参数]"
python-dependencies:
  - "biopython>=1.81"
---

# DB Tools

生信数据库查询与下载工具。

## 支持的数据库

- **NCBI** - PubMed, GenBank, SRA, GEO
- **Ensembl** - 基因组注释, 变异
- **UniProt** - 蛋白质序列与功能
- **GeneCards** - 基因综合信息
- **UCSC** - 基因组浏览器

## 操作命令

### 1. 基因信息查询

```python
python skills/db-tools/db_tool.py gene --symbol TP53 --species human
```

### 2. 序列获取

```python
python skills/db-tools/db_tool.py sequence --gene BRCA1 --region chr17:41196312-41277500
```

### 3. BLAST 搜索

```python
python skills/db-tools/db_tool.py blast --seq seq.fasta --database nr --output blast_results.csv
```

### 4. GEO 数据下载

```python
python skills/db-tools/db_tool.py geo --accession GSE12345 --save expression_data.csv
```

### 5. 批量基因注释

```python
python skills/db-tools/db_tool.py annotate --genes gene_list.txt --species human
```

### 6. Pathway 查询

```python
python skills/db-tools/db_tool.py pathway --gene TP53 --database kegg
```

## 常用基因列表

| 数据库 | 用途 |
|--------|------|
| GeneCards | 基因综合信息 |
| OMIM | 遗传病 |
| DisGeNET | 疾病基因关联 |
| STRING | 蛋白互作 |
| KEGG | 通路 |
| Reactome | 通路 |

## 输出

- 基因注释 (CSV/JSON)
- 序列文件 (FASTA)
- 表达矩阵
- 通路信息
