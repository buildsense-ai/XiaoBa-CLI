#!/usr/bin/env python3
"""单细胞解读工具 - 细胞注释、差异表达、可视化"""
import sys
import json
import argparse
from pathlib import Path

try:
    import scanpy as sc
except ImportError:
    print(json.dumps({"error": "请先安装 scanpy: pip install scanpy"}))
    sys.exit(1)


def rank_genes(adata_path, groupby='leiden', method='t-test'):
    """差异表达分析"""
    try:
        adata = sc.read_h5ad(adata_path)
        
        if groupby not in adata.obs:
            return {"error": f"未找到分组: {groupby}"}
        
        sc.tl.rank_genes_groups(adata, groupby=groupby, method=method)
        
        # 获取每个 cluster 的 top 基因
        result = {"status": "success", "method": method, "groupby": groupby, "clusters": {}}
        
        names = adata.uns['rank_genes_groups']['names']
        scores = adata.uns['rank_genes_groups']['scores']
        cluster_keys = names.dtype.names
        
        for cluster_key in cluster_keys:
            genes = [row[cluster_key] for row in names]
            score_vals = [row[cluster_key] for row in scores]
            
            result["clusters"][cluster_key] = {
                "top_10_genes": genes[:10],
                "top_10_scores": [round(float(s), 4) for s in score_vals[:10]]
            }
        
        output = adata_path.replace('.h5ad', '_ranked.h5ad')
        adata.write_h5ad(output)
        result["output"] = output
        
        return result
    except Exception as e:
        return {"error": str(e)}


def annotate_celltypes(adata_path, markers_path=None):
    """基于 marker genes 进行细胞注释"""
    try:
        adata = sc.read_h5ad(adata_path)
        
        if 'rank_genes_groups' not in adata.uns:
            sc.tl.rank_genes_groups(adata, groupby='leiden', method='t-test')
        
        # 默认 marker genes 库（常见细胞类型）
        default_markers = {
            "B cells": ["CD19", "CD79A", "MS4A1", "CD20"],
            "T cells": ["CD3D", "CD3E", "CD3G", "CD2"],
            "CD8+ T": ["CD8A", "CD8B", "GZMK"],
            "CD4+ T": ["CD4", "IL7R", "LTB"],
            "NK cells": ["NKG7", "GNLY", "KLRD1"],
            "Monocytes": ["CD14", "CD68", "FCGR3A"],
            "Dendritic cells": ["FCER1A", "CD1C", "BLANKA"],
            "Macrophages": ["CD163", "MARCO", "C1QA"],
            "Neutrophils": ["FCGR3B", "S100A8", "S100A9"],
            "Plasma cells": ["IGHA1", "IGKC", "MZB1"],
            "Fibroblasts": ["COL1A1", "COL3A1", "FN1"],
            "Endothelial": ["PECAM1", "VWF", "CDH5"],
            "Epithelial": ["EPCAM", "KRT18", "KRT19"],
            "Myocytes": ["MYH1", "MYH2", "ACTN3"]
        }
        
        # 统计每个 cluster 的细胞类型
        names = adata.uns['rank_genes_groups']['names']
        cluster_keys = names.dtype.names  # ('0', '1', '2', ...)
        
        cluster_types = {}
        for cluster_key in cluster_keys:
            cluster_genes = [row[cluster_key] for row in names[:50]]
            cluster_genes_set = set(cluster_genes)
            
            matched_types = []
            for cell_type, markers in default_markers.items():
                overlap = len(set(markers) & cluster_genes_set)
                if overlap >= 1:
                    matched_types.append({
                        "cell_type": cell_type,
                        "matched_markers": list(set(markers) & cluster_genes_set),
                        "overlap_count": overlap
                    })
            
            matched_types.sort(key=lambda x: x['overlap_count'], reverse=True)
            cluster_types[cluster_key] = matched_types[:3] if matched_types else []
        
        return {
            "status": "success",
            "annotations": cluster_types,
            "marker_db": "built-in"
        }
    except Exception as e:
        return {"error": str(e)}


def dotplot(adata_path, genes, groupby='leiden', save_path=None):
    """绘制 dotplot（基因在 cluster 中的表达）"""
    try:
        adata = sc.read_h5ad(adata_path)
        gene_list = genes.split(',')
        
        if save_path is None:
            save_path = adata_path.replace('.h5ad', '_dotplot.png')
        
        # 检查基因是否在数据中
        available_genes = [g for g in gene_list if g in adata.var_names]
        missing = [g for g in gene_list if g not in adata.var_names]
        
        if available_genes:
            sc.pl.dotplot(adata, available_genes, groupby=groupby, save=save_path)
        
        return {
            "status": "success",
            "plot_path": save_path,
            "available_genes": available_genes,
            "missing_genes": missing
        }
    except Exception as e:
        return {"error": str(e)}


def heatmap(adata_path, genes, groupby='leiden', save_path=None):
    """绘制热图"""
    try:
        adata = sc.read_h5ad(adata_path)
        gene_list = genes.split(',')
        
        if save_path is None:
            save_path = adata_path.replace('.h5ad', '_heatmap.png')
        
        available_genes = [g for g in gene_list if g in adata.var_names]
        
        if available_genes:
            sc.pl.heatmap(adata, available_genes, groupby=groupby, save=save_path)
        
        return {
            "status": "success",
            "plot_path": save_path,
            "available_genes": available_genes
        }
    except Exception as e:
        return {"error": str(e)}


def violin(adata_path, genes, groupby='leiden', save_path=None):
    """绘制小提琴图"""
    try:
        adata = sc.read_h5ad(adata_path)
        gene_list = genes.split(',')
        
        if save_path is None:
            save_path = adata_path.replace('.h5ad', '_violin.png')
        
        available_genes = [g for g in gene_list if g in adata.var_names]
        
        if available_genes:
            sc.pl.stacked_violin(adata, available_genes, groupby=groupby, save=save_path)
        
        return {
            "status": "success",
            "plot_path": save_path,
            "available_genes": available_genes
        }
    except Exception as e:
        return {"error": str(e)}


def marker_table(adata_path, output_path=None, top_n=10):
    """导出 marker genes 表格"""
    try:
        adata = sc.read_h5ad(adata_path)
        
        if 'rank_genes_groups' not in adata.uns:
            sc.tl.rank_genes_groups(adata, groupby='leiden', method='t-test')
        
        if output_path is None:
            output_path = adata_path.replace('.h5ad', '_markers.csv')
        
        names = adata.uns['rank_genes_groups']['names']
        scores = adata.uns['rank_genes_groups']['scores']
        pvals = adata.uns['rank_genes_groups'].get('pvals')
        cluster_keys = names.dtype.names
        
        rows = []
        for cluster_key in cluster_keys:
            for i in range(min(int(top_n), len(names))):
                row = {
                    "cluster": cluster_key,
                    "gene": names[i][cluster_key],
                    "score": round(float(scores[i][cluster_key]), 4)
                }
                if pvals is not None:
                    row["pval"] = f"{pvals[i][cluster_key]:.2e}"
                rows.append(row)
        
        import pandas as pd
        df = pd.DataFrame(rows)
        df.to_csv(output_path, index=False)
        
        return {
            "status": "success",
            "output": output_path,
            "total_markers": len(rows)
        }
    except Exception as e:
        return {"error": str(e)}


def main():
    parser = argparse.ArgumentParser(description='单细胞解读工具')
    parser.add_argument('file', help='AnnData 文件路径 (.h5ad)')
    parser.add_argument('action', nargs='?', default='info',
                        choices=['rank', 'annotate', 'dotplot', 'heatmap', 'violin', 'markers', 'info'],
                        help='操作类型')
    parser.add_argument('--groupby', default='leiden', help='分组字段')
    parser.add_argument('--genes', help='基因列表（逗号分隔）')
    parser.add_argument('--method', default='t-test', help='差异分析方法')
    parser.add_argument('--top-n', default=10, help='每个 cluster 输出 top N 基因')
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
            "has_rank_genes": 'rank_genes_groups' in adata.uns
        }
    elif args.action == 'rank':
        result = rank_genes(args.file, args.groupby, args.method)
    elif args.action == 'annotate':
        result = annotate_celltypes(args.file)
    elif args.action == 'dotplot':
        result = dotplot(args.file, args.genes, args.groupby, args.save)
    elif args.action == 'heatmap':
        result = heatmap(args.file, args.genes, args.groupby, args.save)
    elif args.action == 'violin':
        result = violin(args.file, args.genes, args.groupby, args.save)
    elif args.action == 'markers':
        result = marker_table(args.file, args.save, args.top_n)
    
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
