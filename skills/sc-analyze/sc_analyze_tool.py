#!/usr/bin/env python3
"""单细胞分析与可视化工具 - PCA、UMAP、降维、聚类"""
import sys
import json
import argparse
from pathlib import Path

try:
    import scanpy as sc
except ImportError:
    print(json.dumps({"error": "请先安装 scanpy: pip install scanpy"}))
    sys.exit(1)


def run_pca(adata_path, n_comps=50, use_highly_variable=True):
    """PCA 降维"""
    try:
        adata = sc.read_h5ad(adata_path)
        sc.tl.pca(adata, n_comps=int(n_comps), use_highly_variable=use_highly_variable)
        
        output = adata_path.replace('.h5ad', '_pca.h5ad')
        adata.write_h5ad(output)
        
        # 获取方差解释比例
        var_ratio = list(adata.uns['pca']['variance_ratio'][:10])
        
        return {
            "status": "success",
            "output": output,
            "n_comps": n_comps,
            "top10_var_ratio": [round(v, 4) for v in var_ratio],
            "cumulative_var": round(sum(var_ratio[:10]), 4)
        }
    except Exception as e:
        return {"error": str(e)}


def compute_neighbors(adata_path, n_pcs=50, n_neighbors=15):
    """计算邻域"""
    try:
        adata = sc.read_h5ad(adata_path)
        sc.pp.neighbors(adata, n_pcs=int(n_pcs), n_neighbors=int(n_neighbors))
        
        output = adata_path.replace('.h5ad', '_neighbors.h5ad')
        adata.write_h5ad(output)
        
        return {
            "status": "success",
            "output": output,
            "n_pcs": n_pcs,
            "n_neighbors": n_neighbors
        }
    except Exception as e:
        return {"error": str(e)}


def run_umap(adata_path, min_dist=0.5):
    """UMAP 可视化"""
    try:
        adata = sc.read_h5ad(adata_path)
        if 'neighbors' not in adata.uns:
            sc.pp.neighbors(adata)
        
        sc.tl.umap(adata, min_dist=min_dist)
        
        output = adata_path.replace('.h5ad', '_umap.h5ad')
        adata.write_h5ad(output)
        
        return {"status": "success", "output": output, "min_dist": min_dist}
    except Exception as e:
        return {"error": str(e)}


def run_tsne(adata_path, perplexity=30):
    """t-SNE 可视化"""
    try:
        adata = sc.read_h5ad(adata_path)
        sc.tl.tsne(adata, perplexity=int(perplexity))
        
        output = adata_path.replace('.h5ad', '_tsne.h5ad')
        adata.write_h5ad(output)
        
        return {"status": "success", "output": output, "perplexity": perplexity}
    except Exception as e:
        return {"error": str(e)}


def cluster_leiden(adata_path, resolution=1.0):
    """Leiden 聚类"""
    try:
        adata = sc.read_h5ad(adata_path)
        if 'neighbors' not in adata.uns:
            sc.pp.neighbors(adata)
        
        sc.tl.leiden(adata, resolution=float(resolution))
        
        # 统计各 cluster 细胞数
        cluster_counts = adata.obs['leiden'].value_counts().to_dict()
        
        output = adata_path.replace('.h5ad', '_leiden.h5ad')
        adata.write_h5ad(output)
        
        return {
            "status": "success",
            "output": output,
            "n_clusters": len(cluster_counts),
            "cluster_sizes": {k: int(v) for k, v in cluster_counts.items()}
        }
    except Exception as e:
        return {"error": str(e)}


def cluster_louvain(adata_path, resolution=1.0):
    """Louvain 聚类"""
    try:
        adata = sc.read_h5ad(adata_path)
        if 'neighbors' not in adata.uns:
            sc.pp.neighbors(adata)
        
        sc.tl.louvain(adata, resolution=float(resolution))
        
        cluster_counts = adata.obs['louvain'].value_counts().to_dict()
        
        output = adata_path.replace('.h5ad', '_louvain.h5ad')
        adata.write_h5ad(output)
        
        return {
            "status": "success",
            "output": output,
            "n_clusters": len(cluster_counts),
            "cluster_sizes": {k: int(v) for k, v in cluster_counts.items()}
        }
    except Exception as e:
        return {"error": str(e)}


def plot_umap(adata_path, color=None, save_path=None):
    """绘制 UMAP 图"""
    try:
        adata = sc.read_h5ad(adata_path)
        if 'X_umap' not in adata.obsm:
            if 'neighbors' not in adata.uns:
                sc.pp.neighbors(adata)
            sc.tl.umap(adata)
        
        if save_path is None:
            save_path = adata_path.replace('.h5ad', '_umap.png')
        
        if color:
            sc.pl.umap(adata, color=color.split(','), show=False, save=save_path)
        else:
            sc.pl.umap(adata, color='leiden', show=False)
        
        return {"status": "success", "plot_path": save_path}
    except Exception as e:
        return {"error": str(e)}


def full_analysis(adata_path, n_pcs=50, n_neighbors=15, resolution=1.0):
    """完整分析流程：PCA → neighbors → UMAP → Leiden"""
    try:
        adata = sc.read_h5ad(adata_path)
        
        # PCA
        sc.tl.pca(adata, n_comps=int(n_pcs))
        
        # 邻域
        sc.pp.neighbors(adata, n_pcs=int(n_pcs), n_neighbors=int(n_neighbors))
        
        # UMAP
        sc.tl.umap(adata)
        
        # Leiden 聚类
        sc.tl.leiden(adata, resolution=float(resolution))
        
        # 计算 degree centrality
        cluster_counts = adata.obs['leiden'].value_counts().to_dict()
        
        output = adata_path.replace('.h5ad', '_analyzed.h5ad')
        adata.write_h5ad(output)
        
        return {
            "status": "success",
            "output": output,
            "steps": ["pca", "neighbors", "umap", "leiden"],
            "n_clusters": len(cluster_counts),
            "cluster_sizes": {k: int(v) for k, v in cluster_counts.items()}
        }
    except Exception as e:
        return {"error": str(e)}


def main():
    parser = argparse.ArgumentParser(description='单细胞分析工具')
    parser.add_argument('file', help='AnnData 文件路径 (.h5ad)')
    parser.add_argument('action', nargs='?', default='info',
                        choices=['pca', 'neighbors', 'umap', 'tsne', 'leiden', 'louvain', 'plot', 'full', 'info'],
                        help='操作类型')
    parser.add_argument('--n-comps', default=50, help='PCA 主成分数')
    parser.add_argument('--n-neighbors', default=15, help='邻域数')
    parser.add_argument('--resolution', default=1.0, help='聚类分辨率')
    parser.add_argument('--min-dist', default=0.5, help='UMAP min_dist')
    parser.add_argument('--color', help='绘图颜色字段（逗号分隔）')
    parser.add_argument('--save', help='图片保存路径')
    
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
            "has_pca": 'X_pca' in adata.obsm,
            "has_umap": 'X_umap' in adata.obsm,
            "has_tsne": 'X_tsne' in adata.obsm,
            "clusters": list(adata.obs.columns[adata.obs.columns.str.contains('leiden|louvain')])
        }
    elif args.action == 'pca':
        result = run_pca(args.file, args.n_comps)
    elif args.action == 'neighbors':
        result = compute_neighbors(args.file, args.n_comps, args.n_neighbors)
    elif args.action == 'umap':
        result = run_umap(args.file, args.min_dist)
    elif args.action == 'tsne':
        result = run_tsne(args.file)
    elif args.action == 'leiden':
        result = cluster_leiden(args.file, args.resolution)
    elif args.action == 'louvain':
        result = cluster_louvain(args.file, args.resolution)
    elif args.action == 'plot':
        result = plot_umap(args.file, args.color, args.save)
    elif args.action == 'full':
        result = full_analysis(args.file, args.n_comps, args.n_neighbors, args.resolution)
    
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
