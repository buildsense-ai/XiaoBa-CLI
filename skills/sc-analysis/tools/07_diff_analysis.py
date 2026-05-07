#!/usr/bin/env python3
"""
Step 07: 差异分析

【功能说明】
- 两组间差异基因检测（处理组 vs 对照组）
- 每个cluster的组间差异
- 多重检验校正（FDR）
- 自动火山图、热图可视化

【用法】
    python tools/07_diff_analysis.py \\
        --input annotated.h5ad \\
        --output ./diff \\
        --groupby group \\
        --group1 treat \\
        --group2 ctrl \\
        --pval 0.05 \\
        --logfc 0.25

【参数说明】
    --input       : 输入h5ad文件
    --output      : 输出目录
    --groupby     : 分组列名，默认group
    --group1      : 组1名称（处理组）
    --group2      : 组2名称（对照组），可选，不填则group1 vs rest
    --cluster-key : 聚类列名，可选
    --method      : 统计方法 (wilcoxon/t-test/logreg)
    --pval        : P值阈值，默认0.05
    --logfc       : logFC阈值，默认0.25

【输出】
    - differential_genes.csv : 差异基因列表
    - volcano.png           : 火山图
    - diff_genes_heatmap.png # 热图

【示例】
    # 处理组 vs 对照组
    python tools/07_diff_analysis.py -i annot/annotated.h5ad -o diff/ \\
        --groupby group --group1 treat --group2 ctrl
    
    # cluster特异性差异
    python tools/07_diff_analysis.py -i annot/annotated.h5ad -o diff/ \\
        --cluster-key leiden
"""

__author__ = "CatsCo"
__version__ = "3.0.0"
import os
import sys
import argparse
import logging
from pathlib import Path

import numpy as np
import pandas as pd
import anndata as ad
import scanpy as sc
import matplotlib.pyplot as plt
import seaborn as sns

sys.path.insert(0, str(Path(__file__).parent.parent))
from utils.core_utils import ensure_dir, timing, logger

logging.basicConfig(level=logging.INFO, format='%(asctime)s | %(levelname)-8s | %(message)s', datefmt='%H:%M:%S')
logger = logging.getLogger(__name__)


@timing
def diff_analysis(adata: ad.AnnData,
                 groupby: str = None,
                 group1: str = None,
                 group2: str = None,
                 cluster_key: str = None,
                 method: str = 'wilcoxon',
                 pval_thresh: float = 0.05,
                 logfc_thresh: float = 0.25) -> pd.DataFrame:
    """
    差异分析 - 两组或多组比较
    
    支持:
    - 样本组间比较 (group1 vs group2)
    - Cluster间比较 (每个cluster vs rest)
    - Cluster特异性比较 (cluster X vs cluster Y)
    """
    # 自动检测groupby列
    if groupby is None and cluster_key is None:
        leiden_cols = [c for c in adata.obs.columns if c.startswith('leiden_')]
        if leiden_cols:
            groupby = leiden_cols[0]
        elif 'leiden' in adata.obs.columns:
            groupby = 'leiden'
        elif 'group' in adata.obs.columns:
            groupby = 'group'
        else:
            groupby = adata.obs.columns[0]
    
    if cluster_key is None and groupby and groupby.startswith('leiden'):
        cluster_key = groupby
    
    logger.info(f"📊 差异分析 ({groupby}: {group1 or 'all'} vs {group2 or 'rest'})...")
    
    # 设置分析组
    if group1 and group2:
        # 特定组间比较
        adata_subset = adata[adata.obs[groupby].isin([group1, group2])].copy()
        adata_subset.obs[groupby] = adata_subset.obs[groupby].cat.remove_unused_categories()
        
        sc.tl.rank_genes_groups(
            adata_subset,
            groupby=groupby,
            groups=[group1],
            reference=group2,
            method=method,
            tie_correct=True,
            pts=True
        )
    elif cluster_key and cluster_key in adata.obs.columns:
        # Cluster间比较
        sc.tl.rank_genes_groups(
            adata,
            groupby=cluster_key,
            groups=[group1] if group1 else list(adata.obs[cluster_key].unique())[:5],
            reference=group2 if group2 else 'rest',
            method=method,
            tie_correct=True,
            pts=True
        )
    else:
        # 所有组比较
        if groupby not in adata.obs.columns:
            logger.error(f"  列 '{groupby}' 不存在")
            return pd.DataFrame()
        sc.tl.rank_genes_groups(
            adata,
            groupby=groupby,
            method=method,
            tie_correct=True,
            pts=True
        )
    
    # 提取结果
    result = adata.uns['rank_genes_groups']
    groups = list(result['names'].dtype.names)
    
    all_degs = []
    for group in groups:
        genes = result['names'][group]
        logfc = result['logfoldchanges'][group]
        pvals = result['pvals'][group]
        pvals_adj = result['pvals_adj'][group]
        
        for i in range(len(genes)):
            all_degs.append({
                'group': group,
                'gene': genes[i],
                'logFC': logfc[i],
                'pval': pvals[i],
                'pval_adj': pvals_adj[i]
            })
    
    df = pd.DataFrame(all_degs)
    
    # 过滤
    df = df[df['pval_adj'] < pval_thresh]
    df = df[abs(df['logFC']) > logfc_thresh]
    df = df.sort_values(['group', 'pval_adj'])
    
    # 添加方向
    df['direction'] = np.where(df['logFC'] > 0, 'up', 'down')
    
    n_up = (df['direction'] == 'up').sum()
    n_down = (df['direction'] == 'down').sum()
    logger.info(f"  显著差异基因: 上调 {n_up}, 下调 {n_down}")
    
    return df


@timing
def volcano_plot(deg_df: pd.DataFrame,
                output_path: str,
                title: str = "Volcano Plot",
                pval_col: str = 'pval_adj',
                logfc_col: str = 'logFC',
                pval_thresh: float = 0.05,
                logfc_thresh: float = 0.25) -> None:
    """绘制火山图"""
    logger.info("🌋 绘制火山图...")
    
    fig, ax = plt.subplots(figsize=(10, 8))
    
    # 颜色
    colors = []
    for _, row in deg_df.iterrows():
        if row[pval_col] < pval_thresh and row[logfc_col] > logfc_thresh:
            colors.append('#E74C3C')  # 上调-红
        elif row[pval_col] < pval_thresh and row[logfc_col] < -logfc_thresh:
            colors.append('#3498DB')  # 下调-蓝
        else:
            colors.append('#95A5A6')  # 不显著-灰
    
    # 散点图
    ax.scatter(deg_df[logfc_col], -np.log10(deg_df[pval_col]),
              c=colors, alpha=0.6, s=20, edgecolors='none')
    
    # 标注线
    ax.axhline(-np.log10(pval_thresh), color='gray', linestyle='--', alpha=0.5, linewidth=1)
    ax.axvline(logfc_thresh, color='gray', linestyle='--', alpha=0.5, linewidth=1)
    ax.axvline(-logfc_thresh, color='gray', linestyle='--', alpha=0.5, linewidth=1)
    
    # 标注Top基因
    top_genes = deg_df.head(10)
    for _, row in top_genes.iterrows():
        ax.annotate(
            row['gene'],
            (row[logfc_col], -np.log10(row[pval_col])),
            fontsize=8,
            alpha=0.8,
            xytext=(5, 5),
            textcoords='offset points'
        )
    
    ax.set_xlabel('log2 Fold Change', fontsize=12)
    ax.set_ylabel('-log10(adjusted p-value)', fontsize=12)
    ax.set_title(title, fontsize=14)
    
    # 图例
    from matplotlib.patches import Patch
    legend_elements = [
        Patch(facecolor='#E74C3C', label='Up-regulated'),
        Patch(facecolor='#3498DB', label='Down-regulated'),
        Patch(facecolor='#95A5A6', label='Not significant')
    ]
    ax.legend(handles=legend_elements, loc='upper right')
    
    plt.tight_layout()
    plt.savefig(output_path, dpi=200, bbox_inches='tight')
    plt.close()
    
    logger.info(f"  火山图保存: {output_path}")


@timing
def plot_diff_heatmap(adata: ad.AnnData,
                     deg_df: pd.DataFrame,
                     output_dir: str,
                     groupby: str = 'sample',
                     n_genes: int = 50) -> None:
    """绘制差异基因热图"""
    logger.info("🔥 绘制差异基因热图...")
    
    # 取top基因
    top_genes = deg_df.groupby('group').head(n_genes)['gene'].unique()
    valid_genes = [g for g in top_genes if g in adata.raw.var_names][:50]
    
    if not valid_genes:
        logger.warning("  没有找到有效的差异基因")
        return
    
    # 标准化
    adata_scaled = adata.copy()
    sc.pp.scale(adata_scaled)
    
    # 热图
    plt.figure()
    sc.pl.heatmap(
        adata_scaled,
        valid_genes,
        groupby=groupby,
        dendrogram=True,
        show=False,
        cmap='RdBu_r',
        vmin=-2, vmax=2
    )
    plt.savefig(os.path.join(output_dir, 'diff_genes_heatmap.png'), dpi=200, bbox_inches='tight')
    plt.close()


def main():
    parser = argparse.ArgumentParser(description='Differential Expression Analysis')
    
    parser.add_argument('--input', '-i', required=True, help='输入h5ad文件')
    parser.add_argument('--output', '-o', required=True, help='输出目录')
    parser.add_argument('--groupby', default='group', help='分组列')
    parser.add_argument('--group1', help='组1名称')
    parser.add_argument('--group2', help='组2名称')
    parser.add_argument('--cluster-key', default='leiden', help='聚类列')
    parser.add_argument('--method', default='wilcoxon', choices=['wilcoxon', 't-test', 'logreg'])
    parser.add_argument('--pval', type=float, default=0.05, help='P值阈值')
    parser.add_argument('--logfc', type=float, default=0.25, help='logFC阈值')
    
    args = parser.parse_args()
    
    ensure_dir(args.output)
    
    logger.info(f"📖 读取数据: {args.input}")
    adata = ad.read_h5ad(args.input)
    
    # 差异分析
    degs = diff_analysis(
        adata,
        groupby=args.groupby,
        group1=args.group1,
        group2=args.group2,
        cluster_key=args.cluster_key,
        method=args.method,
        pval_thresh=args.pval,
        logfc_thresh=args.logfc
    )
    
    # 保存结果
    degs.to_csv(os.path.join(args.output, 'differential_genes.csv'), index=False)
    
    # 火山图
    if args.group1:
        volcano_plot(
            degs,
            os.path.join(args.output, 'volcano.png'),
            title=f"{args.group1} vs {args.group2 or 'rest'}",
            pval_thresh=args.pval,
            logfc_thresh=args.logfc
        )
    
    # 热图
    plot_diff_heatmap(adata, degs, args.output, groupby=args.groupby)
    
    logger.info(f"✅ 差异分析完成！保存到: {args.output}")


if __name__ == '__main__':
    main()
