#!/usr/bin/env python3
"""
Step 04: 多分辨率聚类 + UMAP/t-SNE可视化

【功能说明】
- 使用Leiden算法进行聚类（比Louvain更准确）
- 多分辨率同时计算：0.2/0.4/0.6/0.8/1.0
- UMAP + t-SNE双可视化
- 自动生成聚类分布统计

【用法】
    python tools/04_clustering.py \\
        --input integrated.h5ad \\
        --output ./clustering \\
        --resolutions 0.2,0.4,0.6,0.8,1.0 \\
        --n-neighbors 15 \\
        --n-pcs 50

【参数说明】
    --input        : 输入h5ad文件
    --output       : 输出目录
    --resolutions : 逗号分隔的分辨率列表，默认0.2,0.4,0.6,0.8,1.0
    --n-neighbors : 邻居数，默认15
    --n-pcs       : PCA维度，默认50
    --reduction    : 使用的降维表示 (pca/scvi/harmony/bbknn)
    --no-tsne     : 跳过t-SNE计算

【输出】
    - clustered.h5ad     : 聚类后的AnnData对象
    - cluster_umap.png   : UMAP聚类图
    - cluster_tsne.png   : t-SNE聚类图
    - sample_umap.png    : 按样本分布图
    - group_umap.png     : 按分组分布图
    - cluster_distribution.png : 聚类分布柱状图
    - cluster_statistics.csv   : 聚类统计表
    - multi_resolution.png     : 多分辨率对比图

【示例】
    # 标准用法
    python tools/04_clustering.py -i int/integrated.h5ad -o cluster/
    
    # 自定义分辨率
    python tools/04_clustering.py -i int/integrated.h5ad -o cluster/ --resolutions 0.3,0.6,1.0
"""

__author__ = "CatsCo"
__version__ = "3.0.0"
import os
import sys
import argparse
import logging
from pathlib import Path
from typing import List

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
def cluster_leiden(adata: ad.AnnData,
                   resolution: float = 0.5,
                   n_neighbors: int = 15,
                   n_pcs: int = 50,
                   key: str = None) -> ad.AnnData:
    """
    Leiden聚类 - 比Louvain更准确
    
    Leiden算法保证聚类结果具有良好的连接性，
    是目前最推荐的单细胞聚类算法
    """
    if key is None:
        key = f'leiden_{resolution}'
    
    logger.info(f"🔵 Leiden聚类 (resolution={resolution}, k={n_neighbors})...")
    
    # Leiden聚类
    sc.tl.leiden(
        adata,
        resolution=resolution,
        key_added=key,
        random_state=42
    )
    
    n_clusters = adata.obs[key].nunique()
    logger.info(f"  识别到 {n_clusters} 个cluster")
    
    return adata


@timing
def multi_resolution_clustering(adata: ad.AnnData,
                               resolutions: List[float] = [0.2, 0.4, 0.6, 0.8, 1.0],
                               n_neighbors: int = 15,
                               n_pcs: int = 50) -> ad.AnnData:
    """
    多分辨率聚类 - 同时计算多个分辨率的聚类结果
    
    低分辨率: 大细胞群
    高分辨率: 细分组
    """
    logger.info(f"🎯 多分辨率聚类: {resolutions}")
    
    for res in resolutions:
        adata = cluster_leiden(adata, resolution=res, n_neighbors=n_neighbors, n_pcs=n_pcs)
    
    return adata


@timing
def compute_umap(adata: ad.AnnData,
                reduction: str = 'pca',
                n_neighbors: int = 15,
                min_dist: float = 0.3,
                metric: str = 'cosine') -> ad.AnnData:
    """计算UMAP"""
    logger.info("📍 计算UMAP...")
    
    # 确定使用的降维表示
    if reduction == 'pca':
        use_rep = 'X_pca'
    elif reduction == 'scvi':
        use_rep = 'X_scvi'
    elif reduction == 'harmony':
        use_rep = 'X_harmony'
    elif reduction == 'bbknn':
        use_rep = None  # BBKNN已经更新了邻居
    else:
        use_rep = 'X_pca'
    
    # UMAP
    sc.tl.umap(
        adata,
        min_dist=min_dist,
        spread=1.0,
        neighbors_key=reduction if use_rep is None else 'neighbors'
    )
    
    adata.obsm['X_umap'] = adata.obsm['X_umap']
    logger.info("  UMAP计算完成")
    
    return adata


@timing
def compute_tsne(adata: ad.AnnData,
                perplexity: int = 30,
                n_pcs: int = 50) -> ad.AnnData:
    """计算t-SNE"""
    logger.info("📍 计算t-SNE...")
    
    sc.tl.tsne(adata, n_pcs=n_pcs, perplexity=perplexity, random_state=42)
    
    adata.obsm['X_tsne'] = adata.obsm['X_tsne']
    logger.info("  t-SNE计算完成")
    
    return adata


@timing
def plot_clustering_results(adata: ad.AnnData,
                           output_dir: str,
                           reduction: str = 'umap') -> None:
    """绘制聚类结果"""
    ensure_dir(output_dir)
    
    logger.info(f"📊 绘制聚类结果...")
    
    # 颜色方案 - 使用第一个resolution的聚类结果
    leiden_cols = [c for c in adata.obs.columns if c.startswith('leiden_')]
    primary_cluster = leiden_cols[0] if leiden_cols else 'leiden'
    n_clusters = adata.obs[primary_cluster].nunique() if primary_cluster in adata.obs else 10
    palette = sns.color_palette('tab20', n_clusters) if n_clusters <= 20 else sns.color_palette('husl', n_clusters)
    
    # 1. 聚类UMAP
    fig = sc.pl.umap(adata, color=primary_cluster, 
                    title='Leiden Clustering',
                    palette=palette,
                    frameon=False,
                    show=False,
                    return_fig=True)
    fig.savefig(os.path.join(output_dir, 'cluster_umap.png'), dpi=200, bbox_inches='tight')
    plt.close()
    
    # 2. 样本UMAP
    if 'sample' in adata.obs:
        fig = sc.pl.umap(adata, color='sample',
                        title='Samples',
                        frameon=False, show=False, return_fig=True)
        fig.savefig(os.path.join(output_dir, 'sample_umap.png'), dpi=200, bbox_inches='tight')
        plt.close()
    
    # 3. 分组UMAP (如果有)
    if 'group' in adata.obs:
        fig = sc.pl.umap(adata, color='group',
                        title='Groups',
                        frameon=False, show=False, return_fig=True)
        fig.savefig(os.path.join(output_dir, 'group_umap.png'), dpi=200, bbox_inches='tight')
        plt.close()
    
    # 4. 细胞周期UMAP
    if 'Phase' in adata.obs:
        fig = sc.pl.umap(adata, color='Phase',
                        title='Cell Cycle',
                        frameon=False, show=False, return_fig=True)
        fig.savefig(os.path.join(output_dir, 'cellcycle_umap.png'), dpi=200, bbox_inches='tight')
        plt.close()
    
    # 5. 质控指标UMAP
    qc_features = ['n_genes', 'n_counts', 'pct_mito']
    available_qc = [f for f in qc_features if f in adata.obs]
    if available_qc:
        fig = sc.pl.umap(adata, color=available_qc,
                        title=['Genes', 'Counts', 'Mito %'],
                        frameon=False, show=False, return_fig=True, ncols=3)
        fig.savefig(os.path.join(output_dir, 'qc_umap.png'), dpi=200, bbox_inches='tight')
        plt.close()
    
    # 6. 多分辨率对比
    leiden_cols = [c for c in adata.obs.columns if c.startswith('leiden_')]
    if len(leiden_cols) > 1:
        fig, axes = plt.subplots(2, 3, figsize=(15, 10))
        for i, col in enumerate(leiden_cols[:6]):
            ax = axes.flat[i]
            res = col.replace('leiden_', '')
            sc.pl.umap(adata, color=col, ax=ax, show=False, title=f'Resolution={res}')
        plt.tight_layout()
        plt.savefig(os.path.join(output_dir, 'multi_resolution.png'), dpi=200, bbox_inches='tight')
        plt.close()
    
    # 7. t-SNE
    if 'X_tsne' in adata.obsm:
        fig = sc.pl.tsne(adata, color=primary_cluster, 
                        title='t-SNE',
                        palette=palette,
                        frameon=False, show=False, return_fig=True)
        fig.savefig(os.path.join(output_dir, 'cluster_tsne.png'), dpi=200, bbox_inches='tight')
        plt.close()
    
    # 8. 聚类分布柱状图
    fig, ax = plt.subplots(figsize=(12, 5))
    cluster_counts = adata.obs[primary_cluster].value_counts().sort_index()
    cluster_counts.plot(kind='bar', ax=ax, color=palette)
    ax.set_xlabel('Cluster')
    ax.set_ylabel('Cell Count')
    ax.set_title('Cluster Distribution')
    plt.tight_layout()
    plt.savefig(os.path.join(output_dir, 'cluster_distribution.png'), dpi=150, bbox_inches='tight')
    plt.close()
    
    logger.info(f"✅ 图表保存到: {output_dir}")


@timing
def save_cluster_statistics(adata: ad.AnnData, output_dir: str) -> pd.DataFrame:
    """保存聚类统计"""
    ensure_dir(output_dir)
    
    # 获取主聚类列
    leiden_cols = [c for c in adata.obs.columns if c.startswith('leiden_')]
    primary_cluster = leiden_cols[0] if leiden_cols else 'leiden'
    
    # Cluster基本统计 - 只统计存在的列
    agg_cols = {}
    for col in ['n_genes', 'n_counts', 'pct_mito']:
        if col in adata.obs.columns:
            agg_cols[col] = ['mean', 'std', 'min', 'max']
    
    if agg_cols:
        stats = adata.obs.groupby(primary_cluster).agg(agg_cols).round(2)
        stats.columns = ['_'.join(col) for col in stats.columns]
    else:
        stats = pd.DataFrame(index=adata.obs[primary_cluster].unique())
    
    stats['n_cells'] = adata.obs.groupby(primary_cluster).size()
    stats['pct_total'] = (stats['n_cells'] / len(adata) * 100).round(2)
    
    # 样本分布
    if 'sample' in adata.obs.columns:
        sample_dist = pd.crosstab(adata.obs[primary_cluster], adata.obs['sample'], normalize='index') * 100
        sample_dist.to_csv(os.path.join(output_dir, 'cluster_sample_distribution.csv'))
    
    # 保存
    stats.to_csv(os.path.join(output_dir, 'cluster_statistics.csv'))
    
    logger.info(f"统计已保存: {output_dir}")
    return stats


def main():
    parser = argparse.ArgumentParser(description='Clustering and Visualization')
    
    parser.add_argument('--input', '-i', required=True, help='输入h5ad文件')
    parser.add_argument('--output', '-o', required=True, help='输出目录')
    parser.add_argument('--resolutions', type=str, default='0.2,0.4,0.6,0.8,1.0',
                       help='逗号分隔的分辨率列表')
    parser.add_argument('--n-neighbors', type=int, default=15, help='邻居数')
    parser.add_argument('--n-pcs', type=int, default=50, help='PCA维度')
    parser.add_argument('--reduction', default='pca', choices=['pca', 'scvi', 'harmony', 'bbknn'],
                       help='使用的降维表示')
    parser.add_argument('--no-tsne', action='store_true', help='跳过t-SNE')
    
    args = parser.parse_args()
    
    ensure_dir(args.output)
    
    logger.info(f"📖 读取数据: {args.input}")
    adata = ad.read_h5ad(args.input)
    
    # 解析分辨率
    resolutions = [float(x) for x in args.resolutions.split(',')]
    
    # 多分辨率聚类
    adata = multi_resolution_clustering(adata, resolutions, args.n_neighbors, args.n_pcs)
    
    # UMAP
    adata = compute_umap(adata, args.reduction)
    
    # t-SNE
    if not args.no_tsne:
        adata = compute_tsne(adata)
    
    # 绘图
    plot_clustering_results(adata, args.output, args.reduction)
    
    # 统计
    save_cluster_statistics(adata, args.output)
    
    # 保存
    output_path = os.path.join(args.output, 'clustered.h5ad')
    adata.write_h5ad(output_path)
    logger.info(f"✅ 保存到: {output_path}")


if __name__ == '__main__':
    main()
