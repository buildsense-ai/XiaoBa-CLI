#!/usr/bin/env python3
"""单细胞预处理工具 - QC、标准化、特征选择"""
import sys
import json
import argparse
from pathlib import Path

try:
    import scanpy as sc
except ImportError:
    print(json.dumps({"error": "请先安装 scanpy: pip install scanpy"}))
    sys.exit(1)


def qc_filter(adata_path, min_genes=200, min_cells=3, max_genes=None, max_counts=None):
    """质控过滤"""
    try:
        adata = sc.read_h5ad(adata_path)
        original_cells = adata.n_obs
        original_genes = adata.n_vars
        
        # 计算 QC 指标
        sc.pp.calculate_qc_metrics(adata, percent_top=None, log1p=False, inplace=True)
        
        # 过滤
        if max_genes:
            adata = adata[adata.obs.n_genes_by_counts < int(max_genes), :]
        if max_counts:
            adata = adata[adata.obs.total_counts < int(max_counts), :]
        if min_genes:
            adata = adata[adata.obs.n_genes_by_counts >= int(min_genes), :]
        if min_cells:
            sc.pp.filter_genes(adata, min_cells=int(min_cells))
        
        output = adata_path.replace('.h5ad', '_qc.h5ad')
        adata.write_h5ad(output)
        
        return {
            "status": "success",
            "original_cells": original_cells,
            "filtered_cells": adata.n_obs,
            "original_genes": original_genes,
            "filtered_genes": adata.n_vars,
            "output": output,
            "qc_metrics": {
                "genes_per_cell": {
                    "mean": float(adata.obs.n_genes_by_counts.mean()),
                    "median": float(adata.obs.n_genes_by_counts.median())
                },
                "counts_per_cell": {
                    "mean": float(adata.obs.total_counts.mean()),
                    "median": float(adata.obs.total_counts.median())
                }
            }
        }
    except Exception as e:
        return {"error": str(e)}


def normalize(adata_path, target_sum=1e4):
    """标准化"""
    try:
        adata = sc.read_h5ad(adata_path)
        sc.pp.normalize_total(adata, target_sum=target_sum)
        
        output = adata_path.replace('.h5ad', '_norm.h5ad')
        adata.write_h5ad(output)
        
        return {
            "status": "success",
            "output": output,
            "method": "normalize_total",
            "target_sum": target_sum
        }
    except Exception as e:
        return {"error": str(e)}


def log_transform(adata_path):
    """对数变换"""
    try:
        adata = sc.read_h5ad(adata_path)
        sc.pp.log1p(adata)
        
        output = adata_path.replace('.h5ad', '_log.h5ad')
        adata.write_h5ad(output)
        
        return {"status": "success", "output": output, "method": "log1p"}
    except Exception as e:
        return {"error": str(e)}


def highly_variable_genes(adata_path, n_top_genes=2000, flavor='seurat_v3'):
    """特征选择 - 高变基因"""
    try:
        adata = sc.read_h5ad(adata_path)
        sc.pp.highly_variable_genes(
            adata, 
            n_top_genes=int(n_top_genes),
            flavor=flavor
        )
        
        # 过滤保留高变基因
        adata = adata[:, adata.var.highly_variable]
        
        output = adata_path.replace('.h5ad', '_hvg.h5ad')
        adata.write_h5ad(output)
        
        hvg_list = list(adata.var_names[:50])
        
        return {
            "status": "success",
            "output": output,
            "total_hvg": int(adata.n_vars),
            "top_50_hvg": hvg_list
        }
    except Exception as e:
        return {"error": str(e)}


def full_preprocess(adata_path, min_genes=200, n_top_genes=2000):
    """完整预处理流程"""
    try:
        adata = sc.read_h5ad(adata_path)
        
        # 1. 计算 QC 指标
        sc.pp.calculate_qc_metrics(adata, percent_top=None, log1p=False, inplace=True)
        
        # 2. 过滤低质量细胞/基因
        sc.pp.filter_cells(adata, min_genes=int(min_genes))
        sc.pp.filter_genes(adata, min_cells=3)
        
        # 3. 标准化
        sc.pp.normalize_total(adata, target_sum=1e4)
        
        # 4. 对数变换
        sc.pp.log1p(adata)
        
        # 5. 特征选择
        sc.pp.highly_variable_genes(adata, n_top_genes=int(n_top_genes))
        adata = adata[:, adata.var.highly_variable]
        
        # 6. 缩放
        sc.pp.scale(adata, max_value=10)
        
        output = adata_path.replace('.h5ad', '_preprocessed.h5ad')
        adata.write_h5ad(output)
        
        return {
            "status": "success",
            "output": output,
            "steps": ["filter_cells", "filter_genes", "normalize", "log1p", "hvg", "scale"],
            "final_shape": {"cells": adata.n_obs, "genes": adata.n_vars}
        }
    except Exception as e:
        return {"error": str(e)}


def main():
    parser = argparse.ArgumentParser(description='单细胞预处理工具')
    parser.add_argument('file', help='AnnData 文件路径 (.h5ad)')
    parser.add_argument('action', nargs='?', default='info',
                        choices=['qc', 'normalize', 'log', 'hvg', 'full', 'info'],
                        help='操作类型')
    parser.add_argument('--min-genes', default=200, help='最小基因数')
    parser.add_argument('--max-genes', help='最大基因数')
    parser.add_argument('--max-counts', help='最大 counts')
    parser.add_argument('--n-top-genes', default=2000, help='高变基因数量')
    parser.add_argument('--target-sum', default=1e4, help='标准化目标值')
    
    args = parser.parse_args()
    
    if not Path(args.file).exists():
        print(json.dumps({"error": f"文件不存在: {args.file}"}))
        sys.exit(1)
    
    result = None
    if args.action == 'info':
        adata = sc.read_h5ad(args.file)
        result = {
            "status": "success",
            "cells": adata.n_obs,
            "genes": adata.n_vars,
            "obs_keys": list(adata.obs.columns[:10]),
            "var_keys": list(adata.var.columns[:10])
        }
    elif args.action == 'qc':
        result = qc_filter(args.file, args.min_genes, args.max_genes, args.max_counts)
    elif args.action == 'normalize':
        result = normalize(args.file, args.target_sum)
    elif args.action == 'log':
        result = log_transform(args.file)
    elif args.action == 'hvg':
        result = highly_variable_genes(args.file, args.n_top_genes)
    elif args.action == 'full':
        result = full_preprocess(args.file, args.min_genes, args.n_top_genes)
    
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
