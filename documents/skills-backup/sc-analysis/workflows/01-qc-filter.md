# Step 01: QC 质控过滤

## 目的

过滤低质量细胞（死细胞、碎片细胞、双细胞），保留高质量细胞用于后续分析。

## 触发条件

数据探查完成后，或用户确认使用默认参数时。

## 核心指标

| 指标 | 说明 | 正常范围 | 异常含义 |
|------|------|---------|---------|
| n_genes | 每个细胞的基因数 | 200-6000 | 过低=碎片细胞，过高=双细胞 |
| n_counts | 每个细胞的 UMI 数 | 500-30000 | 过低=死细胞，过高=双细胞 |
| pct_mito | 线粒体基因比例 | < 10% | 过高=死细胞 |
| pct_ribo | 核糖体基因比例 | 5-30% | 过高=低复杂度 |

## 执行流程

### 1. 读取数据

```python
import scanpy as sc
import pandas as pd

# 读取所有样本
samples = ['AM5CK1265', 'AM5CK1266', 'AM5CK1267', 'AM5CK1268']
adatas = []

for sample in samples:
    adata = sc.read_h5ad(f'{data_dir}/{sample}/matrix.h5ad')
    adata.obs['sample'] = sample
    adatas.append(adata)

# 合并
adata = sc.concat(adatas, join='outer')
```

### 2. 计算 QC 指标

```python
# 线粒体基因
mito_genes = adata.var_names.str.startswith('MT-') | adata.var_names.str.startswith('mt-')
adata.obs['pct_mito'] = (adata[:, mito_genes].X.sum(axis=1) / adata.X.sum(axis=1)) * 100

# 核糖体基因
ribo_genes = adata.var_names.str.match(r'^(RPS|RPL|MRPS|MRPL)', case=False)
adata.obs['pct_ribo'] = (adata[:, ribo_genes].X.sum(axis=1) / adata.X.sum(axis=1)) * 100

# 每个细胞的基因数和 UMI 数
adata.obs['n_genes'] = (adata.X > 0).sum(axis=1)
adata.obs['n_counts'] = adata.X.sum(axis=1)
```

### 3. 过滤策略

#### 策略 A: 固定阈值（推荐用于抽样数据）

```python
sc.pp.filter_cells(adata, min_genes=200)
sc.pp.filter_genes(adata, min_cells=3)

# 过滤低质量
adata = adata[adata.obs['n_genes'] >= 200, :]
adata = adata[adata.obs['n_genes'] <= 6000, :]
adata = adata[adata.obs['pct_mito'] <= 10, :]
```

#### 策略 B: 自适应阈值（基于分布）

```python
# 计算阈值
min_genes = max(200, adata.obs['n_genes'].quantile(0.01))
max_genes = min(6000, adata.obs['n_genes'].quantile(0.99))
max_mito = 10  # 或 15

# 应用过滤
adata = adata[adata.obs['n_genes'] >= min_genes, :]
adata = adata[adata.obs['n_genes'] <= max_genes, :]
adata = adata[adata.obs['pct_mito'] <= max_mito, :]
```

### 4. 双细胞检测（可选）

```python
import scrublet as scr

# 对每个样本单独检测
doublet_results = []
for sample in adata.obs['sample'].unique():
    adata_sample = adata[adata.obs['sample'] == sample]
    
    scrub = scr.Scrublet(adata_sample.X)
    doublet_scores, predicted_doublets = scrub.scrub_doublets()
    
    adata.obs.loc[adata_sample.obs.index, 'doublet_score'] = doublet_scores
    adata.obs.loc[adata_sample.obs.index, 'predicted_doublet'] = predicted_doublets

# 移除双细胞
adata = adata[~adata.obs['predicted_doublet'], :]
```

## 输出

- `clean.h5ad`: 过滤后的数据
- `qc_summary.csv`: 各样本过滤前后统计

## 过滤结果评估

| 指标 | 正常 | 异常 |
|------|------|------|
| 过滤比例 | 5-15% | >20% = 阈值过严，<5% = 可能漏掉坏细胞 |
| 各样本过滤比例 | 差异 < 5% | 差异大 = 某样本有问题 |

## Few-shot Examples

### Example 1: 正常过滤
```
Agent:
[执行 QC]

"【QC 完成】✓

过滤结果：
- 原始: 8,000 cells
- 过滤后: 7,456 cells (93.2%)
- 过滤比例: 6.8% ✓

各样本：
- AM5CK1265: 2000 → 1902 (4.9%)
- AM5CK1266: 2000 → 1867 (6.7%)
- AM5CK1267: 2000 → 1789 (10.6%)
- AM5CK1268: 2000 → 1898 (5.1%)

AM5CK1267 过滤较多，主要是因为线粒体比例偏高。

继续 SCTransform 标准化..."
```

### Example 2: 过滤异常
```
Agent:
[执行 QC]

"【QC 完成】⚠️

警告：过滤比例偏高！
- 原始: 8,000 cells
- 过滤后: 5,234 cells (65.4%)
- AM5CK1265: 42% 过滤 ⚠️

主要问题：AM5CK1265 线粒体比例过高（平均 35%）

建议：
1. 放宽阈值：max_mito=20%
2. 或者只保留高质量细胞

要重新过滤吗？"
```

## 常见问题

**Q: 过滤后细胞太少怎么办？**
A: 如果剩余 < 1000 细胞，建议降低阈值。如果仍然少，可能是数据本身质量问题。

**Q: 各样本过滤比例差异大？**
A: 正常范围 < 10%，差异大说明某样本有问题，检查原始数据质量。
