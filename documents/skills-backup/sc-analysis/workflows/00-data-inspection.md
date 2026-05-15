# Step 00: 数据探查

## 目的

在开始正式分析前，全面了解数据的结构、质量和特征，为后续参数选择提供依据。

## 触发条件

用户首次提供数据，或要求"检查数据"、"探查数据"时。

## 执行步骤

### 1. 检测数据格式

```python
from pathlib import Path

input_path = Path(data_path)

if input_path.suffix == '.h5ad':
    # 单个 h5ad 文件
    data_type = 'h5ad_single'
elif input_path.is_dir():
    # 检查目录结构
    if list(input_path.glob('*.h5ad')):
        data_type = 'h5ad_multi'
    elif list(input_path.glob('*.h10x')) or list(input_path.glob('*/*.h5')):
        data_type = '10x_h5'
    elif list(input_path.glob('*/matrix.mtx')):
        data_type = '10x_mtx'
    else:
        data_type = 'unknown'
```

### 2. 收集基本信息

| 数据类型 | 读取方式 | 关键信息 |
|---------|---------|---------|
| h5ad | `sc.read_h5ad()` | obs.index, var.index, X |
| 10x h5 | `sc.read_10x_h5()` | 样本名需手动指定 |
| 10x mtx | `sc.read_10x_mtx()` | 同上 |

### 3. 统计指标

每个样本统计：
- 细胞数 (n_cells)
- 基因数 (n_genes)
- UMI 数（中位数）
- 基因数（中位数）
- 线粒体比例（中位数）
- 核糖体比例（中位数）

### 4. 物种推断

```python
def detect_species(adata):
    """根据基因名判断物种"""
    genes = adata.var_names.tolist()[:500]
    
    # Human: 全大写 (TP53) 或 ENSG 开头
    human = sum(1 for g in genes if g == g.upper() or g.startswith('ENSG'))
    
    # Mouse: 首字母大写 (Tp53) 或 ENSMUSG 开头
    mouse = sum(1 for g in genes if g == g.title() or g.startswith('ENSMUSG'))
    
    # Rat: ENSRNOG 开头
    rat = sum(1 for g in genes if g.startswith('ENSRNOG'))
    
    if human > mouse and human > rat:
        return 'human'
    elif mouse > human and mouse > rat:
        return 'mouse'
    elif rat > human and rat > mouse:
        return 'rat'
    return 'unknown'
```

## 输出格式

生成 `data_overview.json`：

```json
{
  "n_samples": 4,
  "total_cells": 8000,
  "total_genes": 31000,
  "species": "mouse",
  "samples": [
    {
      "name": "AM5CK1265",
      "cells": 2000,
      "median_genes": 1523,
      "median_mito": 2.3,
      "quality": "good"
    }
  ],
  "recommendations": {
    "qc_min_genes": 200,
    "qc_max_genes": 6000,
    "qc_max_mito": 10,
    "integration_method": "harmony"
  }
}
```

## 决策点

| 情况 | 判断 | 后续行动 |
|------|------|---------|
| 线粒体 > 20% | 质量差 | 建议严格 QC，max_mito 设为 5% |
| 中位基因数 < 500 | 低质量 | 建议降低 min_genes 到 150 |
| 单样本 < 500 细胞 | 样本过少 | 跳过复杂分析，重点看 marker |
| 物种未知 | 无法判断 | 询问用户物种信息 |

## Few-shot Examples

### Example 1: 正常数据
```
用户: 分析 ~/Desktop/sampled_data

Agent: 
[执行探查]

"检测到 4 个样本，共 8,000 个细胞，物种推断为 mouse。

样本分布：
- AM5CK1265: 2000 cells, 中位基因 1523, 线粒体 2.3%
- AM5CK1266: 2000 cells, 中位基因 1489, 线粒体 2.8%
- AM5CK1267: 2000 cells, 中位基因 1602, 线粒体 1.9%
- AM5CK1268: 2000 cells, 中位基因 1456, 线粒体 3.1%

数据质量：良好 ✓
- 线粒体比例均 < 5%
- 基因数分布正常
- 无明显异常样本

建议参数：
- min_genes=200, max_genes=6000, max_mito=10%
- 整合：Harmony

开始分析？"
```

### Example 2: 质量问题
```
Agent:
[执行探查]

"检测到 4 个样本，但发现质量问题：

- AM5CK1265: 线粒体 18.5% ⚠️
- AM5CK1266: 线粒体 2.1% ✓
- AM5CK1267: 线粒体 22.3% ⚠️
- AM5CK1268: 线粒体 3.2% ✓

建议：
- 对 AM5CK1265 和 1267 严格过滤：max_mito=5%
- 或全部样本统一用 max_mito=10%，后续观察

要继续吗？"
```

### Example 3: 物种未知
```
Agent:
[执行探查]

"检测到 4 个样本，共 8000 个细胞。
物种推断失败（基因名无法判断 human/mouse/rat）。

请告诉我物种信息：
1. human
2. mouse  
3. rat
4. 其他（手动输入）"
```
