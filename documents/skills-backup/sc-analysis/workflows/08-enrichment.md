# Step 08: 功能富集分析

## 目的

对差异基因进行 GO/KEGG 富集分析，揭示生物学通路的变化。

## 触发条件

差异分析完成后，且有显著差异基因时。

## 执行流程

### 1. 准备基因列表

```python
import pandas as pd

# 读取差异基因
diff_df = pd.read_csv('07_diff/treatment_vs_control.csv')

# 筛选显著基因
sig_genes = diff_df[
    (diff_df['pvalue_adj'] < 0.05) &
    (abs(diff_df['log2FC']) > 0.5)
]['gene'].tolist()

# 分离上调和下调
up_genes = diff_df[
    (diff_df['pvalue_adj'] < 0.05) &
    (diff_df['log2FC'] > 0.5)
]['gene'].tolist()

down_genes = diff_df[
    (diff_df['pvalue_adj'] < 0.05) &
    (diff_df['log2FC'] < -0.5)
]['gene'].tolist()
```

### 2. GO 富集分析

```python
import gseapy as gp

# GO Biological Process
go_bp = gp.enrichr(
    gene_list=sig_genes,
    gene_sets='GO_Biological_Process_2021',
    organism='Mouse',
    outdir=None,
    cutoff=0.05
)

# 保存结果
go_bp.res2d.to_csv('08_enrichment/GO_BP_enrichment.csv')

# 绘图
gp.barplot(go_bp.res2d, title='GO Biological Process', 
           cutoff=0.05, top_term=20,
           save='08_enrichment/GO_BP.png')
```

### 3. KEGG 富集分析

```python
# KEGG Pathway
kegg = gp.enrichr(
    gene_list=sig_genes,
    gene_sets='KEGG_2021_Human',
    organism='Mouse',
    outdir=None,
    cutoff=0.05
)

kegg.res2d.to_csv('08_enrichment/KEGG_enrichment.csv')
gp.barplot(kegg.res2d, title='KEGG Pathway',
           cutoff=0.05, top_term=20,
           save='08_enrichment/KEGG.png')
```

### 4. 可视化

```python
import matplotlib.pyplot as plt

# 上调基因通路
fig, axes = plt.subplots(1, 2, figsize=(14, 6))

# GO 条形图
top_go = go_bp.res2d.head(10)
axes[0].barh(top_go['Term'], -np.log10(top_go['Adjusted P-value']))
axes[0].set_xlabel('-log10(P-value)')
axes[0].set_title('GO Biological Process (Up-regulated)')

# KEGG 条形图
top_kegg = kegg.res2d.head(10)
axes[1].barh(top_kegg['Term'], -np.log10(top_kegg['Adjusted P-value']))
axes[1].set_xlabel('-log10(P-value)')
axes[1].set_title('KEGG Pathway (Up-regulated)')

plt.tight_layout()
plt.savefig('08_enrichment/enrichment_barplot.png', dpi=300)
```

## 输出

- `GO_enrichment.csv`: GO 富集结果
- `KEGG_enrichment.csv`: KEGG 富集结果
- `enrichment_barplot.png`: 富集条形图
- `enrichment_network.png`: 通路网络图

## 物种对应

| 物种 | enrichr organism | KEGG |
|------|-----------------|------|
| Human | 'Human' | 'KEGG_2021_Human' |
| Mouse | 'Mouse' | 'KEGG_2021_Human' |
| Rat | 'Rat' | 'KEGG_2021_Human' |

## Few-shot Examples

### Example 1: 正常富集
```
Agent:
[执行富集分析]

"【功能富集完成】✓

上调基因富集通路：
1. Interferon signaling (padj = 1.2e-12)
2. Cytokine-mediated signaling (padj = 3.4e-8)
3. Viral response (padj = 5.6e-7)

下调基因富集通路：
1. T cell receptor signaling (padj = 2.1e-6)
2. Lymphocyte differentiation (padj = 8.9e-5)
3. Cell adhesion molecules (padj = 1.2e-4)

解读：
- Treatment 组激活了干扰素信号通路
- T 细胞相关通路下调，提示 T 细胞功能抑制
```

### Example 2: 没有显著富集
```
Agent:
[执行富集分析]

"【功能富集】⚠️

没有找到显著富集的通路 (padj < 0.05)

可能原因：
1. 差异基因太少
2. 基因功能比较分散
3. 实验条件影响较小

可以尝试：
1. 降低显著性阈值
2. 使用 GO molecular function
3. 聚焦特定的通路数据库
```

## 决策点

| 情况 | 判断 | 行动 |
|------|------|------|
| 通路过于宽泛 | 如 "biological process" | 使用更具体的通路集 |
| 没有富集 | 基因可能有问题 | 检查差异基因列表 |
| 上调下调通路不同 | 生物学有意义 | 重点解读 |
