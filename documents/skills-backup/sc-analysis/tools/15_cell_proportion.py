#!/usr/bin/env python3
"""
Step 15: 细胞比例分析

【功能说明】
- 计算各细胞类型的数量和比例
- 生成细胞类型占比柱状图
- 生成分组堆叠柱状图
- 统计表输出

【用法】
    python tools/15_cell_proportion.py \\
        --input clustered.h5ad \\
        --output ./cell_proportion \\
        --celltype leiden_0.2 \\
        --group sample

【参数说明】
    --input     : 输入h5ad文件
    --output    : 输出目录
    --celltype  : 细胞类型列名（默认自动检测）
    --group     : 分组列名（可选）

【输出】
    - celltype_proportion.csv     : 细胞类型比例表
    - group_celltype_proportion.csv : 分组比例表
    - celltype_proportion_barplot.png : 细胞类型占比柱状图
    - group_celltype_stacked.png : 分组堆叠柱状图
    - proportion_comparison.png   : 组间比例对比图
"""

__author__ = "CatsCo"
__version__ = "3.1.0"

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

# R脚本的配色方案
COLOR_PANEL = ['#53A85F','#58A4C3','#AB3282','#8C549C','#BD956A','#57C3F3',
               '#6778AE','#F3B1A0','#F1BB72','#DCC1DD','#E95C59','#625D9E',
               '#F7F398','#E63863','#5F3D69','#C5DEBA','#CCE0F5','#B53E2B',
               '#AA9A59','#E39A35','#91D0BE','#23452F','#E4C755','#585658',
               '#C1E6F3','#D6E7A3','#712820','#CCC9E6','#3A6963','#68A180',
               '#476D87','#9FA3A8','#968175']


@timing
def cell_proportion_analysis(adata: ad.AnnData,
                            celltype_col: str = None,
                            group_col: str = None,
                            sample_col: str = 'sample') -> dict:
    """
    细胞比例分析（R脚本风格增强版）
    
    来自 cell-number.R 的多维度分析：
    - 按分组统计
    - 按样本统计
    - 按cluster统计
    
    Args:
        adata: AnnData对象
        celltype_col: 细胞类型/聚类列
        group_col: 分组列
        sample_col: 样本列
    
    Returns:
        包含统计结果的字典
    """
    # 自动检测列
    if celltype_col is None:
        leiden_cols = [c for c in adata.obs.columns if c.startswith('leiden_')]
        celltype_col = leiden_cols[0] if leiden_cols else 'leiden'
        logger.info(f"  自动选择细胞类型列: {celltype_col}")
    
    if celltype_col not in adata.obs.columns:
        logger.error(f"  列 '{celltype_col}' 不存在")
        return {}
    
    # 自动检测样本列
    if sample_col not in adata.obs.columns:
        sample_col = 'orig.ident' if 'orig.ident' in adata.obs.columns else None
    
    # 自动检测分组列
    if group_col is None:
        for col in ['group', 'Group', 'treatment', 'Treatment', 'condition', 'Condition']:
            if col in adata.obs.columns:
                group_col = col
                break
    
    logger.info(f"📊 细胞比例分析 ({celltype_col})...")
    
    results = {}
    
    # 1. 细胞数统计（保存每个样本的细胞数）
    if sample_col and sample_col in adata.obs.columns:
        sample_stats = adata.obs[sample_col].value_counts().reset_index()
        sample_stats.columns = ['sample', 'cell_number']
        results['sample_stats'] = sample_stats
        logger.info(f"  样本细胞数: {sample_stats.to_dict('records')}")
    
    # 2. 计算细胞类型比例
    celltype_counts = adata.obs[celltype_col].value_counts().sort_values(ascending=False)
    celltype_prop = pd.DataFrame({
        'CellType': celltype_counts.index,
        'Count': celltype_counts.values,
        'Proportion': celltype_counts.values / celltype_counts.sum()
    })
    celltype_prop['Percentage'] = celltype_prop['Proportion'] * 100
    
    results['celltype'] = celltype_prop
    logger.info(f"  共 {len(celltype_prop)} 个细胞类型")
    
    # 3. 按分组统计
    if group_col and group_col in adata.obs.columns:
        all_group_data = []
        
        for ct in adata.obs[celltype_col].unique():
            for grp in adata.obs[group_col].unique():
                n_cells = ((adata.obs[celltype_col] == ct) & (adata.obs[group_col] == grp)).sum()
                n_total = (adata.obs[group_col] == grp).sum()
                pct = 100 * n_cells / n_total if n_total > 0 else 0
                
                all_group_data.append({
                    'cell_type': ct,
                    'group': grp,
                    'cell_number': n_cells,
                    'Proportion': pct / 100,
                    'Percentage': pct
                })
        
        results['group_celltype'] = pd.DataFrame(all_group_data)
        logger.info(f"  分组统计完成")
    
    # 4. 按样本统计
    if sample_col and sample_col in adata.obs.columns:
        all_sample_data = []
        
        for ct in adata.obs[celltype_col].unique():
            for samp in adata.obs[sample_col].unique():
                n_cells = ((adata.obs[celltype_col] == ct) & (adata.obs[sample_col] == samp)).sum()
                n_total = (adata.obs[sample_col] == samp).sum()
                pct = 100 * n_cells / n_total if n_total > 0 else 0
                
                all_sample_data.append({
                    'cell_type': ct,
                    'sample': samp,
                    'cell_number': n_cells,
                    'Proportion': pct / 100,
                    'Percentage': pct
                })
        
        results['sample_celltype'] = pd.DataFrame(all_sample_data)
        logger.info(f"  样本统计完成")
    
    # 5. 按cluster（细胞类型）内分组占比
    if group_col and group_col in adata.obs.columns:
        all_cluster_data = []
        
        for ct in adata.obs[celltype_col].unique():
            for grp in adata.obs[group_col].unique():
                n_cells = ((adata.obs[celltype_col] == ct) & (adata.obs[group_col] == grp)).sum()
                n_total = (adata.obs[celltype_col] == ct).sum()
                pct = 100 * n_cells / n_total if n_total > 0 else 0
                
                all_cluster_data.append({
                    'cell_type': ct,
                    'group': grp,
                    'cell_number': n_cells,
                    'Proportion': pct / 100,
                    'Percentage': pct
                })
        
        results['cluster_group'] = pd.DataFrame(all_cluster_data)
        logger.info(f"  Cluster内分组统计完成")
    
    return results


def plot_celltype_proportion(prop_df: pd.DataFrame,
                            output_path: str,
                            title: str = "Cell Type Proportion") -> None:
    """绘制细胞类型占比柱状图（R脚本风格增强）"""
    logger.info("📊 绘制细胞类型占比柱状图...")
    
    fig, ax = plt.subplots(figsize=(max(10, len(prop_df) * 0.5), 6))
    
    # 使用R脚本配色
    colors = COLOR_PANEL[:len(prop_df)]
    
    bars = ax.bar(prop_df['CellType'].astype(str), prop_df['Proportion'], color=colors, edgecolor='black', linewidth=0.5)
    
    ax.set_xlabel('Cell Type', fontsize=12)
    ax.set_ylabel('Proportion', fontsize=12)
    ax.set_title(title, fontsize=14)
    
    # 添加数值标签（R脚本风格）
    for bar, pct, count in zip(bars, prop_df['Percentage'], prop_df['Count']):
        height = bar.get_height()
        ax.text(bar.get_x() + bar.get_width()/2., height + 0.01,
               f'{pct:.1f}%\n({count})', ha='center', va='bottom', fontsize=7)
    
    ax.set_xticklabels(prop_df['CellType'].astype(str), rotation=45, ha='right')
    ax.yaxis.set_major_formatter(plt.FuncFormatter(lambda y, _: f'{y:.0%}'))
    ax.spines['top'].set_visible(False)
    ax.spines['right'].set_visible(False)
    
    plt.tight_layout()
    plt.savefig(output_path, dpi=200, bbox_inches='tight')
    plt.savefig(output_path.replace('.png', '.pdf'), bbox_inches='tight')
    plt.close()
    
    logger.info(f"  保存: {output_path}")


def plot_group_stacked(prop_df: pd.DataFrame,
                       output_path: str,
                       group_col: str,
                       celltype_col: str,
                       title: str = "Cell Type Proportion by Group") -> None:
    """绘制分组堆叠柱状图（R脚本风格增强）"""
    logger.info("📊 绘制分组堆叠柱状图...")
    
    # 透视表
    pivot_df = prop_df.pivot(index=group_col, columns=celltype_col, values='Proportion')
    pivot_df = pivot_df.fillna(0)
    
    fig, ax = plt.subplots(figsize=(max(10, len(pivot_df.columns) * 0.8), 6))
    
    # 使用R脚本配色
    n_colors = len(pivot_df.columns)
    colors = COLOR_PANEL[:n_colors] if n_colors <= len(COLOR_PANEL) else sns.color_palette('husl', n_colors)
    
    pivot_df.plot(kind='bar', stacked=True, ax=ax, 
                  color=colors, edgecolor='black', linewidth=0.3)
    
    ax.set_xlabel(group_col, fontsize=12)
    ax.set_ylabel('Proportion', fontsize=12)
    ax.set_title(title, fontsize=14)
    
    ax.set_xticklabels(ax.get_xticklabels(), rotation=45, ha='right')
    ax.yaxis.set_major_formatter(plt.FuncFormatter(lambda y, _: f'{y:.0%}'))
    ax.spines['top'].set_visible(False)
    ax.spines['right'].set_visible(False)
    
    # 图例
    ax.legend(title=celltype_col, bbox_to_anchor=(1.02, 1), 
              loc='upper left', fontsize=7, ncol=1)
    
    plt.tight_layout()
    plt.savefig(output_path, dpi=200, bbox_inches='tight')
    plt.savefig(output_path.replace('.png', '.pdf'), bbox_inches='tight')
    plt.close()
    
    logger.info(f"  保存: {output_path}")


def plot_group_facet(prop_df: pd.DataFrame,
                     output_path: str,
                     group_col: str,
                     celltype_col: str,
                     value_col: str = 'Percentage',
                     title: str = "Cell Type by Group") -> None:
    """
    绘制分组分面柱状图（R脚本风格，来自cell-number.R）
    
    每个细胞类型一个子图，显示不同分组的比例/数量
    """
    logger.info("📊 绘制分组分面柱状图...")
    
    celltypes = prop_df[celltype_col].unique()
    n_ct = len(celltypes)
    n_cols = min(4, n_ct)
    n_rows = (n_ct + n_cols - 1) // n_cols
    
    fig, axes = plt.subplots(n_rows, n_cols, figsize=(4*n_cols, 3*n_rows))
    if n_rows == 1:
        axes = axes.flatten() if n_ct > 1 else [axes]
    else:
        axes = axes.flatten()
    
    for idx, ct in enumerate(celltypes):
        ax = axes[idx]
        ct_data = prop_df[prop_df[celltype_col] == ct].sort_values(group_col)
        
        x = range(len(ct_data))
        bars = ax.bar(x, ct_data[value_col], 
                     color=[COLOR_PANEL[hash(g) % len(COLOR_PANEL)] for g in ct_data[group_col]],
                     edgecolor='black', linewidth=0.5)
        
        ax.set_xticks(x)
        ax.set_xticklabels(ct_data[group_col].astype(str), rotation=45, ha='right', fontsize=8)
        ax.set_ylabel(value_col)
        ax.set_title(f'{ct}', fontsize=9, fontweight='bold')
        ax.spines['top'].set_visible(False)
        ax.spines['right'].set_visible(False)
        
        # 添加数值标签
        if value_col == 'Percentage':
            for bar in bars:
                height = bar.get_height()
                ax.text(bar.get_x() + bar.get_width()/2., height + 0.5,
                       f'{height:.1f}', ha='center', va='bottom', fontsize=7)
        else:  # cell_number
            for bar, count in zip(bars, ct_data['cell_number']):
                height = bar.get_height()
                ax.text(bar.get_x() + bar.get_width()/2., height + max(ct_data['cell_number']) * 0.02,
                       f'{count}', ha='center', va='bottom', fontsize=7)
    
    # 隐藏多余的子图
    for idx in range(len(celltypes), len(axes)):
        axes[idx].set_visible(False)
    
    plt.suptitle(title, y=1.02, fontsize=12)
    plt.tight_layout()
    plt.savefig(output_path, dpi=200, bbox_inches='tight')
    plt.savefig(output_path.replace('.png', '.pdf'), bbox_inches='tight')
    plt.close()
    
    logger.info(f"  保存: {output_path}")


def plot_proportion_comparison(prop_df: pd.DataFrame,
                               output_path: str,
                               group_col: str,
                               celltype_col: str,
                               top_n: int = 10) -> None:
    """绘制组间比例对比图（分组柱状图）"""
    logger.info("📊 绘制组间比例对比图...")
    
    # 取比例最大的 top_n 细胞类型
    celltype_total = prop_df.groupby(celltype_col)['Proportion'].mean().nlargest(top_n)
    top_celltypes = celltype_total.index.tolist()
    
    # 筛选数据
    plot_df = prop_df[prop_df[celltype_col].isin(top_celltypes)]
    
    # 创建分面图
    n_celltypes = len(top_celltypes)
    n_cols = min(4, n_celltypes)
    n_rows = (n_celltypes + n_cols - 1) // n_cols
    
    fig, axes = plt.subplots(n_rows, n_cols, figsize=(4*n_cols, 3*n_rows))
    axes = axes.flatten() if n_celltypes > 1 else [axes]
    
    for idx, celltype in enumerate(top_celltypes):
        ax = axes[idx]
        celltype_data = plot_df[plot_df[celltype_col] == celltype]
        
        sns.barplot(data=celltype_data, x=group_col, y='Proportion', ax=ax, palette='Set2')
        ax.set_title(f'{celltype_col} {celltype}', fontsize=10)
        ax.set_ylabel('Proportion')
        ax.set_xticklabels(ax.get_xticklabels(), rotation=45, ha='right')
        ax.yaxis.set_major_formatter(plt.FuncFormatter(lambda y, _: f'{y:.0%}'))
    
    # 隐藏多余的子图
    for idx in range(len(top_celltypes), len(axes)):
        axes[idx].set_visible(False)
    
    plt.suptitle(f'Top {top_n} Cell Types Proportion Comparison', y=1.02)
    plt.tight_layout()
    plt.savefig(output_path, dpi=200, bbox_inches='tight')
    plt.close()
    
    logger.info(f"  保存: {output_path}")


def plot_grouped_pie(prop_df: pd.DataFrame,
                     output_path: str,
                     group_col: str,
                     celltype_col: str = None,
                     title: str = "Cell Type Distribution") -> None:
    """绘制分组饼图"""
    logger.info("📊 绘制分组饼图...")
    
    if celltype_col is None:
        celltype_col = [c for c in prop_df.columns if c != group_col][0]
    
    groups = prop_df[group_col].unique()
    n_groups = len(groups)
    n_cols = min(3, n_groups)
    n_rows = (n_groups + n_cols - 1) // n_cols
    
    fig, axes = plt.subplots(n_rows, n_cols, figsize=(5*n_cols, 4*n_rows))
    if n_groups == 1:
        axes = [axes]
    else:
        axes = axes.flatten()
    
    colors = sns.color_palette('husl', 20)
    
    for idx, group in enumerate(groups):
        ax = axes[idx]
        group_data = prop_df[prop_df[group_col] == group]
        
        wedges, texts, autotexts = ax.pie(
            group_data['Proportion'],
            labels=None,
            autopct='%1.1f%%',
            colors=colors[:len(group_data)],
            startangle=90
        )
        
        ax.set_title(f'{group}', fontsize=12)
    
    # 隐藏多余的子图
    for idx in range(len(groups), len(axes)):
        axes[idx].set_visible(False)
    
    # 添加图例
    handles = [plt.Line2D([0], [0], marker='o', color='w', 
                          markerfacecolor=colors[i], markersize=10)
              for i in range(min(10, len(prop_df)))]
    labels = prop_df[celltype_col].unique()[:10] if celltype_col in prop_df.columns else prop_df.iloc[:, 1].unique()[:10]
    fig.legend(handles, labels, loc='lower center', ncol=5, 
               bbox_to_anchor=(0.5, -0.02), fontsize=8)
    
    plt.suptitle(title, y=1.02)
    plt.tight_layout()
    plt.savefig(output_path, dpi=200, bbox_inches='tight')
    plt.close()
    
    logger.info(f"  保存: {output_path}")


def main():
    parser = argparse.ArgumentParser(description='Cell Proportion Analysis (R脚本风格增强版)')
    
    parser.add_argument('--input', '-i', required=True, help='输入h5ad文件')
    parser.add_argument('--output', '-o', required=True, help='输出目录')
    parser.add_argument('--celltype', '-c', default=None, help='细胞类型列名')
    parser.add_argument('--group', '-g', default=None, help='分组列名')
    parser.add_argument('--sample', default='sample', help='样本列名')
    parser.add_argument('--top-n', type=int, default=10, help='显示top N细胞类型')
    
    args = parser.parse_args()
    
    ensure_dir(args.output)
    
    logger.info(f"📖 读取数据: {args.input}")
    adata = ad.read_h5ad(args.input)
    
    # 分析
    results = cell_proportion_analysis(adata, args.celltype, args.group, args.sample)
    
    if not results:
        logger.error("分析失败")
        return
    
    # 1. 保存细胞数统计
    if 'sample_stats' in results:
        results['sample_stats'].to_csv(
            os.path.join(args.output, 'cell_number_stat.csv'),
            sep='\t', index=False
        )
        logger.info(f"  保存: cell_number_stat.csv")
    
    # 2. 保存细胞类型比例
    results['celltype'].to_csv(
        os.path.join(args.output, 'celltype_proportion.csv'), 
        index=False
    )
    logger.info(f"  保存: celltype_proportion.csv")
    
    # 3. 绘制细胞类型占比柱状图
    plot_celltype_proportion(
        results['celltype'],
        os.path.join(args.output, 'celltype_proportion_barplot.png'),
        title="Cell Type Proportion (All Samples)"
    )
    
    # 4. 分组分析
    celltype_col = args.celltype or [c for c in adata.obs.columns if c.startswith('leiden_')][0]
    
    if 'group_celltype' in results:
        results['group_celltype'].to_csv(
            os.path.join(args.output, 'cell_number_group.csv'),
            sep='\t', index=False
        )
        logger.info(f"  保存: cell_number_group.csv")
        
        # 分组堆叠柱状图
        plot_group_stacked(
            results['group_celltype'],
            os.path.join(args.output, 'cell_number_rate_group.png'),
            args.group, celltype_col,
            title="Cell Type Proportion by Group"
        )
        
        # 分组分面图（带数量标注）
        plot_group_facet(
            results['group_celltype'],
            os.path.join(args.output, 'cell_number_rate_group_facet.png'),
            args.group, celltype_col,
            value_col='Percentage',
            title="Cell Type Percentage by Group"
        )
        
        plot_group_facet(
            results['group_celltype'],
            os.path.join(args.output, 'cell_number_group_facet.png'),
            args.group, celltype_col,
            value_col='cell_number',
            title="Cell Number by Group"
        )
    
    # 5. 样本分析
    if 'sample_celltype' in results:
        results['sample_celltype'].to_csv(
            os.path.join(args.output, 'cell_number_sample.csv'),
            sep='\t', index=False
        )
        logger.info(f"  保存: cell_number_sample.csv")
        
        # 样本堆叠柱状图
        plot_group_stacked(
            results['sample_celltype'],
            os.path.join(args.output, 'cell_number_rate_sample.png'),
            args.sample, celltype_col,
            title="Cell Type Proportion by Sample"
        )
        
        # 样本分面图
        plot_group_facet(
            results['sample_celltype'],
            os.path.join(args.output, 'cell_number_rate_sample_facet.png'),
            args.sample, celltype_col,
            value_col='Percentage',
            title="Cell Type Percentage by Sample"
        )
    
    # 6. Cluster内分组占比
    if 'cluster_group' in results and args.group:
        results['cluster_group'].to_csv(
            os.path.join(args.output, 'cell_number_cluster.csv'),
            sep='\t', index=False
        )
        logger.info(f"  保存: cell_number_cluster.csv")
        
        # Cluster占比图
        plot_group_facet(
            results['cluster_group'],
            os.path.join(args.output, 'cell_number_rate_cluster.png'),
            celltype_col, args.group,
            value_col='Percentage',
            title="Cell Type Composition by Cluster"
        )
    
    logger.info(f"✅ 细胞比例分析完成！保存到: {args.output}")


if __name__ == '__main__':
    main()
