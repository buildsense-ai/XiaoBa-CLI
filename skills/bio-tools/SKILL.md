---
name: bio-tools
description: "生信命令行工具封装。提供 samtools、bcftools、bedtools、seqkit 的常用操作。"
invocable: user
autoInvocable: true
argument-hint: "<工具名> <操作> <文件> [选项]"
---

# Bio Tools

封装常用生信命令行工具。

## 安装

```bash
# conda 安装（推荐）
conda install -c bioconda samtools bcftools bedtools seqkit

# 或 pip
conda install -c conda-forge samtools bcftools bedtools seqkit
```

## SAMtools 命令

```bash
# 查看 BAM/SAM 文件
python skills/bio-tools/bio_tools_tool.py samtools view input.bam

# 排序
python skills/bio-tools/bio_tools_tool.py samtools sort input.bam

# 建立索引
python skills/bio-tools/bio_tools_tool.py samtools index input_sorted.bam

# 比对统计
python skills/bio-tools/bio_tools_tool.py samtools stats input_sorted.bam

# 标记统计
python skills/bio-tools/bio_tools_tool.py samtools flagstat input_sorted.bam
```

## BCFtools 命令

```bash
# 变异检测
python skills/bio-tools/bio_tools_tool.py bcftools call input.vcf

# 变异过滤
python skills/bio-tools/bio_tools_tool.py bcftools filter input.vcf --options "-e 'FS>50'"
```

## BEDTools 命令

```bash
# 区间交集
python skills/bio-tools/bio_tools_tool.py bedtools intersect peaks.bed genes.bed

# 最近区间
python skills/bio-tools/bio_tools_tool.py bedtools closest snps.bed genes.bed
```

## SeqKit 命令

```bash
# 序列统计
python skills/bio-tools/bio_tools_tool.py seqkit stats sequences.fa

# 格式转换
python skills/bio-tools/bio_tools_tool.py seqkit fx2tab sequences.fa

# 序列操作（提取互补序列，min-length 100）
python skills/bio-tools/bio_tools_tool.py seqkit seq sequences.fa --options "-p -m 100"
```

## 常用参数

| 工具 | 操作 | 说明 |
|------|------|------|
| samtools | view | `-b` 输出 BAM，`-q 30` 过滤低质量 |
| samtools | sort | `-o` 指定输出 |
| bedtools | intersect | `-wa` 保留 A 文件，`-wb` 保留 B 文件 |
| seqkit | seq | `-p` 互补序列，`-r` 反向，`-m 50` 最小长度 |

## 使用流程

```bash
# 比对 + 排序 + 统计
samtools sort input.bam -o sorted.bam
samtools index sorted.bam
samtools flagstat sorted.bam
```
