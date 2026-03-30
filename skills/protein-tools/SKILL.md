---
name: protein-tools
description: "蛋白质结构预测与分析工具。提供序列比对、同源搜索、AlphaFold 结构预测、分子对接功能。"
invocable: user
autoInvocable: true
argument-hint: "<操作> [参数]"
python-dependencies:
  - "biopython>=1.81"
---

# Protein Tools

蛋白质结构预测与分析工具。

## 安装依赖

```bash
# Python 依赖
pip install biopython matplotlib

# AlphaFold（通过 conda 或 Docker）
conda install -c bioconda alphafold

# 其他工具
conda install -c bioconda mmseqs2 autoprotcol Haddock
```

## 操作命令

### 1. 序列比对

```python
python skills/protein-tools/protein_tool.py align \
  --seq "MVLSPADKTNVKAAWGKVGAHAGEYGAEALERMFLSFPTTKTYFPHFDLSH" \
  --database uniref50
```

### 2. 同源搜索

```python
python skills/protein-tools/protein_tool.py search \
  --seq protein_seq.fasta \
  --db pdb \
  --output homologs.csv
```

### 3. AlphaFold 预测

```python
python skills/protein-tools/protein_tool.py fold \
  --seq protein_seq.fasta \
  --output predicted_structure
```

### 4. 结构可视化

```python
python skills/protein-tools/protein_tool.py visualize \
  --pdb structures/AF_prediction.pdb \
  --save structure.png
```

### 5. 分子对接

```python
python skills/protein-tools/protein_tool.py dock \
  --receptor protein_a.pdb \
  --ligand protein_b.pdb \
  --output docked_complex.pdb
```

## 在线预测工具

本地 AlphaFold 安装复杂，推荐使用：

1. **AlphaFold2 Server** - https://alphafold.ebi.ac.uk
2. **ColabFold** - https://colab.research.google.com
3. **ESMFold** - https://esmatlas.com

```python
# 自动调用 ColabFold（通过 API 或本地安装）
python skills/protein-tools/protein_tool.py colabfold \
  --seq protein_seq.fasta \
  --output results/
```

## 输出

- PDB 结构文件
- 预测置信度 (pLDDT)
- 可视化图像
- 对接结果

## 应用场景

| 场景 | 工具 |
|------|------|
| 蛋白质结构预测 | AlphaFold2, ESMFold |
| 抗体设计 | AlphaFold-Multimer |
| 蛋白-蛋白对接 | HADDOCK, ZDOCK |
| 药物靶点 | AutoDock, AutoDock Vina |
