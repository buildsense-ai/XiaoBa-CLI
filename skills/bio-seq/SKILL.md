---
name: bio-seq
description: "生物序列读写工具。支持读取、统计、格式转换、过滤 FASTA/FASTQ 文件。"
invocable: user
autoInvocable: true
argument-hint: "<fasta/fastq文件路径> [操作: stats|read|convert|filter]"
python-dependencies:
  - "biopython>=1.81"
---

# Bio Seq

通过 Python 脚本处理生物序列文件。

## 命令参考

### 读取序列（列出所有序列）

```bash
python skills/bio-seq/bio_seq_tool.py <file_path> read
```

### 序列统计

```bash
python skills/bio-seq/bio_seq_tool.py <file_path> stats
```

输出：序列数、总长度、平均长度、GC含量、平均质量(Q)

### 格式转换

```bash
python skills/bio-seq/bio_seq_tool.py <file_path> convert --to-format fasta
python skills/bio-seq/bio_seq_tool.py <file_path> convert --to-format fastq
```

### 按长度过滤

```bash
python skills/bio-seq/bio_seq_tool.py <file_path> filter --min-length 50
```

### 按质量过滤（仅 FASTQ）

```bash
python skills/bio-seq/bio_seq_tool.py <file_path> filter --min-quality 20
```

## 使用示例

1. 统计一个 FASTA 文件：
   ```
   python skills/bio-seq/bio_seq_tool.py ./data/sequences.fasta stats
   ```

2. FASTQ 转 FASTA：
   ```
   python skills/bio-seq/bio_seq_tool.py ./reads.fastq convert --to-format fasta
   ```

3. 过滤短序列：
   ```
   python skills/bio-seq/bio_seq_tool.py ./reads.fq filter --min-length 100
   ```

## 支持格式

- FASTA: .fasta, .fa, .fna
- FASTQ: .fastq, .fq
