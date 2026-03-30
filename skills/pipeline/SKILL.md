---
name: pipeline
description: "生信分析流程编排工具。支持多步骤串联、批量处理、自动化工作流。"
invocable: user
autoInvocable: true
argument-hint: "<操作> [配置文件]"
python-dependencies:
  - "pyyaml"
---

# Pipeline

生信分析流程编排工具。

## 功能

- 多步骤流程串联
- 配置文件驱动
- 批量处理
- 结果自动汇总
- 错误处理与重试

## 操作命令

### 1. 单细胞完整流程

```bash
python skills/pipeline/pipeline_tool.py sc-workflow \
  --input data.h5ad \
  --config workflow_config.yaml \
  --output results/
```

### 2. RNA-seq 完整流程

```bash
python skills/pipeline/pipeline_tool.py rna-workflow \
  --counts counts.csv \
  --samples samples.csv \
  --config rna_config.yaml \
  --output results/
```

### 3. 批量处理

```bash
python skills/pipeline/pipeline_tool.py batch \
  --input-dir samples/ \
  --workflow sc-qc \
  --pattern "*.h5ad" \
  --output batch_results/
```

### 4. 流程配置

创建 `pipeline_config.yaml`:

```yaml
name: sc_pipeline
steps:
  - name: qc
    tool: sc-qc
    params:
      min_genes: 200
      percent_mito: 20
  
  - name: preprocess
    tool: sc-preprocess
    params:
      n_top_genes: 2000
  
  - name: cluster
    tool: sc-analyze
    params:
      resolution: 1.0
```

## 预设流程

| 流程 | 说明 |
|------|------|
| `sc-full` | 单细胞完整分析 |
| `rna-full` | RNA-seq 完整分析 |
| `sc-qc` | 单细胞 QC |
| `integration` | 多组学整合 |

## 输出

- 处理后的数据文件
- 日志文件
- 汇总报告
