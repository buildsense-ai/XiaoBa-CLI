---
name: sc-preprocess
description: "单细胞预处理工具。提供 QC 质控、标准化、特征选择等预处理功能。"
invocable: user
autoInvocable: true
argument-hint: "<h5ad文件路径> [操作]"
python-dependencies:
  - "scanpy>=1.9.0"
---

# Sc Preprocess

单细胞数据预处理工具，基于 Scanpy。

## 命令参考

### 查看数据信息

```bash
python skills/sc-preprocess/sc_preprocess_tool.py <file.h5ad> info
```

### 质控过滤

```bash
python skills/sc-preprocess/sc_preprocess_tool.py <file.h5ad> qc --min-genes 200 --max-genes 5000
```

参数：
- `--min-genes`: 最小基因数（默认 200）
- `--max-genes`: 最大基因数
- `--max-counts`: 最大 counts 数

### 标准化

```bash
python skills/sc-preprocess/sc_preprocess_tool.py <file.h5ad> normalize --target-sum 10000
```

### 对数变换

```bash
python skills/sc-preprocess/sc_preprocess_tool.py <file.h5ad> log
```

### 特征选择（高变基因）

```bash
python skills/sc-preprocess/sc_preprocess_tool.py <file.h5ad> hvg --n-top-genes 2000
```

### 一键完整预处理

```bash
python skills/sc-preprocess/sc_preprocess_tool.py <file.h5ad> full --min-genes 200 --n-top-genes 2000
```

完整流程：过滤 → 标准化 → log1p → 高变基因 → 缩放

## 使用示例

```bash
# 1. 读取数据
python skills/sc-seq/sc_seq_tool.py ./data/adata.h5ad info

# 2. 预处理
python skills/sc-preprocess/sc_preprocess_tool.py ./data/adata.h5ad full

# 3. 后续降维聚类
python skills/sc-analyze/sc_analyze_tool.py ./data/adata_preprocessed.h5ad pca
```

## 流程说明

```
原始数据 → QC过滤 → 标准化 → log1p → 高变基因 → 缩放
              ↓         ↓        ↓        ↓        ↓
           细胞/基因   target   对数    选2000    归一化
           过滤       sum=1e4   变换    个基因
```
