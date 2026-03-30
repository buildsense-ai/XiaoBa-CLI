#!/usr/bin/env python3
"""生信分析流程编排工具"""
import sys
import json
import argparse
import subprocess
import shutil
from pathlib import Path
from datetime import datetime


class PipelineRunner:
    def __init__(self, output_dir):
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.logs = []
        self.start_time = datetime.now()
    
    def log(self, message, level="INFO"):
        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        log_entry = f"[{timestamp}] [{level}] {message}"
        self.logs.append(log_entry)
        print(log_entry)
    
    def run_command(self, cmd, description=""):
        """执行命令"""
        self.log(f"执行: {description or cmd}")
        try:
            result = subprocess.run(
                cmd, shell=True, capture_output=True, text=True, timeout=3600
            )
            if result.returncode == 0:
                self.log(f"✓ 完成: {description or cmd[:50]}")
                return {"status": "success", "stdout": result.stdout}
            else:
                self.log(f"✗ 失败: {result.stderr[:200]}", "ERROR")
                return {"status": "error", "stderr": result.stderr}
        except subprocess.TimeoutExpired:
            self.log("✗ 超时", "ERROR")
            return {"status": "error", "error": "超时"}
        except Exception as e:
            self.log(f"✗ 错误: {str(e)}", "ERROR")
            return {"status": "error", "error": str(e)}
    
    def save_logs(self):
        """保存日志"""
        log_file = self.output_dir / "pipeline_log.txt"
        with open(log_file, 'w') as f:
            f.write('\n'.join(self.logs))
        return str(log_file)


def sc_workflow(input_file, output_dir, config=None):
    """单细胞完整分析流程"""
    runner = PipelineRunner(output_dir)
    
    runner.log("开始单细胞分析流程")
    runner.log(f"输入: {input_file}")
    
    current_file = input_file
    
    # Step 1: QC
    runner.log("步骤 1/4: 质控过滤")
    qc_output = f"{output_dir}/step1_qc.h5ad"
    result = runner.run_command(
        f"python skills/sc-qc/sc_qc_tool.py {current_file} mito --percent-mito 20",
        "线粒体过滤"
    )
    if result["status"] == "success":
        current_file = f"{output_dir}/step1_qc.h5ad"
        # 移动文件
        src = Path(input_file.replace('.h5ad', '_mito_filtered.h5ad'))
        if src.exists():
            shutil.copy(src, current_file)
    
    # Step 2: 标准化
    runner.log("步骤 2/4: 预处理")
    preprocess_output = f"{output_dir}/step2_preprocess.h5ad"
    result = runner.run_command(
        f"python skills/sc-preprocess/sc_preprocess_tool.py {current_file} full",
        "标准化 + 高变基因"
    )
    if result["status"] == "success":
        src = Path(current_file.replace('.h5ad', '_preprocessed.h5ad'))
        if src.exists():
            shutil.copy(src, preprocess_output)
            current_file = preprocess_output
    
    # Step 3: 降维聚类
    runner.log("步骤 3/4: 降维聚类")
    cluster_output = f"{output_dir}/step3_cluster.h5ad"
    result = runner.run_command(
        f"python skills/sc-analyze/sc_analyze_tool.py {current_file} full --resolution 1.0",
        "PCA + UMAP + Leiden"
    )
    if result["status"] == "success":
        src = Path(current_file.replace('.h5ad', '_analyzed.h5ad'))
        if src.exists():
            shutil.copy(src, cluster_output)
            current_file = cluster_output
    
    # Step 4: 差异分析
    runner.log("步骤 4/4: 差异分析")
    result = runner.run_command(
        f"python skills/sc-interpret/sc_interpret_tool.py {current_file} rank",
        "差异表达分析"
    )
    
    # 保存 marker table
    runner.run_command(
        f"python skills/sc-interpret/sc_interpret_tool.py {current_file} markers",
        "导出 marker genes"
    )
    
    # 保存日志
    log_file = runner.save_logs()
    
    elapsed = (datetime.now() - runner.start_time).total_seconds()
    
    return {
        "status": "success",
        "output_dir": output_dir,
        "final_file": current_file,
        "log_file": log_file,
        "elapsed_seconds": elapsed,
        "steps_completed": ["qc", "preprocess", "cluster", "diffexp"]
    }


def rna_workflow(counts_file, samples_file, output_dir):
    """RNA-seq 完整流程"""
    runner = PipelineRunner(output_dir)
    
    runner.log("开始 RNA-seq 分析流程")
    runner.log(f"Counts: {counts_file}")
    runner.log(f"Samples: {samples_file}")
    
    # Step 1: 加载数据
    runner.log("步骤 1/4: 加载数据")
    
    # Step 2: 差异分析
    runner.log("步骤 2/4: 差异分析")
    result = runner.run_command(
        f"python skills/rna-seq/rna_seq_tool.py deseq2 "
        f"--counts {counts_file} --samples {samples_file} "
        f"--condition group",
        "DESeq2 差异分析"
    )
    
    # Step 3: 富集分析
    runner.log("步骤 3/4: 富集分析")
    runner.run_command(
        f"python skills/rna-seq/rna_seq_tool.py enrich "
        f"--genes {output_dir}/significant_genes.csv",
        "GO/KEGG 富集"
    )
    
    # Step 4: 可视化
    runner.log("步骤 4/4: 可视化")
    runner.run_command(
        f"python skills/rna-seq/rna_seq_tool.py volcano "
        f"--degs {output_dir}/deseq2_results.csv --output {output_dir}/volcano.png",
        "火山图"
    )
    
    log_file = runner.save_logs()
    elapsed = (datetime.now() - runner.start_time).total_seconds()
    
    return {
        "status": "success",
        "output_dir": output_dir,
        "log_file": log_file,
        "elapsed_seconds": elapsed
    }


def batch_process(input_dir, workflow, pattern="*.h5ad", output_dir="batch_results"):
    """批量处理"""
    runner = PipelineRunner(output_dir)
    
    input_path = Path(input_dir)
    files = list(input_path.glob(pattern))
    
    runner.log(f"找到 {len(files)} 个文件")
    
    results = []
    for i, f in enumerate(files):
        runner.log(f"处理 {i+1}/{len(files)}: {f.name}")
        
        if workflow == "sc-qc":
            result = runner.run_command(
                f"python skills/sc-qc/sc_qc_tool.py {f} mito",
                f"QC: {f.name}"
            )
        elif workflow == "sc-analyze":
            result = runner.run_command(
                f"python skills/sc-analyze/sc_analyze_tool.py {f} full",
                f"分析: {f.name}"
            )
        
        results.append({
            "file": str(f),
            "status": result.get("status", "unknown")
        })
    
    # 汇总
    success = sum(1 for r in results if r["status"] == "success")
    runner.log(f"完成: {success}/{len(files)} 成功")
    
    # 保存汇总
    summary_file = f"{output_dir}/batch_summary.csv"
    import csv
    with open(summary_file, 'w') as f:
        writer = csv.DictWriter(f, fieldnames=['file', 'status'])
        writer.writeheader()
        writer.writerows(results)
    
    log_file = runner.save_logs()
    
    return {
        "status": "success",
        "total_files": len(files),
        "success": success,
        "failed": len(files) - success,
        "summary": summary_file,
        "log_file": log_file
    }


def main():
    parser = argparse.ArgumentParser(description='流程编排工具')
    parser.add_argument('workflow', 
                        choices=['sc', 'rna', 'batch', 'info'],
                        help='工作流类型')
    parser.add_argument('--input', help='输入文件')
    parser.add_argument('--counts', help='counts 文件')
    parser.add_argument('--samples', help='样本文件')
    parser.add_argument('--config', help='配置文件')
    parser.add_argument('--input-dir', help='批量处理输入目录')
    parser.add_argument('--workflow-type', help='批量处理工作流类型')
    parser.add_argument('--pattern', default='*.h5ad', help='文件匹配模式')
    parser.add_argument('--output', default='pipeline_results', help='输出目录')
    
    args = parser.parse_args()
    
    result = None
    
    if args.workflow == 'sc':
        result = sc_workflow(args.input, args.output, args.config)
    elif args.workflow == 'rna':
        result = rna_workflow(args.counts, args.samples, args.output)
    elif args.workflow == 'batch':
        result = batch_process(args.input_dir, args.workflow_type, args.pattern, args.output)
    
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
