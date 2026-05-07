#!/usr/bin/env python3
"""
Step 14: 综合报告生成

【功能说明】
- 生成交互式HTML分析报告
- 生成Markdown格式报告（可转PDF）
- 自动汇总统计信息
- 包含数据概览、图表、统计结果

【用法】
    python tools/14_report.py \\
        --input annotated.h5ad \\
        --output ./report \\
        --markers markers.csv

【参数说明】
    --input   : 输入h5ad文件
    --output  : 输出目录
    --markers : Marker基因CSV文件路径（可选）

【输出】
    - analysis_report.html : 交互式HTML报告
    - analysis_report.md   : Markdown报告

【示例】
    python tools/14_report.py -i annot/annotated.h5ad -o report/ --markers markers/markers.csv
"""

__author__ = "CatsCo"
__version__ = "3.0.0"
import os
import sys
import argparse
import logging
from pathlib import Path
from datetime import datetime

import numpy as np
import pandas as pd
import anndata as ad

sys.path.insert(0, str(Path(__file__).parent.parent))
from utils.core_utils import ensure_dir, timing, logger

logging.basicConfig(level=logging.INFO, format='%(asctime)s | %(levelname)-8s | %(message)s', datefmt='%H:%M:%S')
logger = logging.getLogger(__name__)


@timing
def generate_html_report(adata: ad.AnnData,
                       output_dir: str,
                       markers_file: str = None,
                       markers_df: pd.DataFrame = None) -> str:
    """生成HTML报告"""
    logger.info("📝 生成HTML报告...")
    
    ensure_dir(output_dir)
    
    # 基本统计
    n_cells = adata.n_obs
    n_genes = adata.n_vars
    n_clusters = adata.obs['leiden'].nunique() if 'leiden' in adata.obs else 0
    n_celltypes = adata.obs['cell_type'].nunique() if 'cell_type' in adata.obs else 0
    
    # 样本统计
    sample_stats = adata.obs['sample'].value_counts().to_dict() if 'sample' in adata.obs else {}
    group_stats = adata.obs['group'].value_counts().to_dict() if 'group' in adata.obs else {}
    
    # QC统计
    qc_stats = {
        'mean_genes': adata.obs['n_genes'].mean() if 'n_genes' in adata.obs else 0,
        'mean_counts': adata.obs['n_counts'].mean() if 'n_counts' in adata.obs else 0,
        'mean_mito': adata.obs['pct_mito'].mean() if 'pct_mito' in adata.obs else 0
    }
    
    # Cluster统计
    cluster_stats = None
    if 'leiden' in adata.obs:
        cluster_stats = adata.obs.groupby('leiden').agg({
            'n_genes': 'mean',
            'n_counts': 'mean'
        }).round(2)
        cluster_stats['n_cells'] = adata.obs.groupby('leiden').size()
        cluster_stats['pct_total'] = (cluster_stats['n_cells'] / n_cells * 100).round(2)
    
    html = f"""
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>scRNA-seq Analysis Report</title>
    <style>
        * {{ margin: 0; padding: 0; box-sizing: border-box; }}
        body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; background: #f5f7fa; }}
        .container {{ max-width: 1200px; margin: 0 auto; padding: 20px; }}
        
        /* Header */
        .header {{ background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 40px 30px; border-radius: 16px; margin-bottom: 30px; box-shadow: 0 10px 40px rgba(102, 126, 234, 0.3); }}
        .header h1 {{ font-size: 2.5em; margin-bottom: 10px; }}
        .header .subtitle {{ opacity: 0.9; font-size: 1.1em; }}
        .header .date {{ margin-top: 15px; opacity: 0.7; }}
        
        /* Stats Cards */
        .stats-grid {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin-bottom: 30px; }}
        .stat-card {{ background: white; padding: 25px; border-radius: 12px; box-shadow: 0 4px 15px rgba(0,0,0,0.08); transition: transform 0.3s; }}
        .stat-card:hover {{ transform: translateY(-5px); }}
        .stat-card h3 {{ color: #666; font-size: 0.9em; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 10px; }}
        .stat-card .value {{ font-size: 2.5em; font-weight: bold; color: #667eea; }}
        .stat-card .icon {{ font-size: 2em; margin-bottom: 10px; }}
        
        /* Section */
        .section {{ background: white; border-radius: 12px; padding: 30px; margin-bottom: 30px; box-shadow: 0 4px 15px rgba(0,0,0,0.08); }}
        .section h2 {{ color: #333; border-bottom: 3px solid #667eea; padding-bottom: 10px; margin-bottom: 20px; font-size: 1.5em; }}
        
        /* Tables */
        table {{ width: 100%; border-collapse: collapse; }}
        th, td {{ padding: 12px 15px; text-align: left; border-bottom: 1px solid #eee; }}
        th {{ background: #f8f9fa; font-weight: 600; color: #555; }}
        tr:hover {{ background: #f8f9fa; }}
        
        /* Charts placeholder */
        .chart-placeholder {{ background: #f8f9fa; border-radius: 8px; padding: 40px; text-align: center; color: #999; margin: 15px 0; }}
        
        /* Footer */
        .footer {{ text-align: center; color: #999; padding: 30px; font-size: 0.9em; }}
        
        /* Color palette */
        .color-box {{ display: inline-block; width: 20px; height: 20px; border-radius: 4px; margin-right: 8px; vertical-align: middle; }}
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🧬 单细胞RNA测序分析报告</h1>
            <p class="subtitle">scRNA-seq Analysis Report</p>
            <p class="date">生成时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}</p>
        </div>
        
        <div class="stats-grid">
            <div class="stat-card">
                <div class="icon">🔬</div>
                <h3>细胞数</h3>
                <div class="value">{n_cells:,}</div>
            </div>
            <div class="stat-card">
                <div class="icon">🧪</div>
                <h3>基因数</h3>
                <div class="value">{n_genes:,}</div>
            </div>
            <div class="stat-card">
                <div class="icon">📊</div>
                <h3>Cluster数</h3>
                <div class="value">{n_clusters}</div>
            </div>
            <div class="stat-card">
                <div class="icon">🎯</div>
                <h3>细胞类型</h3>
                <div class="value">{n_celltypes}</div>
            </div>
        </div>
        
        <div class="section">
            <h2>📋 数据概览</h2>
            <table>
                <tr><th>指标</th><th>数值</th></tr>
                <tr><td>平均基因数/细胞</td><td>{qc_stats['mean_genes']:.1f}</td></tr>
                <tr><td>平均UMI数/细胞</td><td>{qc_stats['mean_counts']:.1f}</td></tr>
                <tr><td>平均线粒体比例</td><td>{qc_stats['mean_mito']:.2f}%</td></tr>
            </table>
        </div>
        
        <div class="section">
            <h2>📊 样本分布</h2>
            <table>
                <tr><th>样本</th><th>细胞数</th><th>占比</th></tr>
"""
    
    for sample, count in sample_stats.items():
        pct = count / n_cells * 100
        html += f"                <tr><td>{sample}</td><td>{count}</td><td>{pct:.1f}%</td></tr>\n"
    
    if group_stats:
        html += """
            </table>
            <h3 style="margin-top: 20px;">分组分布</h3>
            <table>
                <tr><th>组别</th><th>细胞数</th><th>占比</th></tr>
"""
        for group, count in group_stats.items():
            pct = count / n_cells * 100
            html += f"                <tr><td>{group}</td><td>{count}</td><td>{pct:.1f}%</td></tr>\n"
    
    html += """
            </table>
        </div>
        
        <div class="section">
            <h2>🔬 Cluster分布</h2>
            <table>
                <tr><th>Cluster</th><th>细胞数</th><th>占比</th><th>主要细胞类型</th></tr>
"""
    
    if cluster_stats is not None:
        for cluster in cluster_stats.index[:15]:
            count = cluster_stats.loc[cluster, 'n_cells']
            pct = cluster_stats.loc[cluster, 'pct_total']
            cell_type = adata.obs[adata.obs['leiden'] == cluster]['cell_type'].mode()[0] if 'cell_type' in adata.obs else 'Unknown'
            html += f"                <tr><td>{cluster}</td><td>{count}</td><td>{pct:.1f}%</td><td>{cell_type}</td></tr>\n"
    
    html += """
            </table>
        </div>
"""
    
    # Marker基因
    if markers_df is not None and not markers_df.empty:
        html += """
        <div class="section">
            <h2>🧬 Top Marker基因</h2>
            <table>
                <tr><th>Cluster</th><th>Top 5 Marker基因</th></tr>
"""
        top_per_cluster = markers_df.groupby('cluster').head(5)
        for cluster in top_per_cluster['cluster'].unique()[:10]:
            genes = top_per_cluster[top_per_cluster['cluster'] == cluster]['gene'].tolist()
            html += f"                <tr><td>{cluster}</td><td>{', '.join(genes)}</td></tr>\n"
        html += """
            </table>
        </div>
"""
    
    html += """
        <div class="footer">
            <p>Generated by scRNA Analysis Pipeline v3.0</p>
            <p>Powered by Scanpy, scVI, and more...</p>
        </div>
    </div>
</body>
</html>
"""
    
    report_path = os.path.join(output_dir, 'analysis_report.html')
    with open(report_path, 'w', encoding='utf-8') as f:
        f.write(html)
    
    logger.info(f"✅ HTML报告: {report_path}")
    return report_path


@timing
def generate_markdown_report(adata: ad.AnnData,
                            output_dir: str,
                            markers_df: pd.DataFrame = None) -> str:
    """生成Markdown报告"""
    logger.info("📝 生成Markdown报告...")
    
    n_cells = adata.n_obs
    n_genes = adata.n_vars
    n_clusters = adata.obs['leiden'].nunique() if 'leiden' in adata.obs else 0
    
    md = f"""# 单细胞RNA测序分析报告

## 数据概览

| 指标 | 数值 |
|------|------|
| 总细胞数 | {n_cells:,} |
| 总基因数 | {n_genes:,} |
| Cluster数 | {n_clusters} |
| 细胞类型数 | {adata.obs['cell_type'].nunique() if 'cell_type' in adata.obs else 'N/A'} |

## 样本信息

"""
    
    if 'sample' in adata.obs:
        for sample in adata.obs['sample'].unique():
            count = (adata.obs['sample'] == sample).sum()
            pct = count / n_cells * 100
            md += f"- **{sample}**: {count} cells ({pct:.1f}%)\n"
    
    if 'group' in adata.obs:
        md += "\n## 分组信息\n\n"
        for group in adata.obs['group'].unique():
            count = (adata.obs['group'] == group).sum()
            pct = count / n_cells * 100
            md += f"- **{group}**: {count} cells ({pct:.1f}%)\n"
    
    md += f"\n## Cluster分布\n\n"
    md += "| Cluster | 细胞数 | 占比 | 主要细胞类型 |\n"
    md += "|---------|--------|------|-------------|\n"
    
    if 'leiden' in adata.obs:
        for cluster in adata.obs['leiden'].unique():
            count = (adata.obs['leiden'] == cluster).sum()
            pct = count / n_cells * 100
            cell_type = adata.obs[adata.obs['leiden'] == cluster]['cell_type'].mode()[0] if 'cell_type' in adata.obs else 'Unknown'
            md += f"| {cluster} | {count} | {pct:.1f}% | {cell_type} |\n"
    
    if markers_df is not None and not markers_df.empty:
        md += f"\n## Top Marker基因\n\n"
        md += "| Cluster | Marker基因 |\n"
        md += "|---------|------------|\n"
        
        top_per_cluster = markers_df.groupby('cluster').head(3)
        for cluster in top_per_cluster['cluster'].unique()[:10]:
            genes = top_per_cluster[top_per_cluster['cluster'] == cluster]['gene'].tolist()
            md += f"| {cluster} | {', '.join(genes)} |\n"
    
    md += f"\n---\n\n*Generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}*\n"
    
    report_path = os.path.join(output_dir, 'analysis_report.md')
    with open(report_path, 'w', encoding='utf-8') as f:
        f.write(md)
    
    logger.info(f"✅ Markdown报告: {report_path}")
    return report_path


def main():
    parser = argparse.ArgumentParser(description='Generate Analysis Report')
    
    parser.add_argument('--input', '-i', required=True, help='输入h5ad文件')
    parser.add_argument('--output', '-o', required=True, help='输出目录')
    parser.add_argument('--markers', '-m', default=None, help='Marker基因CSV')
    
    args = parser.parse_args()
    
    ensure_dir(args.output)
    
    logger.info(f"📖 读取数据: {args.input}")
    adata = ad.read_h5ad(args.input)
    
    markers_df = None
    if args.markers and os.path.exists(args.markers):
        markers_df = pd.read_csv(args.markers)
    
    # 生成报告
    generate_html_report(adata, args.output, markers_df=markers_df)
    generate_markdown_report(adata, args.output, markers_df=markers_df)
    
    logger.info(f"✅ 报告生成完成！保存到: {args.output}")


if __name__ == '__main__':
    main()
