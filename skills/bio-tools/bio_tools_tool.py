#!/usr/bin/env python3
"""生信命令行工具封装 - samtools, bcftools, bedtools, seqkit"""
import sys
import json
import argparse
import subprocess
from pathlib import Path


def check_tool(name):
    """检查工具是否安装"""
    result = subprocess.run(f"which {name}", shell=True, capture_output=True)
    return result.returncode == 0


def run_tool(cmd, description=""):
    """执行命令并返回结果"""
    try:
        result = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=300)
        if result.returncode == 0:
            return {
                "status": "success",
                "stdout": result.stdout[:5000],
                "stderr": result.stderr[:1000] if result.stderr else ""
            }
        else:
            return {
                "error": f"{description} 失败",
                "stderr": result.stderr[:1000]
            }
    except subprocess.TimeoutExpired:
        return {"error": "命令执行超时"}
    except Exception as e:
        return {"error": str(e)}


def samtools_view(input_file, output=None, options=""):
    """SAMtools view - 查看/转换比对文件"""
    cmd = f"samtools view {options} {input_file}"
    if output:
        cmd += f" -o {output}"
    return run_tool(cmd, "samtools view")


def samtools_sort(input_file, output=None, options="-o sorted.bam"):
    """SAMtools sort - 排序"""
    if output is None:
        output = input_file.replace('.sam', '_sorted.bam').replace('.bam', '_sorted.bam')
    cmd = f"samtools sort {options} -o {output} {input_file}"
    return run_tool(cmd, "samtools sort")


def samtools_index(bam_file):
    """SAMtools index - 建立索引"""
    cmd = f"samtools index {bam_file}"
    return run_tool(cmd, "samtools index")


def samtools_stats(bam_file):
    """SAMtools stats - 比对统计"""
    cmd = f"samtools stats {bam_file}"
    return run_tool(cmd, "samtools stats")


def samtools_flagstat(bam_file):
    """SAMtools flagstat - 标记统计"""
    cmd = f"samtools flagstat {bam_file}"
    return run_tool(cmd, "samtools flagstat")


def bcftools_call(vcf_file, output=None, options=""):
    """BCFtools call - 变异检测"""
    if output is None:
        output = vcf_file.replace('.vcf', '_called.vcf')
    cmd = f"bcftools call {options} -o {output} {vcf_file}"
    return run_tool(cmd, "bcftools call")


def bcftools_filter(vcf_file, output=None, options="-e 'FS>50'"):
    """BCFtools filter - 变异过滤"""
    if output is None:
        output = vcf_file.replace('.vcf', '_filtered.vcf')
    cmd = f"bcftools filter {options} -o {output} {vcf_file}"
    return run_tool(cmd, "bcftools filter")


def bcftools_stats(vcf_file):
    """BCFtools stats - VCF 统计"""
    cmd = f"bcftools stats {vcf_file}"
    return run_tool(cmd, "bcftools stats")


def bedtools_intersect(a_file, b_file, output=None, options="-a -b"):
    """BEDTools intersect - 区间交集"""
    if output is None:
        output = f"{Path(a_file).stem}_intersect.bed"
    cmd = f"bedtools intersect {options} -a {a_file} -b {b_file} > {output}"
    result = run_tool(cmd, "bedtools intersect")
    if result.get("status") == "success":
        result["output"] = output
    return result


def bedtools_closest(a_file, b_file, output=None):
    """BEDTools closest - 最近区间"""
    if output is None:
        output = f"{Path(a_file).stem}_closest.bed"
    cmd = f"bedtools closest -a {a_file} -b {b_file} > {output}"
    result = run_tool(cmd, "bedtools closest")
    if result.get("status") == "success":
        result["output"] = output
    return result


def seqkit_stats(fasta_file):
    """SeqKit stats - 序列统计"""
    cmd = f"seqkit stats {fasta_file}"
    return run_tool(cmd, "seqkit stats")


def seqkit_fx2tab(fasta_file, options="-l -g -n"):
    """SeqKit fx2tab - 格式转换"""
    cmd = f"seqkit fx2tab {options} {fasta_file}"
    return run_tool(cmd, "seqkit fx2tab")


def seqkit_seq(fasta_file, options="-p -m 100"):
    """SeqKit seq - 序列操作"""
    output = fasta_file.replace('.fa', '_processed.fa')
    cmd = f"seqkit seq {options} {fasta_file} -o {output}"
    result = run_tool(cmd, "seqkit seq")
    if result.get("status") == "success":
        result["output"] = output
    return result


def main():
    parser = argparse.ArgumentParser(description='生信命令行工具封装')
    parser.add_argument('tool', help='工具名称: samtools, bcftools, bedtools, seqkit')
    parser.add_argument('action', help='操作名称')
    parser.add_argument('file', help='输入文件')
    parser.add_argument('--output', '-o', help='输出文件')
    parser.add_argument('--options', help='额外选项')
    
    args = parser.parse_args()
    
    if not Path(args.file).exists():
        print(json.dumps({"error": f"文件不存在: {args.file}"}))
        sys.exit(1)
    
    result = None
    
    # SAMtools
    if args.tool == 'samtools':
        if args.action == 'view':
            result = samtools_view(args.file, args.output, args.options or "")
        elif args.action == 'sort':
            result = samtools_sort(args.file, args.output)
        elif args.action == 'index':
            result = samtools_index(args.file)
        elif args.action == 'stats':
            result = samtools_stats(args.file)
        elif args.action == 'flagstat':
            result = samtools_flagstat(args.file)
        else:
            result = {"error": f"未知操作: {args.action}"}
    
    # BCFtools
    elif args.tool == 'bcftools':
        if args.action == 'call':
            result = bcftools_call(args.file, args.output, args.options or "")
        elif args.action == 'filter':
            result = bcftools_filter(args.file, args.output, args.options or "")
        elif args.action == 'stats':
            result = bcftools_stats(args.file)
        else:
            result = {"error": f"未知操作: {args.action}"}
    
    # BEDTools
    elif args.tool == 'bedtools':
        if args.action == 'intersect':
            result = bedtools_intersect(args.file, args.output or "")
        elif args.action == 'closest':
            result = bedtools_closest(args.file, args.output or "")
        else:
            result = {"error": f"未知操作: {args.action}"}
    
    # SeqKit
    elif args.tool == 'seqkit':
        if args.action == 'stats':
            result = seqkit_stats(args.file)
        elif args.action == 'fx2tab':
            result = seqkit_fx2tab(args.file, args.options or "")
        elif args.action == 'seq':
            result = seqkit_seq(args.file, args.options or "")
        else:
            result = {"error": f"未知操作: {args.action}"}
    
    else:
        result = {"error": f"未知工具: {args.tool}"}
    
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
