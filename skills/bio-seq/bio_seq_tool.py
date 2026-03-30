#!/usr/bin/env python3
"""生物序列处理工具 - 支持 FASTA/FASTQ 格式"""
import sys
import json
import argparse
from pathlib import Path

try:
    from Bio import SeqIO
except ImportError:
    print(json.dumps({"error": "请先安装 biopython: pip install biopython"}))
    sys.exit(1)


def read_seq(filepath):
    """读取序列文件"""
    fmt = 'fastq' if filepath.endswith(('.fastq', '.fq')) else 'fasta'
    try:
        records = list(SeqIO.parse(filepath, fmt))
        return {
            "status": "success",
            "format": fmt,
            "count": len(records),
            "sequences": [
                {"id": r.id, "description": r.description, "length": len(r.seq)}
                for r in records
            ]
        }
    except Exception as e:
        return {"error": str(e)}


def stats_seq(filepath):
    """序列统计"""
    fmt = 'fastq' if filepath.endswith(('.fastq', '.fq')) else 'fasta'
    try:
        records = list(SeqIO.parse(filepath, fmt))
        total_len = sum(len(r.seq) for r in records)
        gc_count = sum(str(r.seq).count('G') + str(r.seq).count('C') for r in records)
        
        result = {
            "status": "success",
            "file": filepath,
            "format": fmt,
            "count": len(records),
            "total_length": total_len,
            "avg_length": round(total_len / len(records), 1) if records else 0,
            "gc_content": round(gc_count / total_len * 100, 2) if total_len else 0
        }
        
        if fmt == 'fastq':
            qual_scores = []
            for r in records:
                if len(r.letter_annotations.get('phred_quality', [])) > 0:
                    qual_scores.extend(r.letter_annotations['phred_quality'])
            result["avg_quality"] = round(sum(qual_scores) / len(qual_scores), 2) if qual_scores else 0
            result["min_quality"] = min(qual_scores) if qual_scores else 0
            result["max_quality"] = max(qual_scores) if qual_scores else 0
        
        return result
    except Exception as e:
        return {"error": str(e)}


def convert_seq(filepath, to_format=None):
    """格式转换"""
    fmt = 'fastq' if filepath.endswith(('.fastq', '.fq')) else 'fasta'
    if to_format is None:
        to_format = 'fasta' if fmt == 'fastq' else 'fastq'
    
    try:
        ext_map = {'fasta': 'fna', 'fastq': 'fq'}
        new_ext = ext_map.get(to_format, to_format)
        out_file = str(Path(filepath).with_suffix(f'.{new_ext}'))
        
        records = list(SeqIO.parse(filepath, fmt))
        SeqIO.write(records, out_file, to_format)
        
        return {"status": "success", "output": out_file, "count": len(records)}
    except Exception as e:
        return {"error": str(e)}


def filter_seq(filepath, min_length=None, min_quality=None):
    """过滤序列"""
    fmt = 'fastq' if filepath.endswith(('.fastq', '.fq')) else 'fasta'
    
    try:
        records = list(SeqIO.parse(filepath, fmt))
        original_count = len(records)
        
        if min_length:
            records = [r for r in records if len(r.seq) >= int(min_length)]
        
        if min_quality and fmt == 'fastq':
            records = [
                r for r in records 
                if sum(r.letter_annotations.get('phred_quality', [])) / len(r) >= float(min_quality)
            ]
        
        ext = filepath.rsplit('.', 1)
        out_file = f"{ext[0]}_filtered.{ext[-1]}"
        SeqIO.write(records, out_file, fmt)
        
        return {
            "status": "success",
            "original": original_count,
            "filtered": len(records),
            "output": out_file
        }
    except Exception as e:
        return {"error": str(e)}


def main():
    parser = argparse.ArgumentParser(description='生物序列处理工具')
    parser.add_argument('file', help='序列文件路径')
    parser.add_argument('action', nargs='?', default='stats',
                        choices=['read', 'stats', 'convert', 'filter'],
                        help='操作类型')
    parser.add_argument('--to-format', '-t', help='目标格式 (fasta/fastq)')
    parser.add_argument('--min-length', help='最小长度过滤')
    parser.add_argument('--min-quality', help='最小质量过滤 (FASTQ)')
    
    args = parser.parse_args()
    
    if not Path(args.file).exists():
        print(json.dumps({"error": f"文件不存在: {args.file}"}))
        sys.exit(1)
    
    result = None
    if args.action == 'read':
        result = read_seq(args.file)
    elif args.action == 'stats':
        result = stats_seq(args.file)
    elif args.action == 'convert':
        result = convert_seq(args.file, args.to_format)
    elif args.action == 'filter':
        result = filter_seq(args.file, args.min_length, args.min_quality)
    
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
