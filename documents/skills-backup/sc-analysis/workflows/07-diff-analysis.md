# Step 07: 差异分析

## 目的

比较不同组之间的基因表达差异，找出响应条件变化的基因。

## 触发条件

细胞注释完成后，且用户提供了分组信息，或主动要求做差异分析时。

## 分组方案

| 分组方式 | 适用场景 |
|---------|---------|
| 按样本 | 比较样本间差异 |
| 按细胞类型 | 同类细胞在不同组间差异 |
| 按 cluster | 探索特定 cluster 的特征 |

## 执行流程

### 1. 准备分组信息

```python
import scanpy as sc
import pandas as pd

adata = sc.read_h5ad('05_annotation/annotated.h5ad')

# 确保有 group 列
# 如果原始数据没有分组，按样本分组
if 'group' not in adata.obs.columns:
    # 假设样本名包含组别信息，如: CTR_1, CTR_2, TREAT_1, TREAT_2
    adata.obs['group'] = adata.obs['sample'].str.extract(r'([A-Za-z]+)_')[0]
```

### 2. 比较组间差异

```python
# 方法 A: 按 group 比较（所有细胞类型一起）
sc.tl.rank_genes_groups(
    adata,
    groupby='group',
    groups=['treatment'],  # 要比较的组
    reference='control',   # 对照组
    method='wilcoxon'
)

# 保存结果
result = adata.uns['rank_genes_groups']
diff_genes = []

for i, gene in enumerate(result['names']['treatment']):
    diff_genes.append({
        'gene': gene,
        'score': result['scores']['treatment'][i],
        'pvalue_adj': result['pvals_adj']['treatment'][i],
        'log2FC': result['logfoldchanges']['treatment'][i],
        'pct_1': result['pct_nz_group']['treatment'][i],
        'pct_2': result['pct_nz_reference'][i]
    })

diff_df = pd.DataFrame(diff_genes)
diff_df.to_csv('07_diff/treatment_vs_control.csv', index=False)
```

### 3. 同类细胞组间比较

```python
# 只比较某类细胞
t_cells = adata[adata.obs['cell_type'] == 'T cells']

sc.tl.rank_genes_groups(
    t_cells,
    groupby='group',
    groups=['treatment'],
    reference='control',
    method='wilcoxon'
)
```

### 4. 火山图

```python
import matplotlib.pyplot as plt
import numpy as np

# 读取差异分析结果
diff_df = pd.read_csv('07_diff/treatment_vs_control.csv')

# 标记显著基因
diff_df['-log10(padj)'] = -np.log10(diff_df['pvalue_adj'])

# 分类
diff_df['significance'] = 'NS'
diff_df.loc[(diff_df['log2FC'] > 0.5) & (diff_df['pvalue_adj'] < 0.05), 'significance'] = 'Up'
diff_df.loc[(diff_df['log2FC'] < -0.5) & (diff_df['pvalue_adj'] < 0.05), 'significance'] = 'Down'

# 绘图
plt.figure(figsize=(10, 8))
colors = {'NS': 'grey', 'Up': 'red', 'Down': 'blue'}
for sig, color in colors.items():
    subset = diff_df[diff_df['significance'] == sig]
    plt.scatter(subset['log2FC'], subset['-log10(padj)'], 
                c=color, alpha=0.5, s=20, label=sig)

# 标注 top 基因
top_genes = diff_df.nlargest(10, '-log10(padj)')
for _, row in top_genes.iterrows():
    plt.annotate(row['gene'], (row['log2FC'], row['-log10(padj)']))

plt.xlabel('log2 Fold Change')
plt.ylabel('-log10(adjusted p-value)')
plt.savefig('07_diff/volcano.png', dpi=300, bbox_inches='tight')
```

## 输出

- `treatment_vs_control.csv`: 差异基因列表
- `volcano.png`: 火山图
- `heatmap.png`: 差异基因热图

## 筛选标准

| 标准 | 值 | 说明 |
|------|-----|------|
| padj | < 0.05 | FDR 校正 |
| |log2FC| | > 0.5 | 至少 1.4 倍差异 |
| pct | > 0.1 | 至少 10% 细胞表达 |

## Few-shot Examples

### Example 1: 组间差异分析
```
Agent:
[执行差异分析]

"【差异分析完成】✓

Treatment vs Control 比较结果：

显著差异基因：
- 上调: 234 个
- 下调: 189 个

Top 上调基因：
1. CXCL10 (+3.2 log2FC, padj < 0.001)
2. ISG15 (+2.8 log2FC, padj < 0.001)
3. IFITM3 (+2.5 log2FC, padj < 0.001)

Top 下调基因：
1. IL7R (-1.8 log2FC, padj < 0.001)
2. CCR7 (-1.5 log2FC, padj < 0.001)
3. TCF7 (-1.2 log2FC, padj < 0.01)

解读：Treatment 组表现出干扰素应答增强，T 细胞活化标志物下调。
```

### Example 2: 没有差异
```
Agent:
[执行差异分析]

"【差异分析】⚠️

警告：未检测到显著差异基因！

- 上调基因: 0
- 下调基因: 0

可能原因：
1. 组间样本量太少
2. 分组信息不正确
3. 生物学差异确实很小

请检查分组信息，或确认样本注释是否正确。
```

## 决策点

| 情况 | 判断 | 行动 |
|------|------|------|
| 差异基因太少 (<50) | 可能分组有问题 | 验证分组信息 |
| 差异基因太多 (>1000) | 可能过于宽松 | 提高阈值 |
| 生物学 marker 不在列表 | 需要检查 | 放宽阈值或重新分析 |
