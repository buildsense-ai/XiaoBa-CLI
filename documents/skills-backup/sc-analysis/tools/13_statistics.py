#!/usr/bin/env python3
"""
Step 13: 统计分析

【功能说明】
- 细胞比例差异检验（卡方检验/Fisher精确检验）
- 各cluster的组间差异分析
- 特征分布差异检验（t检验/Mann-Whitney/KS检验）
- 多重检验校正（FDR）

【用法】
    python tools/13_statistics.py \\
        --input annotated.h5ad \\
        --output ./statistics \\
        --groupby group \\
        --cluster-key cell_type

【参数说明】
    --input        : 输入h5ad文件
    --output       : 输出目录
    --groupby     : 分组列名，默认group
    --cluster-key : 细胞类型列名，默认cell_type

【统计方法】
    - 卡方检验: 细胞比例差异
    - t检验: 连续变量均值差异
    - Mann-Whitney: 非参数检验
    - KS检验: 分布差异

【输出】
    - cell_proportion_test.csv  : 细胞比例检验结果
    - cluster_diff_test.csv    : cluster差异检验
    - distribution_test.csv     : 分布检验结果
    - cell_proportions_stacked.png  # 堆叠柱状图
    - cell_proportions_facet.png    # 分面柱状图
    - cell_proportions_heatmap.png   # 热图

【示例】
    python tools/13_statistics.py -i annot/annotated.h5ad -o stats/ --groupby group
"""

__author__ = "CatsCo"
__version__ = "3.0.0"
import os
import sys
import argparse
import logging
from pathlib import Path
from scipy import stats
from statsmodels.stats.multitest import multipletests

import numpy as np
import pandas as pd
import anndata as ad
import matplotlib.pyplot as plt
import seaborn as sns

sys.path.insert(0, str(Path(__file__).parent.parent))
from utils.core_utils import ensure_dir, timing, logger

logging.basicConfig(level=logging.INFO, format='%(asctime)s | %(levelname)-8s | %(message)s', datefmt='%H:%M:%S')
logger = logging.getLogger(__name__)


@timing
def cell_proportion_test(adata: ad.AnnData,
                        groupby: str = 'group',
                        cluster_key: str = 'cell_type',
                        method: str = 'chi2') -> pd.DataFrame:
    """
    细胞比例差异检验
    
    比较不同组间各细胞类型的比例差异
    """
    logger.info(f"📊 细胞比例差异检验 ({method})...")
    
    # 计算比例
    prop_df = pd.crosstab(adata.obs[groupby], adata.obs[cluster_key], normalize='index') * 100
    
    # 卡方检验
    contingency = pd.crosstab(adata.obs[groupby], adata.obs[cluster_key])
    
    if method == 'chi2':
        chi2, pval, dof, expected = stats.chi2_contingency(contingency)
        logger.info(f"  Chi-square: χ²={chi2:.2f}, p={pval:.2e}")
        results = pd.DataFrame({
            'test': 'chi-square',
            'statistic': chi2,
            'pvalue': pval,
            'dof': dof
        }, index=[0])
    else:
        # Fisher精确检验
        oddsr, pval = stats.fisher_exact(contingency)
        results = pd.DataFrame({
            'test': 'fisher',
            'odds_ratio': oddsr,
            'pvalue': pval
        }, index=[0])
    
    return results


@timing
def dea_per_cluster(adata: ad.AnnData,
                   groupby: str = 'group',
                   cluster_key: str = 'leiden',
                   method: str = 't-test') -> pd.DataFrame:
    """
    每个cluster的组间差异分析
    
    对每个cluster分别做组间差异表达检验
    """
    logger.info(f"📊 Cluster特异性差异分析...")
    
    results = []
    
    for cluster in adata.obs[cluster_key].unique():
        cluster_cells = adata.obs[cluster_key] == cluster
        adata_subset = adata[cluster_cells]
        
        groups = adata_subset.obs[groupby].unique()
        if len(groups) < 2:
            continue
        
        # t-test or Mann-Whitney
        group_data = [adata_subset[adata_subset.obs[groupby] == g].obs['n_genes'].values for g in groups]
        
        if method == 't-test':
            stat, pval = stats.ttest_ind(*group_data)
        else:
            stat, pval = stats.mannwhitneyu(*group_data)
        
        results.append({
            'cluster': cluster,
            'n_cells': cluster_cells.sum(),
            'groups': f'{groups[0]} vs {groups[1]}',
            'statistic': stat,
            'pvalue': pval
        })
    
    df = pd.DataFrame(results)
    
    # 多重检验校正
    if not df.empty and 'pvalue' in df.columns:
        _, df['pvalue_adj'], _, _ = multipletests(df['pvalue'], method='fdr_bh')
        n_sig = (df['pvalue_adj'] < 0.05).sum()
        logger.info(f"  显著差异clusters: {n_sig}/{len(df)}")
    else:
        logger.info("  未检测到足够的分组进行差异分析")
    
    return df


@timing
def distribution_test(adata: ad.AnnData,
                      features: list = None,
                      groupby: str = 'group') -> pd.DataFrame:
    """
    分布差异检验
    
    检验两组在特定特征上的分布差异
    """
    logger.info("📊 特征分布差异检验...")
    
    if features is None:
        features = ['n_genes', 'n_counts', 'pct_mito']
    
    results = []
    
    for feature in features:
        if feature not in adata.obs.columns:
            continue
        
        groups = adata.obs[groupby].unique()
        if len(groups) < 2:
            logger.info(f"  跳过 {feature}: 分组数不足")
            continue
        
        group_data = [adata.obs.loc[adata.obs[groupby] == g, feature].values for g in groups]
        
        if len(group_data) >= 2:
            # t-test
            stat_t, pval_t = stats.ttest_ind(*group_data)
            
            # Mann-Whitney
            stat_mw, pval_mw = stats.mannwhitneyu(*group_data)
            
            # KS检验
            stat_ks, pval_ks = stats.ks_2samp(*group_data)
            
            results.append({
                'feature': feature,
                'mean_group1': np.mean(group_data[0]),
                'mean_group2': np.mean(group_data[1]),
                't_stat': stat_t,
                't_pval': pval_t,
                'mw_stat': stat_mw,
                'mw_pval': pval_mw,
                'ks_stat': stat_ks,
                'ks_pval': pval_ks
            })
    
    if not results:
        logger.info("  未检测到足够的分组进行分布检验")
        return pd.DataFrame()
    
    return pd.DataFrame(results)


def plot_cell_proportions(adata: ad.AnnData,
                         output_dir: str,
                         groupby: str = 'group',
                         cell_type_key: str = 'cell_type') -> None:
    """绘制细胞比例图"""
    logger.info("📊 绘制细胞比例图...")
    
    ensure_dir(output_dir)
    
    # 1. 堆叠柱状图
    fig, ax = plt.subplots(figsize=(12, 6))
    
    prop_df = pd.crosstab(adata.obs[cell_type_key], adata.obs[groupby], normalize='columns') * 100
    prop_df.T.plot(kind='bar', stacked=True, ax=ax, colormap='tab20')
    
    ax.set_xlabel(groupby)
    ax.set_ylabel('Cell Proportion (%)')
    ax.set_title('Cell Type Proportions by Group')
    ax.legend(title='Cell Type', bbox_to_anchor=(1.05, 1), loc='upper left')
    
    plt.tight_layout()
    plt.savefig(os.path.join(output_dir, 'cell_proportions_stacked.png'), dpi=200, bbox_inches='tight')
    plt.close()
    
    # 2. 分面柱状图
    fig, axes = plt.subplots(1, 2, figsize=(14, 5))
    
    for i, group in enumerate(adata.obs[groupby].unique()):
        group_data = adata.obs[adata.obs[groupby] == group][cell_type_key].value_counts(normalize=True) * 100
        group_data.plot(kind='bar', ax=axes[i], color='steelblue')
        axes[i].set_title(f'{group}')
        axes[i].set_ylabel('Proportion (%)')
        axes[i].tick_params(axis='x', rotation=45)
    
    plt.tight_layout()
    plt.savefig(os.path.join(output_dir, 'cell_proportions_facet.png'), dpi=200, bbox_inches='tight')
    plt.close()
    
    # 3. 热图
    fig, ax = plt.subplots(figsize=(10, 8))
    
    prop_matrix = pd.crosstab(adata.obs[cell_type_key], adata.obs[groupby], normalize='columns') * 100
    sns.heatmap(prop_matrix, annot=True, fmt='.1f', cmap='YlOrRd', ax=ax)
    ax.set_title('Cell Type Proportions Heatmap')
    ax.set_xlabel(groupby)
    ax.set_ylabel('Cell Type')
    
    plt.tight_layout()
    plt.savefig(os.path.join(output_dir, 'cell_proportions_heatmap.png'), dpi=200, bbox_inches='tight')
    plt.close()
    
    logger.info(f"  比例图保存到: {output_dir}")


def main():
    parser = argparse.ArgumentParser(description='Statistical Analysis')
    
    parser.add_argument('--input', '-i', required=True, help='输入h5ad文件')
    parser.add_argument('--output', '-o', required=True, help='输出目录')
    parser.add_argument('--groupby', default=None, help='分组列(默认sample)')
    parser.add_argument('--cluster-key', default='cell_type', help='细胞类型列')
    
    args = parser.parse_args()
    
    ensure_dir(args.output)
    
    logger.info(f"📖 读取数据: {args.input}")
    adata = ad.read_h5ad(args.input)
    
    # 自动检测groupby列
    if args.groupby is None:
        available_cols = ['sample', 'group', 'treatment', 'condition']
        args.groupby = None
        for col in available_cols:
            if col in adata.obs.columns:
                args.groupby = col
                break
        if args.groupby is None:
            # 使用第一个分类列
            for col in adata.obs.columns:
                if adata.obs[col].dtype.name == 'category':
                    args.groupby = col
                    break
            if args.groupby is None:
                args.groupby = adata.obs.columns[0]
    
    logger.info(f"  使用分组列: {args.groupby}")
    
    # 细胞比例检验
    if args.groupby in adata.obs.columns:
        prop_test = cell_proportion_test(adata, args.groupby, args.cluster_key)
        prop_test.to_csv(os.path.join(args.output, 'cell_proportion_test.csv'), index=False)
    
    # Cluster差异分析
    cluster_test = dea_per_cluster(adata, args.groupby, args.cluster_key)
    cluster_test.to_csv(os.path.join(args.output, 'cluster_diff_test.csv'), index=False)
    
    # 分布检验
    dist_test = distribution_test(adata, groupby=args.groupby)
    dist_test.to_csv(os.path.join(args.output, 'distribution_test.csv'), index=False)
    
    # 绘图
    plot_cell_proportions(adata, args.output, args.groupby, args.cluster_key)
    
    logger.info(f"✅ 统计分析完成！保存到: {args.output}")


if __name__ == '__main__':
    main()
