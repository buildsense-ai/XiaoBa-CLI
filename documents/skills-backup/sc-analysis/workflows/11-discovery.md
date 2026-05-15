# Step XX: 发现与建议

## 目的

在基础分析完成后，主动挖掘数据中的科学亮点，给出有价值的生物学洞察和建议后续分析方向。

## 触发条件

细胞注释完成后（Step 05），或用户要求"发现些什么"时。

---

## 发现维度

### 1. 细胞组成分析

```python
import scanpy as sc
import pandas as pd
import numpy as np

adata = sc.read_h5ad('05_annotation/annotated.h5ad')

# 各细胞类型占比
cell_proportions = adata.obs['cell_type'].value_counts(normalize=True) * 100

print("=== 细胞组成分析 ===")
print(cell_proportions.round(1))

# 检查稀有细胞类型（< 1%）
rare_types = cell_proportions[cell_proportions < 1]
if len(rare_types) > 0:
    print(f"\n稀有细胞类型 (<1%): {list(rare_types.index)}")
```

**关注点：**
- 免疫细胞 vs 非免疫细胞比例是否合理
- 是否有稀有的细胞类型值得关注
- 细胞组成与组织来源是否匹配

---

### 2. 组间差异发现

```python
# 如果有分组信息
if 'group' in adata.obs.columns:
    # 各组细胞类型比例
    group_proportions = pd.crosstab(
        adata.obs['cell_type'], 
        adata.obs['group'],
        normalize='columns'
    ) * 100
    
    print("\n=== 组间细胞组成差异 ===")
    print(group_proportions.round(1))
    
    # 找出差异最大的细胞类型
    group_cols = adata.obs['group'].unique()
    if len(group_cols) >= 2:
        diff = abs(group_proportions[group_cols[0]] - group_proportions[group_cols[1]])
        top_diff = diff.nlargest(5)
        print("\n差异最大的细胞类型：")
        for cell_type, d in top_diff.items():
            if d > 5:  # 差异 > 5%
                print(f"  - {cell_type}: 差异 {d:.1f}%")
```

**关注点：**
- 两组之间哪些细胞类型比例显著变化
- 这些变化是否符合生物学预期
- 提示哪些生物学过程可能被调控

---

### 3. 细胞状态分析

```python
# 检查是否有不同激活状态的细胞
activation_markers = {
    'T cell activation': ['CD69', 'CD25', 'HLA-DRA'],
    'M1 Macrophage': ['IL1B', 'CXCL10', 'TNF'],
    'M2 Macrophage': ['ARG1', 'CD163', 'MRC1'],
    'Exhaustion': ['PDCD1', 'CTLA4', 'LAG3'],
    'Proliferation': ['MKI67', 'TOP2A', 'PCNA'],
    'Stress': ['HSPA1A', 'HSP90AA1', 'FOS']
}

print("\n=== 细胞状态 marker 表达 ===")
for state, markers in activation_markers.items():
    valid_markers = [m for m in markers if m in adata.var_names]
    if valid_markers:
        expr = adata[:, valid_markers].X.mean()
        if expr > 0.1:  # 有表达
            pct = (adata[:, valid_markers].X > 0).mean(axis=1).mean() * 100
            print(f"{state}: {pct:.1f}% cells 表达")
```

**关注点：**
- 是否有 M1/M2 极化的巨噬细胞
- T 细胞是否呈现激活或耗竭状态
- 是否有增殖相关的细胞（如干细胞）
- 细胞应激水平如何

---

### 4. 样本特异性分析

```python
# 各样本的细胞类型分布
sample_celltype = pd.crosstab(
    adata.obs['sample'], 
    adata.obs['cell_type']
)

print("\n=== 样本特异性细胞类型 ===")
# 找出只在某个样本中富集的细胞类型
for sample in adata.obs['sample'].unique():
    sample_counts = sample_celltype.loc[sample]
    total = sample_counts.sum()
    enriched = sample_counts[sample_counts / total > 0.3]  # >30% 来自某细胞类型
    if len(enriched) > 0:
        print(f"\n{sample} 富集的细胞类型:")
        for ct, count in enriched.items():
            pct = count / total * 100
            print(f"  - {ct}: {pct:.1f}%")
```

**关注点：**
- 哪些细胞类型是某个样本特有的
- 这与组织来源或处理条件是否相关

---

### 5. 关键通路激活推断

```python
# 基于 marker 基因推断通路活性
pathway_markers = {
    'Interferon signaling': ['ISG15', 'IFITM3', 'MX1', 'OAS1'],
    'Inflammatory response': ['IL1B', 'TNF', 'CXCL8', 'CCL2'],
    'Wnt signaling': ['CTNNB1', 'LEF1', 'AXIN2'],
    'Hypoxia response': ['VEGFA', 'LDHA', 'ENO1'],
    'Apoptosis': ['BCL2', 'BAX', 'CASP3'],
    'Cell cycle': ['CCND1', 'CCNE1', 'CDK4']
}

print("\n=== 通路活性推断 ===")
for pathway, markers in pathway_markers.items():
    valid_markers = [m for m in markers if m in adata.var_names]
    if valid_markers:
        mean_expr = adata[:, valid_markers].X.mean()
        pct_expr = (adata[:, valid_markers].X > 0).mean() * 100
        if mean_expr > 0.05:
            print(f"{pathway}: mean={mean_expr:.3f}, {pct_expr:.1f}% cells")
```

---

## 生成发现报告

```python
def generate_discovery_report(adata):
    """生成科学发现报告"""
    discoveries = []
    
    # 1. 细胞组成
    cell_props = adata.obs['cell_type'].value_counts(normalize=True) * 100
    discoveries.append(f"主要细胞类型: {', '.join(cell_props.head(3).index.tolist())}")
    
    # 2. 免疫细胞比例
    immune_types = ['T cells', 'B cells', 'NK cells', 'Macrophages', 'Monocytes', 'DC']
    immune_pct = cell_props[[ct for ct in immune_types if ct in cell_props.index]].sum()
    discoveries.append(f"免疫细胞占比: {immune_pct:.1f}%")
    
    # 3. 组间差异（如果有）
    if 'group' in adata.obs.columns:
        groups = adata.obs['group'].unique()
        if len(groups) == 2:
            g1_cells = adata[adata.obs['group'] == groups[0]]
            g2_cells = adata[adata.obs['group'] == groups[1]]
            # 比较细胞类型比例
            discoveries.append(f"组间细胞组成存在差异")
    
    return discoveries
```

---

## Few-shot Examples

### Example 1: 有趣发现
```
Agent:
[分析数据后]

"【科学发现】🔬

基于数据分析，我注意到以下几个有趣的点：

1. 🔴 M2 巨噬细胞富集
   - 发现 M2 型巨噬细胞 (CD163+, MRC1+) 在 Treatment 组显著升高
   - 占比从 Control 的 8% 升至 Treatment 的 23%
   - 提示：组织修复/免疫抑制微环境增强

2. 🟡 耗竭 T 细胞存在
   - 检测到 PD1+, CTLA4+ T 细胞（约 5%）
   - 提示：可能存在慢性免疫激活或肿瘤微环境

3. 🟢 干扰素信号通路激活
   - ISG15, MX1, IFITM3 高表达
   - Treatment 组通路活性是对照组的 2.3 倍

建议后续分析：
→ 细胞通讯分析：探究 M2 巨噬细胞与其他细胞的互作
→ 轨迹分析：T 细胞耗竭发育路径
→ 差异分析：聚焦 M2 相关基因"
```

### Example 2: 数据质量警告
```
Agent:
[分析数据后]

"【发现与建议】⚠️

数据中有几个值得注意的点：

1. 🔴 批次效应存在
   - AM5CK1267 和 1268 在 UMAP 上有明显分离
   - 建议：检查这两批样本的制备差异

2. 🟡 稀有细胞类型
   - 发现了 3 种稀有细胞类型 (< 0.5%)：
     • 干细胞样细胞 (表达 Top2a, Mki67)
     • 衰老 T 细胞 (表达 CD57)
   - 建议：增加测序深度以更好地表征这些群体

3. 🟢 数据质量良好
   - 整体线粒体含量 < 5%
   - 双细胞比例 < 3%
   - 适合后续分析"
```

### Example 3: 组织特异性发现
```
Agent:
[分析数据后]

"【组织特异性发现】🧬

根据样本来源注释，推测组织特异性：

肝/肠来源 (AM5CK1265-66):
- 上皮细胞占比高 (42%)
- 肝实质细胞 marker (Alb, Ttr) 表达
- 建议：关注代谢相关通路

淋巴结来源 (AM5CK1267-68):
- 免疫细胞为主 (65%)
- 丰富的 T/B 细胞互作
- 生发中心 B 细胞 (BCL6 高表达)
- 建议：分析淋巴器官免疫反应

跨组织比较：
- 成纤维细胞在两组间差异明显（肝 vs 淋巴结）
- 提示组织微环境对间质细胞的影响"
```

---

## 决策点

| 发现 | 建议后续分析 |
|------|-------------|
| M1/M2 巨噬细胞极化 | CellChat 分析细胞互作 |
| T 细胞耗竭 | 轨迹分析 + Velocity |
| 干细胞/祖细胞存在 | 轨迹分析推断发育路径 |
| 干扰素通路激活 | 差异分析 + GSEA |
| 组间细胞比例差异 | 统计检验 + 堆叠图 |
| 稀有细胞类型 | 重新聚类细分 |
