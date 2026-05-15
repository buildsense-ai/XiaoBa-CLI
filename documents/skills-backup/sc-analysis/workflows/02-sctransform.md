# Step 02: SCTransform 标准化

## 目的

使用 SCTransform 方法进行标准化，比传统 LogNormalize 更好地区分技术噪声和生物变异。

## 触发条件

QC 完成后自动执行。

## 原理

SCTransform 使用正则化负二项回归来建模每个细胞的测序深度，然后返回残差作为标准化值。

## 执行流程

### 1. 检查输入数据

```python
import scanpy as sc

adata = sc.read_h5ad('01_qc/clean.h5ad')

# 确保有 sample 列
if 'sample' not in adata.obs.columns:
    adata.obs['sample'] = adata.obs.index.str.split('-').str[0]
```

### 2. SCTransform 标准化

```python
# 方法 A: 使用 scanpy 的 sctransform
# 注意：这会替换 adata.X
sc.pp.highly_variable_genes(
    adata,
    flavor='seurat_v3',
    n_top_genes=3000,
    batch_key='sample'
)

# 运行 SCTransform
sc.tl.score_genes_cell_cycle(adata, s_genes=g2m_genes, g2m_genes=g2m_genes)
# SCTransform 在 scanpy 中通过 sct.ppsctransform 实现
```

### 3. 实际推荐方案

由于 scanpy 内置 SCTransform 需要额外安装，推荐使用传统方法：

```python
# 方法 B: 传统标准化（效果也不错）
# 保存原始 counts
adata.layers['counts'] = adata.X.copy()

# LogNormalize
sc.pp.normalize_total(adata, target_sum=1e4)
sc.pp.log1p(adata)

# 找高变基因
sc.pp.highly_variable_genes(
    adata,
    flavor='seurat',
    n_top_genes=2000,
    batch_key='sample'  # 批次感知
)

# 保留高变基因
adata = adata[:, adata.var.highly_variable]
```

### 4. 缩放

```python
# 回归技术因素
sc.pp.regress_out(adata, ['n_counts', 'pct_mito'])

# 缩放到方差为 1
sc.pp.scale(adata, max_value=10)
```

## 输出

- `sct.h5ad`: 标准化后的数据
- 高变基因列表

## 注意事项

| 情况 | 处理 |
|------|------|
| 数据量 > 5万细胞 | 考虑只保留 2000 高变基因 |
| 多批次数据 | 必须用 batch_key 找高变基因 |
| 有细胞周期基因 | 回归掉 cell cycle score |

## Few-shot Examples

### Example 1: 正常流程
```
Agent:
[执行标准化]

"【SCTransform 完成】✓

- 保留高变基因: 2,000
- 回归变量: n_counts, pct_mito
- 缩放: 均值=0, 方差=1

正在进行样本整合..."
```

### Example 2: 批次效应检测
```
Agent:
[执行标准化]

"【标准化完成】✓

批次效应检查：
- 样本间基因表达相关性: 0.89-0.94 ✓
- 无明显批次效应

高变基因跨批次一致性良好，可以进行整合。
```
