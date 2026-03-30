---
name: sc-seq
description: "单细胞数据读写工具。支持读取 10x Cell Ranger (H5/MTX)、AnnData (H5AD)、Loom 格式。"
invocable: user
autoInvocable: true
argument-hint: "<单细胞数据文件> [操作: info|read]"
python-dependencies:
  - "scanpy>=1.9.0"
---

# Sc Seq

通过 Scanpy 处理单细胞数据。

## 支持格式

| 格式 | 扩展名 | 来源 |
|------|--------|------|
| 10x H5 | .h5 | Cell Ranger 输出 |
| 10x MTX | 目录/ | Cell Ranger 输出 |
| AnnData | .h5ad | Scanpy 标准格式 |
| Loom | .loom | Seurat/其他工具 |

## 命令参考

### 查看数据信息

```bash
python skills/sc-seq/sc_seq_tool.py <file.h5ad> info
```

输出：细胞数、基因数、前10个细胞ID、前10个基因名

### 读取数据

```bash
python skills/sc-seq/sc_seq_tool.py <file.h5> read
python skills/sc-seq/sc_seq_tool.py <file.h5ad> read
```

### 格式转换

```bash
python skills/sc-seq/sc_seq_tool.py <input.loom> convert --output <output.h5ad>
```

### 按细胞筛选

```bash
python skills/sc-seq/sc_seq_tool.py <file.h5ad> subset-cells --cell-ids '["cell_001", "cell_002"]'
```

### 按基因筛选

```bash
python skills/sc-seq/sc_seq_tool.py <file.h5ad> subset-genes --gene-list '["CD3D", "CD8A", "MS4A1"]'
```

## 使用示例

1. 查看 10x H5 文件信息：
   ```
   python skills/sc-seq/sc_seq_tool.py ./data/filtered_feature_bc_matrix.h5 info
   ```

2. 查看 H5AD 文件信息：
   ```
   python skills/sc-seq/sc_seq_tool.py ./results/adata.h5ad info
   ```

## 安装依赖

```bash
pip install scanpy
```

可选依赖（处理不同格式）：
```bash
pip install anndata loompy
```
