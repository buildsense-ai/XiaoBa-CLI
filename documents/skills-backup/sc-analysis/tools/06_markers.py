#!/usr/bin/env python3
"""
Step 06: Marker基因鉴定

【功能说明】
- Wilcoxon秩和检验识别每个cluster的特征基因
- 自动过滤线粒体、核糖体、血红蛋白基因
- 输出每个cluster的top N marker基因
- 生成热图、点图、小提琴图、FeaturePlot

【用法】
    python tools/06_markers.py \\
        --input annotated.h5ad \\
        --output ./markers \\
        --groupby leiden \\
        --min-pct 0.2 \\
        --logfc 0.25 \\
        --top-n 10

【参数说明】
    --input     : 输入h5ad文件
    --output    : 输出目录
    --groupby   : 分组列名，默认leiden
    --min-pct  : 基因在cluster中表达的最小比例，默认0.2
    --logfc    : logFC阈值，默认0.25
    --top-n    : 每个cluster输出的top N markers，默认10
    --method   : 统计方法 (wilcoxon/ttest)

【输出】
    - markers.csv           : 所有Marker基因列表
    - marker_dotplot.png   : 特征点图
    - cluster_*_markers.png # 每个cluster的marker小提琴图
    - top_markers_featureplot.png # top marker的UMAP图

【示例】
    python tools/06_markers.py -i annot/annotated.h5ad -o markers/
"""

__author__ = "CatsCo"
__version__ = "3.1.0"

import os
import sys
import argparse
import logging
from pathlib import Path
from typing import List, Optional

import numpy as np
import pandas as pd
import anndata as ad
import scanpy as sc
import matplotlib.pyplot as plt

sys.path.insert(0, str(Path(__file__).parent.parent))
from utils.core_utils import ensure_dir, timing, logger

logging.basicConfig(level=logging.INFO, format='%(asctime)s | %(levelname)-8s | %(message)s', datefmt='%H:%M:%S')
logger = logging.getLogger(__name__)

# R脚本的配色方案
COLOR_PANEL = ['#53A85F','#58A4C3','#AB3282','#8C549C','#BD956A','#57C3F3',
               '#6778AE','#F3B1A0','#F1BB72','#DCC1DD','#E95C59','#625D9E',
               '#F7F398','#E63863','#5F3D69','#C5DEBA','#CCE0F5','#B53E2B',
               '#AA9A59','#E39A35','#91D0BE','#23452F','#E4C755','#585658',
               '#C1E6F3','#D6E7A3','#712820','#CCC9E6','#3A6963','#68A180',
               '#476D87','#9FA3A8','#968175']

# MT基因过滤模式（R脚本风格）
MT_PATTERNS = ['^MT-', '^mt-', '^Mt-']  # 兼容不同物种大小写


@timing
def find_markers_presto(adata: ad.AnnData,
                        groupby: str = 'leiden',
                        min_pct: float = 0.2,
                        logfc_thresh: float = 0.25,
                        use_presto: bool = True,
                        filter_mt: bool = True) -> pd.DataFrame:
    """
    使用presto加速的Wilcoxon检验找Marker基因（R脚本风格增强）
    
    来自 marker-gene.R 的增强版：
    - MT基因自动过滤
    - 核糖体基因过滤
    - 血红蛋白基因过滤
    """
    logger.info(f"🧬 Marker基因鉴定 (Wilcoxon, min_pct={min_pct}, logFC>{logfc_thresh})...")
    
    # 过滤线粒体、核糖体、血红蛋白基因（R脚本风格）
    if filter_mt:
        adata.var['mt'] = adata.var_names.str.match('|'.join(MT_PATTERNS))
        adata.var['ribo'] = adata.var_names.str.startswith(('RPS', 'RPL', 'Rps', 'Rpl'))
        adata.var['hb'] = adata.var_names.str.contains('HB[P]?', case=False, regex=True)
        
        n_mt = adata.var['mt'].sum()
        n_ribo = adata.var['ribo'].sum()
        n_hb = adata.var['hb'].sum()
        
        adata = adata[:, ~adata.var['mt'] & ~adata.var['ribo'] & ~adata.var['hb']].copy()
        logger.info(f"  过滤基因: MT={n_mt}, Ribo={n_ribo}, HB={n_hb}")
    
    # Wilcoxon检验
    logger.info("  运行Wilcoxon秩和检验...")
    sc.tl.rank_genes_groups(
        adata,
        groupby=groupby,
        method='wilcoxon',
        min_logfoldchange=logfc_thresh,
        min_percent=min_pct,
        pts=True,
        tie_correct=True
    )
    
    # 提取结果
    result = adata.uns['rank_genes_groups']
    groups = list(result['names'].dtype.names)
    
    all_markers = []
    for group in groups:
        genes = result['names'][group]
        logfc = result['logfoldchanges'][group]
        pvals = result['pvals'][group]
        pvals_adj = result['pvals_adj'][group]
        pts = result['pts'][group] if 'pts' in result else None
        
        for i in range(len(genes)):
            gene = genes[i]
            marker = {
                'cluster': group,
                'gene': gene,
                'logFC': logfc[i],
                'pval': pvals[i],
                'pval_adj': pvals_adj[i]
            }
            if pts is not None and isinstance(pts, dict):
                marker['pct_in_cluster'] = pts[group].get(gene, 0) if isinstance(pts[group], dict) else 0
                not_group = f'not_{group}'
                marker['pct_out_cluster'] = pts.get(not_group, {}).get(gene, 0) if isinstance(pts.get(not_group), dict) else 0
            else:
                marker['pct_in_cluster'] = 0
                marker['pct_out_cluster'] = 0
            all_markers.append(marker)
    
    df = pd.DataFrame(all_markers)
    df = df.sort_values(['cluster', 'pval_adj'])
    
    n_sig = (df['pval_adj'] < 0.05).sum()
    logger.info(f"  找到 {len(df)} 个Marker基因, {n_sig} 个显著 (p_adj < 0.05)")
    
    return df


@timing
def find_markers_ttest(adata: ad.AnnData,
                       groupby: str = 'leiden',
                       n_genes: int = 50) -> pd.DataFrame:
    """t-test找Marker基因（快速）"""
    logger.info(f"🧬 Marker基因鉴定 (t-test, top {n_genes})...")
    
    sc.tl.rank_genes_groups(
        adata,
        groupby=groupby,
        method='t-test',
        n_genes=n_genes
    )
    
    result = adata.uns['rank_genes_groups']
    groups = list(result['names'].dtype.names)
    
    all_markers = []
    for group in groups:
        for i in range(n_genes):
            all_markers.append({
                'cluster': group,
                'gene': result['names'][group][i],
                'logFC': result['logfoldchanges'][group][i],
                'pval_adj': result['pvals_adj'][group][i]
            })
    
    return pd.DataFrame(all_markers)


def add_gene_description(markers_df: pd.DataFrame, 
                        gene_annot_file: str = None) -> pd.DataFrame:
    """
    添加基因描述注释（R脚本风格，来自marker-gene.R）
    
    Args:
        markers_df: marker基因DataFrame
        gene_annot_file: 基因注释文件路径（两列：gene_name, gene_description）
    
    Returns:
        添加了gene_description列的DataFrame
    """
    if gene_annot_file is None or not os.path.exists(gene_annot_file):
        return markers_df
    
    try:
        annot_df = pd.read_csv(gene_annot_file, sep='\t')
        if 'gene_name' in annot_df.columns and 'gene_description' in annot_df.columns:
            gene_desc = dict(zip(annot_df['gene_name'], annot_df['gene_description']))
            markers_df['gene_description'] = markers_df['gene'].map(gene_desc)
            logger.info(f"  添加基因描述: {markers_df['gene_description'].notna().sum()} 个基因有注释")
    except Exception as e:
        logger.warning(f"  无法读取基因注释: {e}")
    
    return markers_df


@timing
def plot_markers(adata: ad.AnnData,
                markers_df: pd.DataFrame,
                output_dir: str,
                n_top: int = 5,
                n_genes_show: int = 30,
                custom_genes: list = None) -> None:
    """
    绘制Marker基因图（R脚本风格增强版）
    
    来自 marker-gene.R 的增强版：
    - 热图、点图
    - 每个cluster的小提琴图和FeaturePlot
    - 自定义基因列表可视化
    """
    ensure_dir(output_dir)
    ensure_dir(os.path.join(output_dir, 'heatmap'))
    ensure_dir(os.path.join(output_dir, 'violin'))
    ensure_dir(os.path.join(output_dir, 'featureplot'))
    
    logger.info("📊 绘制Marker基因图...")
    
    # 获取主聚类列
    leiden_cols = [c for c in adata.obs.columns if c.startswith('leiden_')]
    primary_cluster = leiden_cols[0] if leiden_cols else 'leiden'
    
    # 使用raw数据（如果有）
    plot_adata = adata.raw.to_adata() if adata.raw is not None else adata
    
    # 1. 热图 - Top Markers Dotplot
    top_genes = markers_df.groupby('cluster').head(n_top)['gene'].unique()[:n_genes_show]
    valid_genes = [g for g in top_genes if g in plot_adata.var_names]
    
    if valid_genes:
        fig = sc.pl.dotplot(
            adata,
            valid_genes,
            groupby=primary_cluster,
            dendrogram=True,
            show=False,
            return_fig=True
        )
        fig.savefig(os.path.join(output_dir, 'heatmap', f'top{n_top}_dotplot.png'), dpi=200, bbox_inches='tight')
        plt.close()
        
        # 2. DoHeatmap风格热图 - 使用scanpy默认保存
        sc.pl.heatmap(
            adata,
            valid_genes[:min(50, len(valid_genes))],
            groupby=primary_cluster,
            dendrogram=True,
            show=False,
            save='_marker_heatmap.png'
        )
    
    # 3. 小提琴图和FeaturePlot - 每个cluster（R脚本风格）
    clusters = list(adata.obs[primary_cluster].unique())
    for cluster in clusters:
        cluster_markers = markers_df[markers_df['cluster'] == cluster].head(n_top + 2)['gene'].tolist()
        valid = [g for g in cluster_markers if g in plot_adata.var_names]
        
        if valid:
            # 小提琴图
            try:
                fig = sc.pl.violin(
                    adata,
                    valid,
                    groupby=primary_cluster,
                    rotation=45,
                    show=False,
                    return_fig=True
                )
                fig.savefig(os.path.join(output_dir, 'violin', f'violin_cluster{cluster}.png'), 
                           dpi=100, bbox_inches='tight')
                plt.close()
            except Exception as e:
                logger.warning(f"  集群 {cluster} 小提琴图失败: {e}")
            
            # FeaturePlot
            try:
                cluster_cells = adata.obs[primary_cluster] == cluster
                if cluster_cells.sum() > 50:  # 只对有足够细胞的cluster绘制
                    fig = sc.pl.umap(
                        adata[cluster_cells],
                        color=valid[:8],
                        ncols=4,
                        frameon=False,
                        show=False,
                        return_fig=True,
                        vmin=0,
                        cmap='lightblue_orange_red'
                    )
                    fig.savefig(os.path.join(output_dir, 'featureplot', f'featureplot_cluster{cluster}.png'),
                               dpi=100, bbox_inches='tight')
                    plt.close()
            except Exception as e:
                logger.warning(f"  集群 {cluster} FeaturePlot失败: {e}")
    
    # 4. Feature plot - Top marker per cluster（合并图）
    top_per_cluster = markers_df.groupby('cluster').first().reset_index()
    feature_genes = []
    for _, row in top_per_cluster.head(6).iterrows():
        if row['gene'] in plot_adata.var_names:
            feature_genes.append(row['gene'])
    
    if feature_genes:
        fig = sc.pl.umap(
            adata,
            color=feature_genes,
            ncols=3,
            frameon=False,
            show=False,
            return_fig=True,
            vmin=0,
            cmap='viridis'
        )
        fig.savefig(os.path.join(output_dir, 'top_markers_featureplot.png'), dpi=200, bbox_inches='tight')
        plt.close()
    
    # 5. 自定义基因列表可视化（R脚本风格）
    if custom_genes:
        ensure_dir(os.path.join(output_dir, 'custom_genes'))
        custom_genes = [g for g in custom_genes if g in plot_adata.var_names]
        
        if custom_genes:
            logger.info(f"  绘制自定义基因列表 ({len(custom_genes)} 个基因)...")
            
            # 小提琴图
            try:
                fig = sc.pl.violin(
                    adata,
                    custom_genes,
                    groupby=primary_cluster,
                    rotation=45,
                    show=False,
                    return_fig=True
                )
                fig.savefig(os.path.join(output_dir, 'custom_genes', 'custom_violin.png'),
                          dpi=150, bbox_inches='tight')
                plt.close()
            except Exception as e:
                logger.warning(f"  自定义基因小提琴图失败: {e}")
            
            # FeaturePlot
            try:
                fig = sc.pl.umap(
                    adata,
                    color=custom_genes[:8],
                    ncols=4,
                    frameon=False,
                    show=False,
                    return_fig=True,
                    vmin=0,
                    cmap='lightblue_orange_red'
                )
                fig.savefig(os.path.join(output_dir, 'custom_genes', 'custom_featureplot.png'),
                          dpi=150, bbox_inches='tight')
                plt.close()
            except Exception as e:
                logger.warning(f"  自定义基因FeaturePlot失败: {e}")
    
    logger.info(f"  图表保存到: {output_dir}")


def main():
    parser = argparse.ArgumentParser(description='Marker Gene Detection (R脚本风格增强版)')
    
    parser.add_argument('--input', '-i', required=True, help='输入h5ad文件')
    parser.add_argument('--output', '-o', required=True, help='输出目录')
    parser.add_argument('--groupby', default=None, help='分组列')
    parser.add_argument('--min-pct', type=float, default=0.2, help='最小表达比例')
    parser.add_argument('--logfc', type=float, default=0.25, help='logFC阈值')
    parser.add_argument('--method', default='wilcoxon', choices=['wilcoxon', 'ttest'])
    parser.add_argument('--top-n', type=int, default=10, help='每个cluster的top N markers')
    parser.add_argument('--custom-genes', default=None, help='自定义基因列表（逗号分隔）')
    parser.add_argument('--gene-annot', default=None, help='基因注释文件路径（gene_name\\tgene_description）')
    parser.add_argument('--no-filter', action='store_true', help='不过滤MT/核糖体基因')
    
    args = parser.parse_args()
    
    ensure_dir(args.output)
    
    logger.info(f"📖 读取数据: {args.input}")
    adata = ad.read_h5ad(args.input)
    
    # 自动检测聚类列
    if args.groupby is None:
        leiden_cols = [c for c in adata.obs.columns if c.startswith('leiden_')]
        if leiden_cols:
            args.groupby = leiden_cols[0]
            logger.info(f"  自动选择聚类列: {args.groupby}")
        else:
            args.groupby = 'leiden'
    
    # Marker基因鉴定
    filter_mt = not args.no_filter
    if args.method == 'wilcoxon':
        markers = find_markers_presto(adata, args.groupby, args.min_pct, args.logfc, filter_mt=filter_mt)
    else:
        markers = find_markers_ttest(adata, args.groupby)
    
    # 添加基因描述（R脚本风格）
    if args.gene_annot:
        markers = add_gene_description(markers, args.gene_annot)
    
    # 分离显著和不显著的marker
    sig_markers = markers[markers['pval_adj'] < 0.05]
    
    # 保存（R脚本风格命名）
    markers.to_csv(os.path.join(args.output, 'all_markers.csv'), index=False)
    sig_markers.to_csv(os.path.join(args.output, 'sig_markers.csv'), index=False)
    
    # 保存top N marker
    top_n_markers = sig_markers.groupby('cluster').head(args.top_n)
    top_n_markers.to_csv(os.path.join(args.output, f'top{args.top_n}_markers.csv'), index=False)
    
    # 绘图
    custom_genes = args.custom_genes.split(',') if args.custom_genes else None
    plot_markers(adata, markers, args.output, args.top_n, custom_genes=custom_genes)
    
    # 保存adata
    adata.write_h5ad(os.path.join(args.output, 'with_markers.h5ad'))
    
    logger.info(f"✅ Marker鉴定完成！保存到: {args.output}")
    logger.info(f"   总Marker: {len(markers)}")
    logger.info(f"   显著Marker: {len(sig_markers)}")


if __name__ == '__main__':
    main()
