#!/usr/bin/env python3
"""单细胞数据读写工具 - 支持 10x Cell Ranger、AnnData 格式"""
import sys
import json
import argparse
from pathlib import Path

try:
    import scanpy as sc
except ImportError:
    print(json.dumps({"error": "请先安装 scanpy: pip install scanpy"}))
    sys.exit(1)


def read_10x_h5(filepath):
    """读取 10x Cell Ranger HDF5 格式"""
    try:
        adata = sc.read_10x_h5(filepath)
        return _format_result(adata, filepath)
    except Exception as e:
        return {"error": f"读取失败: {str(e)}"}


def read_10x_mtx(directory):
    """读取 10x Cell Ranger MTX 格式（目录）"""
    try:
        adata = sc.read_10x_mtx(directory, var_names='gene_symbols')
        return _format_result(adata, directory)
    except Exception as e:
        return {"error": f"读取失败: {str(e)}"}


def read_anndata(filepath):
    """读取 AnnData H5AD 格式"""
    try:
        adata = sc.read_h5ad(filepath)
        return _format_result(adata, filepath)
    except Exception as e:
        return {"error": f"读取失败: {str(e)}"}


def read_loom(filepath):
    """读取 Loom 格式"""
    try:
        adata = sc.read_loom(filepath)
        return _format_result(adata, filepath)
    except Exception as e:
        return {"error": f"读取失败: {str(e)}"}


def _format_result(adata, filepath):
    """格式化输出"""
    return {
        "status": "success",
        "file": filepath,
        "shape": {"cells": adata.n_obs, "genes": adata.n_vars},
        "obs_names": list(adata.obs_names[:10]),
        "var_names": list(adata.var_names[:10]),
        "layers": list(adata.layers.keys()) if adata.layers else [],
        "obs_keys": list(adata.obs.columns) if adata.obs.shape[1] > 0 else [],
        "uns_keys": list(adata.uns.keys()) if adata.uns else []
    }


def write_anndata(adata_path, output_path):
    """保存为 H5AD 格式"""
    try:
        adata = sc.read_h5ad(adata_path)
        adata.write_h5ad(output_path)
        return {"status": "success", "output": output_path}
    except Exception as e:
        return {"error": str(e)}


def subset_cells(adata_path, cell_ids):
    """按细胞 ID 筛选"""
    try:
        adata = sc.read_h5ad(adata_path)
        cells = json.loads(cell_ids)
        adata = adata[cells].copy()
        output = adata_path.replace('.h5ad', '_subset.h5ad')
        adata.write_h5ad(output)
        return {"status": "success", "original_cells": adata.n_obs, "output": output}
    except Exception as e:
        return {"error": str(e)}


def subset_genes(adata_path, gene_list):
    """按基因名筛选"""
    try:
        adata = sc.read_h5ad(adata_path)
        genes = json.loads(gene_list)
        adata = adata[:, genes].copy()
        output = adata_path.replace('.h5ad', '_genes.h5ad')
        adata.write_h5ad(output)
        return {"status": "success", "original_genes": adata.n_vars, "output": output}
    except Exception as e:
        return {"error": str(e)}


def main():
    parser = argparse.ArgumentParser(description='单细胞数据读写工具')
    parser.add_argument('file', help='数据文件路径')
    parser.add_argument('action', nargs='?', default='info',
                        choices=['info', 'read', 'convert', 'subset-cells', 'subset-genes'],
                        help='操作类型')
    parser.add_argument('--output', '-o', help='输出路径')
    parser.add_argument('--cell-ids', help='细胞ID列表 (JSON)')
    parser.add_argument('--gene-list', help='基因名列表 (JSON)')
    
    args = parser.parse_args()
    
    if not Path(args.file).exists():
        print(json.dumps({"error": f"文件不存在: {args.file}"}))
        sys.exit(1)
    
    result = None
    if args.action == 'info':
        # 自动检测格式
        if args.file.endswith('.h5ad'):
            result = read_anndata(args.file)
        elif args.file.endswith('.loom'):
            result = read_loom(args.file)
        else:
            result = {"error": "info 需要 h5ad 或 loom 格式"}
    elif args.action == 'read':
        if args.file.endswith('.h5'):
            result = read_10x_h5(args.file)
        else:
            result = read_anndata(args.file)
    elif args.action == 'convert' and args.output:
        result = write_anndata(args.file, args.output)
    elif args.action == 'subset-cells' and args.cell_ids:
        result = subset_cells(args.file, args.cell_ids)
    elif args.action == 'subset-genes' and args.gene_list:
        result = subset_genes(args.file, args.gene_list)
    else:
        result = read_anndata(args.file)
    
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
