#!/usr/bin/env python3
"""单细胞高级 QC 工具 - 批次校正、doublet 检测、细胞周期"""
import sys
import json
import argparse
from pathlib import Path

try:
    import scanpy as sc
except ImportError:
    print(json.dumps({"error": "请先安装 scanpy: pip install scanpy"}))
    sys.exit(1)


def batch_correction(adata_path, batch_key='batch'):
    """批次效应校正"""
    try:
        adata = sc.read_h5ad(adata_path)
        
        if batch_key not in adata.obs:
            return {"error": f"未找到批次字段: {batch_key}"}
        
        batches = adata.obs[batch_key].unique()
        if len(batches) < 2:
            return {"error": "需要至少2个批次才能进行批次校正"}
        
        # 检查是否有原始 counts
        if 'counts' in adata.layers:
            adata.X = adata.layers['counts']
        elif 'raw' in adata.layers:
            adata.X = adata.layers['raw']
        
        # Harmony 批次校正
        try:
            from harmonypy import run_harmony
            pc_df = run_harmony(adata.obsm['X_pca'], adata.obs, batch_key)
            adata.obsm['X_pca'] = pc_df.values
            method = 'Harmony'
        except ImportError:
            # 回退到 Combat
            sc.pp.combat(adata, key=batch_key)
            method = 'ComBat'
        
        output = adata_path.replace('.h5ad', f'_batch_corrected.h5ad')
        adata.write_h5ad(output)
        
        return {
            "status": "success",
            "method": method,
            "batches": list(batches),
            "output": output
        }
    except Exception as e:
        return {"error": str(e)}


def doublet_detection(adata_path, expected_doublets=None):
    """双细胞检测"""
    try:
        adata = sc.read_h5ad(adata_path)
        
        if expected_doublets is None:
            # 根据细胞数估算
            expected_doublets = int(adata.n_obs * 0.05)
        
        try:
            from scrublet import scrublet
            adata.obs['doublet_score'], adata.obs['predicted_doublet'] = scrublet(
                adata.X, expected_doublet_rate=expected_doublets/adata.n_obs
            )
            method = 'Scrublet'
        except ImportError:
            # 回退到简单方法：基于高基因数
            adata.obs['n_genes'] = (adata.X > 0).sum(axis=1)
            threshold = adata.obs['n_genes'].quantile(0.95)
            adata.obs['doublet_score'] = (adata.obs['n_genes'] > threshold).astype(float)
            adata.obs['predicted_doublet'] = adata.obs['n_genes'] > threshold
            method = 'Simple threshold'
        
        doublet_count = adata.obs['predicted_doublet'].sum()
        
        output = adata_path.replace('.h5ad', '_doublets.h5ad')
        adata.write_h5ad(output)
        
        return {
            "status": "success",
            "method": method,
            "total_cells": int(adata.n_obs),
            "doublets_detected": int(doublet_count),
            "doublet_rate": round(doublet_count / adata.n_obs * 100, 2),
            "output": output
        }
    except Exception as e:
        return {"error": str(e)}


def filter_doublets(adata_path):
    """移除双细胞"""
    try:
        adata = sc.read_h5ad(adata_path)
        
        if 'predicted_doublet' not in adata.obs:
            return {"error": "请先运行 doublet 检测"}
        
        original = adata.n_obs
        adata = adata[~adata.obs['predicted_doublet']].copy()
        
        output = adata_path.replace('.h5ad', '_singlets.h5ad')
        adata.write_h5ad(output)
        
        return {
            "status": "success",
            "original_cells": original,
            "filtered_cells": adata.n_obs,
            "removed": original - adata.n_obs,
            "output": output
        }
    except Exception as e:
        return {"error": str(e)}


def cell_cycle(adata_path, species='human'):
    """细胞周期分析"""
    try:
        adata = sc.read_h5ad(adata_path)
        
        if species == 'human':
            cc_genes = sc.tl.read_reaction_rules('reprogramming_cc_genes_Human')
        else:
            cc_genes = sc.tl.read_reaction_rules('reprogramming_cc_genes_Mouse')
        
        sc.tl.score_gene_cell_cycle(adata, cc_genes, species=species.capitalize())
        
        phases = adata.obs['phase'].value_counts().to_dict()
        
        output = adata_path.replace('.h5ad', '_cellcycle.h5ad')
        adata.write_h5ad(output)
        
        return {
            "status": "success",
            "phases": {k: int(v) for k, v in phases.items()},
            "output": output
        }
    except Exception as e:
        return {"error": str(e)}


def mitochondrial_filter(adata_path, percent_mito=20):
    """过滤高线粒体基因细胞"""
    try:
        adata = sc.read_h5ad(adata_path)
        
        if 'percent_mito' not in adata.obs:
            sc.pp.calculate_qc_metrics(adata, percent_top=None, log1p=False, inplace=True)
        
        original = adata.n_obs
        adata = adata[adata.obs['percent_mito'] < float(percent_mito)].copy()
        
        output = adata_path.replace('.h5ad', '_mito_filtered.h5ad')
        adata.write_h5ad(output)
        
        return {
            "status": "success",
            "threshold": percent_mito,
            "original_cells": original,
            "filtered_cells": adata.n_obs,
            "removed": original - adata.n_obs,
            "output": output
        }
    except Exception as e:
        return {"error": str(e)}


def SoupX_correct(adata_path, contamination=0.05):
    """SoupX 污染校正（简化版）"""
    try:
        adata = sc.read_h5ad(adata_path)
        
        # 简化版：基于表达的污染校正
        genes = adata.var_names
        n_cells = (adata.X > 0).sum(axis=1).A1 if hasattr(adata.X, 'A1') else (adata.X > 0).sum(axis=1)
        
        # 估算污染比例
        contamination_fraction = float(contamination)
        
        # 简单校正：从每个表达值中减去污染
        import scipy.sparse as sp
        X_corrected = adata.X - contamination_fraction * adata.X.mean(axis=0)
        X_corrected = sp.csr_matrix.maximum(X_corrected, 0)
        
        adata.layers['corrected'] = X_corrected
        adata.X = X_corrected
        
        output = adata_path.replace('.h5ad', '_soupx_corrected.h5ad')
        adata.write_h5ad(output)
        
        return {
            "status": "success",
            "method": "Simple contamination correction",
            "contamination_fraction": contamination_fraction,
            "output": output
        }
    except Exception as e:
        return {"error": str(e)}


def main():
    parser = argparse.ArgumentParser(description='单细胞高级 QC 工具')
    parser.add_argument('file', help='AnnData 文件路径 (.h5ad)')
    parser.add_argument('action', nargs='?', default='info',
                        choices=['batch', 'doublet', 'filter-doublets', 'cellcycle', 'mito', 'soupx', 'info'],
                        help='操作类型')
    parser.add_argument('--batch-key', default='batch', help='批次字段名')
    parser.add_argument('--expected-doublets', type=int, help='预期双细胞数')
    parser.add_argument('--percent-mito', default=20, help='线粒体阈值')
    parser.add_argument('--contamination', default=0.05, help='SoupX 污染比例')
    parser.add_argument('--species', default='human', help='物种')
    
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
            "obs_keys": list(adata.obs.columns[:15]),
            "available_qc": {
                "has_batch": args.batch_key in adata.obs,
                "has_doublet": 'predicted_doublet' in adata.obs,
                "has_mito": 'percent_mito' in adata.obs,
                "has_cellcycle": 'phase' in adata.obs
            }
        }
    elif args.action == 'batch':
        result = batch_correction(args.file, args.batch_key)
    elif args.action == 'doublet':
        result = doublet_detection(args.file, args.expected_doublets)
    elif args.action == 'filter-doublets':
        result = filter_doublets(args.file)
    elif args.action == 'cellcycle':
        result = cell_cycle(args.file, args.species)
    elif args.action == 'mito':
        result = mitochondrial_filter(args.file, args.percent_mito)
    elif args.action == 'soupx':
        result = SoupX_correct(args.file, args.contamination)
    
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
