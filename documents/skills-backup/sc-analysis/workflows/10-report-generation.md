# Step 13-15: 统计、细胞比例与报告生成

## Step 13: 统计分析

### 目的

提供额外的统计检验，补充基础分析。

### 执行流程

```python
import pandas as pd
import numpy as np
from scipy import stats

adata = sc.read_h5ad('05_annotation/annotated.h5ad')

# 1. 各细胞类型数量统计
cell_counts = adata.obs['cell_type'].value_counts()
print("细胞类型分布:")
print(cell_counts)

# 2. 组间细胞比例差异检验
# 比较 treatment vs control 的细胞比例
from scipy.stats import fisher_exact, chi2_contingency

# 创建列联表
contingency = pd.crosstab(
    adata.obs['cell_type'],
    adata.obs['group']
)

# 卡方检验
chi2, pvalue, dof, expected = chi2_contingency(contingency)

# 3. 基因表达统计
gene_stats = pd.DataFrame({
    'gene': adata.var_names,
    'mean_expr': np.array(adata.X.mean(axis=0)).flatten(),
    'pct_expressed': np.array((adata.X > 0).mean(axis=0)).flatten()
})

gene_stats.to_csv('13_statistics/gene_statistics.csv', index=False)
```

### Few-shot
```
Agent:
[执行统计分析]

"【统计分析完成】✓

细胞类型分布：
- T cells: 3,456 (45%)
- B cells: 1,567 (20%)
- Macrophages: 1,234 (16%)
- NK cells: 876 (11%)
- 其他: 323 (4%)

组间差异检验 (Treatment vs Control):
- 卡方检验 p-value: 0.023 ⚠️
- 组间细胞比例存在显著差异

主要差异：
- Macrophages 在 Treatment 组中比例升高 (+8%)
- T cells 比例下降 (-5%)
```

---

## Step 14: 细胞比例分析

### 目的

比较不同组间各细胞类型的比例变化。

### 执行流程

```python
import scanpy as sc
import pandas as pd

adata = sc.read_h5ad('05_annotation/annotated.h5ad')

# 计算每个样本的细胞类型比例
proportion_df = pd.DataFrame()

for sample in adata.obs['sample'].unique():
    sample_data = adata[adata.obs['sample'] == sample]
    counts = sample_data.obs['cell_type'].value_counts()
    proportions = counts / counts.sum() * 100
    temp_df = pd.DataFrame({
        'sample': sample,
        'cell_type': proportions.index,
        'proportion': proportions.values
    })
    proportion_df = pd.concat([proportion_df, temp_df])

proportion_df.to_csv('14_cell_proportion/proportions.csv', index=False)

# 可视化
import matplotlib.pyplot as plt

fig, axes = plt.subplots(1, 2, figsize=(14, 6))

# 堆叠条形图
proportion_pivot = proportion_df.pivot(index='sample', columns='cell_type', values='proportion')
proportion_pivot.plot(kind='bar', stacked=True, ax=axes[0])
axes[0].set_title('Cell Type Proportions by Sample')
axes[0].set_ylabel('Percentage (%)')
axes[0].legend(bbox_to_anchor=(1.05, 1), loc='upper left')

# 分面箱线图
for i, cell_type in enumerate(proportion_df['cell_type'].unique()):
    ax = axes[1] if i == 0 else fig.add_subplot(1, 2, 2, sharey=ax)
    
axes[1].set_title('Cell Type Distribution')
```

### Few-shot
```
Agent:
[执行细胞比例分析]

"【细胞比例分析完成】✓

样本间细胞类型比例：

| 细胞类型 | Control | Treatment | 变化 |
|---------|---------|----------|------|
| T cells | 48% | 43% | -5% |
| B cells | 21% | 20% | -1% |
| Macrophages | 15% | 23% | +8% ⚠️ |
| NK cells | 12% | 10% | -2% |
| 其他 | 4% | 4% | 0% |

可视化已保存到 14_cell_proportion/
```

---

## Step 15: 报告生成

### 目的

生成可发表的 HTML 和 PPT 报告。

### 执行流程

```python
import scanpy as sc
import pandas as pd
import json

# 读取分析结果
adata = sc.read_h5ad('05_annotation/annotated.h5ad')
markers = pd.read_csv('06_markers/markers.csv')

# 读取数据概览
with open('00_inspection/data_overview.json') as f:
    overview = json.load(f)

# 生成 HTML 报告
html_content = f"""
<!DOCTYPE html>
<html>
<head>
    <title>scRNA-seq Analysis Report</title>
    <style>
        body {{ font-family: Arial, sans-serif; margin: 40px; }}
        h1 {{ color: #333; }}
        table {{ border-collapse: collapse; width: 100%; margin: 20px 0; }}
        th, td {{ border: 1px solid #ddd; padding: 8px; text-align: left; }}
        th {{ background-color: #4CAF50; color: white; }}
        .section {{ margin: 30px 0; }}
    </style>
</head>
<body>
    <h1>scRNA-seq Analysis Report</h1>
    
    <div class="section">
        <h2>Data Overview</h2>
        <ul>
            <li>Total Cells: {overview['total_cells']:,}</li>
            <li>Total Genes: {overview['total_genes']:,}</li>
            <li>Species: {overview['species']}</li>
        </ul>
    </div>
    
    <div class="section">
        <h2>Cell Type Annotation</h2>
        {cell_type_table}
    </div>
    
    <div class="section">
        <h2>Key Markers</h2>
        {markers_table}
    </div>
</body>
</html>
"""

with open('15_report/analysis_report.html', 'w') as f:
    f.write(html_content)
```

### 生成 PPT

```python
from pptx import Presentation
from pptx.util import Inches, Pt

prs = Presentation()

# Slide 1: 标题
slide = prs.slides.add_slide(prs.slide_layouts[0])
title = slide.shapes.title
subtitle = slide.placeholders[1]
title.text = "scRNA-seq Analysis Report"
subtitle.text = "Project: {project_name}"

# Slide 2: 数据概览
slide = prs.slides.add_slide(prs.slide_layouts[1])
title = slide.shapes.title
title.text = "Data Overview"
# 添加文本框

# Slide 3: 细胞类型分布
slide = prs.slides.add_slide(prs.slide_layouts[5])  # 空白布局
title = slide.shapes.title
title.text = "Cell Type Distribution"
# 添加图片
slide.shapes.add_picture('04_clustering/umap_celltype.png', 
                         Inches(1), Inches(1.5), width=Inches(8))

prs.save('15_report/analysis.pptx')
```

### Few-shot
```
Agent:
[生成报告]

"【报告生成完成】✓

已生成报告文件：
- 15_report/analysis_report.html - 网页报告（含所有图表）
- 15_report/analysis.pptx - PPT 演示文稿

报告内容包括：
✓ 数据概览
✓ QC 统计
✓ 聚类结果
✓ 细胞注释
✓ Marker 基因
✓ 差异分析
✓ 富集通路
✓ 细胞比例

分析完成！🎉

如需调整报告内容或补充分析，请告诉我。"
```

---

## 分析完成总结

```
========================================
scRNA-seq 分析完成
========================================

数据: 4 个样本, 8,000 cells
物种: Mouse
分析日期: {timestamp}

主要发现:
1. 识别了 12 种细胞类型
2. T cells 占比最高 (45%)
3. Treatment 组 Macrophages 显著升高
4. 干扰素信号通路显著激活

输出文件:
- 完整数据: 05_annotation/annotated.h5ad
- Marker: 06_markers/markers.csv
- 报告: 15_report/analysis_report.html

========================================
```
