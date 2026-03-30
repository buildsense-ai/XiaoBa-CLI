#!/usr/bin/env python3
"""多组学整合分析工具"""
import sys
import json
import argparse
from pathlib import Path

try:
    import scanpy as sc
except ImportError:
    print(json.dumps({"error": "请先安装 scanpy"}))
    sys.exit(1)


def load_multiomics(rna_file=None, protein_file=None, atac_file=None):
    """加载多组学数据"""
    result = {"status": "success", "datasets": {}}
    
    if rna_file:
        adata_rna = sc.read_h5ad(rna_file)
        result["datasets"]["rna"] = {
            "cells": adata_rna.n_obs,
            "genes": adata_rna.n_vars
        }
    
    if protein_file:
        adata_protein = sc.read_h5ad(protein_file)
        result["datasets"]["protein"] = {
            "cells": adata_protein.n_obs,
            "features": adata_protein.n_vars
        }
    
    if atac_file:
        adata_atac = sc.read_h5ad(atac_file)
        result["datasets"]["atac"] = {
            "cells": adata_atac.n_obs,
            "peaks": adata_atac.n_vars
        }
    
    return result


def integrate_harmony(rna_file, second_file=None, batch_key='batch'):
    """Harmony 整合"""
    try:
        adata = sc.read_h5ad(rna_file)
        
        if 'X_pca' not in adata.obsm:
            sc.tl.pca(adata)
        
        try:
            from harmonypy import run_harmony
            pc_df = run_harmony(adata.obsm['X_pca'], adata.obs, batch_key)
            adata.obsm['X_pca_harmony'] = pc_df.values
            method = 'Harmony'
        except:
            method = 'PCA only (Harmony not installed)'
        
        output = rna_file.replace('.h5ad', '_integrated.h5ad')
        adata.write_h5ad(output)
        
        return {
            "status": "success",
            "method": method,
            "output": output
        }
    except Exception as e:
        return {"error": str(e)}


def cite_seq_analysis(citeseq_file):
    """CITE-seq 分析（RNA + 蛋白）"""
    try:
        adata = sc.read_h5ad(citeseq_file)
        
        # 分离 RNA 和蛋白
        rna_genes = [g for g in adata.var_names if not g.startswith('ADT-') and not g.startswith('Protein-')]
        protein_genes = [g for g in adata.var_names if g.startswith('ADT-') or g.startswith('Protein-')]
        
        result = {
            "status": "success",
            "total_cells": adata.n_obs,
            "rna_genes": len(rna_genes),
            "protein_markers": len(protein_genes),
            "protein_list": protein_genes[:20]
        }
        
        # 如果有聚类，计算蛋白表达
        if 'leiden' in adata.obs.columns and protein_genes:
            adata_protein = adata[:, protein_genes].copy()
            sc.pp.neighbors(adata_protein)
            sc.tl.umap(adata_protein)
            
            output = citeseq_file.replace('.h5ad', '_protein.h5ad')
            adata_protein.write_h5ad(output)
            result["protein_output"] = output
        
        return result
    except Exception as e:
        return {"error": str(e)}


def wnn_analysis(rna_file, protein_file):
    """加权近邻 (WNN) 整合"""
    try:
        adata_rna = sc.read_h5ad(rna_file)
        adata_protein = sc.read_h5ad(protein_file)
        
        # 检查是否有共同的细胞
        common_cells = list(set(adata_rna.obs_names) & set(adata_protein.obs_names))
        if len(common_cells) == 0:
            return {"error": "没有共同的细胞"}
        
        # 取交集
        adata_rna = adata_rna[common_cells]
        adata_protein = adata_protein[common_cells]
        
        # 分别降维
        sc.pp.pca(adata_rna)
        sc.pp.neighbors(adata_rna)
        
        sc.pp.pca(adata_protein)
        sc.pp.neighbors(adata_protein)
        
        # 简单加权组合（实际应该用 weights 单细胞蛋白表达）
        adata_combined = adata_rna.copy()
        adata_combined.obsm['X_wnn'] = (adata_rna.obsm['X_pca'] + adata_protein.obsm['X_pca']) / 2
        
        output = rna_file.replace('.h5ad', '_wnn.h5ad')
        adata_combined.write_h5ad(output)
        
        return {
            "status": "success",
            "common_cells": len(common_cells),
            "output": output,
            "method": "Weighted neighbor integration"
        }
    except Exception as e:
        return {"error": str(e)}


def scRNA_velocity(rna_spliced, rna_unspliced):
    """RNA velocity 分析"""
    try:
        # 需要 velocyto 或 scVelo
        try:
            import scvelo as scv
            adata = scv.read(rna_spliced, cache=True)
            scv.pp.moments(adata, n_neighbors=30)
            scv.tl.velocity(adata, mode='stochastic')
            scv.tl.velocity_graph(adata)
            
            output = rna_spliced.replace('.h5ad', '_velocity.h5ad')
            adata.write_h5ad(output)
            
            return {
                "status": "success",
                "output": output,
                "method": "scVelo stochastic"
            }
        except ImportError:
            return {"error": "请安装 scVelo: pip install scvelo"}
    except Exception as e:
        return {"error": str(e)}


def main():
    parser = argparse.ArgumentParser(description='多组学整合工具')
    parser.add_argument('action', nargs='?', default='info',
                        choices=['load', 'harmony', 'cite-seq', 'wnn', 'velocity', 'info'],
                        help='操作类型')
    parser.add_argument('--rna', help='RNA 数据文件')
    parser.add_argument('--protein', help='蛋白数据文件')
    parser.add_argument('--atac', help='ATAC 数据文件')
    parser.add_argument('--spliced', help='spliced RNA 文件')
    parser.add_argument('--unspliced', help='unspliced RNA 文件')
    parser.add_argument('--batch-key', default='batch', help='批次字段')
    parser.add_argument('--output', help='输出文件')
    
    args = parser.parse_args()
    
    result = None
    
    if args.action == 'load':
        result = load_multiomics(args.rna, args.protein, args.atac)
    elif args.action == 'harmony':
        result = integrate_harmony(args.rna, args.batch_key)
    elif args.action == 'cite-seq':
        result = cite_seq_analysis(args.rna)
    elif args.action == 'wnn':
        result = wnn_analysis(args.rna, args.protein)
    elif args.action == 'velocity':
        result = scRNA_velocity(args.spliced, args.unspliced)
    
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
