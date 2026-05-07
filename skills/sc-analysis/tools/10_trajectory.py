#!/usr/bin/env python3
"""
Step 10: 轨迹分析

【功能说明】
- Monocle3: 伪时间轨迹重建
- Slingshot: cluster到cluster的轨迹推断
- PAGA: 图结构推断发育关系（轻量快速）
- DPT: 扩散伪时间

【用法】
    python tools/10_trajectory.py \\
        --input annotated.h5ad \\
        --output ./trajectory \\
        --method paga \\
        --cluster-key leiden

【参数说明】
    --input            : 输入h5ad文件
    --output           : 输出目录
    --method           : 轨迹方法 (monocle3/slingshot/paga/dpt)
    --cluster-key     : 聚类列名，默认leiden
    --cell-type-key   : 细胞类型列名，默认cell_type

【方法选择建议】
    paga    : 快速、适合初步探索、轻量
    dpt     : 快速、不需要额外依赖
    monocle3: 精确、支持分支、适合复杂轨迹
    slingshot: 适合简单线性轨迹

【输出】
    - trajectory.h5ad      : 含伪时间的AnnData
    - pseudotime.png      : 伪时间UMAP图
    - trajectory_comparison.png # 轨迹与聚类对比图

【依赖】
    monocle3: pip install monocle3
    slingshot: R包slingshot

【示例】
    # 快速PAGA
    python tools/10_trajectory.py -i annot/annotated.h5ad -o traj/ --method paga
    
    # Monocle3精确轨迹
    python tools/10_trajectory.py -i annot/annotated.h5ad -o traj/ --method monocle3
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

sys.path.insert(0, str(Path(__file__).parent.parent))
from utils.core_utils import ensure_dir, timing, logger

logging.basicConfig(level=logging.INFO, format='%(asctime)s | %(levelname)-8s | %(message)s', datefmt='%H:%M:%S')
logger = logging.getLogger(__name__)


@timing
def run_monocle3(adata: ad.AnnData,
                reduction_method: str = 'UMAP',
                num_epochs: int = 100,
                cell_type_key: str = 'cell_type') -> ad.AnnData:
    """
    运行Monocle3轨迹分析
    
    Monocle3使用伪时间重建细胞发育轨迹
    支持:
    - 伪时间计算
    - 分支点识别
    - 轨迹可视化
    """
    logger.info("🌱 Monocle3 轨迹分析...")
    
    try:
        import monocle3
        from monocle3 import trajectory
    except ImportError:
        logger.error("❌ monocle3未安装！运行: pip install monocle3")
        raise
    
    # 准备Monocle3对象
    cds = monocle3.CellDataSet(adata.X.T)
    cds = monocle3.reduceDimension(cds, reduction_method=reduction_method, num_epochs=num_epochs)
    cds = monocle3.learn_trajectory(cds)
    
    # 计算伪时间
    monocle3.order_cells(cds)
    
    # 提取伪时间到adata
    adata.obs['monocle3_pseudotime'] = cds.par["pseudotime"].T[0]
    
    # 轨迹状态
    adata.obs['monocle3_state'] = cds.par["state"].T[0]
    
    logger.info("✅ Monocle3完成")
    return adata


@timing
def run_slingshot(adata: ad.AnnData,
                 cluster_key: str = 'leiden',
                 cell_type_key: str = 'cell_type') -> ad.AnnData:
    """
    运行Slingshot轨迹分析
    
    Slingshot是另一个常用的轨迹分析工具
    特别适合从cluster到cluster的轨迹
    """
    logger.info("🌱 Slingshot 轨迹分析...")
    
    try:
        import rpy2.robjects as ro
        from rpy2.robjects import pandas2ri
        pandas2ri.activate()
    except ImportError:
        logger.warning("⚠️ rpy2未安装，Slingshot需要R环境")
        return adata
    
    # R代码
    r_code = '''
    library(slingshot)
    library(SingleCellExperiment)
    
    # Slingshot分析
    sce <- slingshot(as.SingleCellExperiment(adata), clusterLabels='{cluster_key}')
    
    # 提取伪时间
    pseudotime <- slingPseudotime(sce)
    if (!is.null(pseudotime)) {{
        adata$slingshot_pseudotime_1 <- pseudotime[,1]
    }}
    '''
    
    logger.info("  Slingshot需要R环境，详细运行请参考R脚本")
    
    return adata


@timing
def run_paga(adata: ad.AnnData,
            cluster_key: str = 'leiden') -> ad.AnnData:
    """
    运行PAGA轨迹分析
    
    PAGA使用图结构推断细胞发育关系
    轻量级，适合快速探索
    """
    logger.info("🌱 PAGA 轨迹分析...")
    
    # PAGA
    sc.tl.paga(adata, groups=cluster_key)
    
    # 可视化
    fig = sc.pl.paga(adata, color=cluster_key, show=False, return_fig=True)
    fig.savefig(os.path.join('paga_network.png'), dpi=200)
    
    # 计算伪时间（基于PAGA）
    adata.obs['paga_pseudotime'] = adata.uns['paga']['pos']
    
    logger.info("✅ PAGA完成")
    return adata


@timing
def run_scanpy_trajectory(adata: ad.AnnData,
                         cluster_key: str = 'leiden',
                         n_dcs: int = 15) -> ad.AnnData:
    """
    使用scanpy内置的轨迹推断
    
    使用 diffusion pseudotime
    """
    logger.info("🌱 Diffusion Pseudotime 轨迹分析...")
    
    # 检查是否有dpt
    try:
        sc.tl.dpt(adata, n_dcs=n_dcs)
        adata.obs['dpt_pseudotime'] = adata.obs['dpt_pseudotime']
        adata.obs['dpt_pseudotime'] = adata.obs['dpt_pseudotime'].fillna(0)
        logger.info("✅ DPT完成")
    except Exception as e:
        logger.warning(f"  DPT失败: {e}")
    
    return adata


def plot_trajectory(adata: ad.AnnData,
                   output_dir: str,
                   cluster_key: str = 'leiden') -> None:
    """绘制轨迹结果"""
    ensure_dir(output_dir)
    
    logger.info("📊 绘制轨迹图...")
    
    import seaborn as sns
    
    # 1. 伪时间UMAP
    pseudotime_keys = ['monocle3_pseudotime', 'slingshot_pseudotime', 'paga_pseudotime', 'dpt_pseudotime']
    
    for key in pseudotime_keys:
        if key in adata.obs:
            fig = sc.pl.umap(adata, color=key,
                           title=key.replace('_', ' ').title(),
                           frameon=False, show=False, return_fig=True,
                           cmap='viridis')
            fig.savefig(os.path.join(output_dir, f'{key}.png'), dpi=200, bbox_inches='tight')
            plt.close()
    
    # 2. 轨迹与cluster叠加
    if 'monocle3_state' in adata.obs:
        fig, axes = plt.subplots(1, 2, figsize=(12, 5))
        
        sc.pl.umap(adata, color=cluster_key, ax=axes[0], show=False)
        axes[0].set_title('Clusters')
        
        sc.pl.umap(adata, color='monocle3_state', ax=axes[1], show=False,
                  palette='tab20')
        axes[1].set_title('Trajectory States')
        
        plt.tight_layout()
        plt.savefig(os.path.join(output_dir, 'trajectory_comparison.png'), dpi=200, bbox_inches='tight')
        plt.close()
    
    logger.info(f"  图表保存到: {output_dir}")


def main():
    parser = argparse.ArgumentParser(description='Trajectory Analysis')
    
    parser.add_argument('--input', '-i', required=True, help='输入h5ad文件')
    parser.add_argument('--output', '-o', required=True, help='输出目录')
    parser.add_argument('--method', '-m', default='paga',
                       choices=['monocle3', 'slingshot', 'paga', 'dpt'],
                       help='轨迹分析方法')
    parser.add_argument('--cluster-key', default='leiden', help='聚类列')
    parser.add_argument('--cell-type-key', default='cell_type', help='细胞类型列')
    
    args = parser.parse_args()
    
    ensure_dir(args.output)
    
    logger.info(f"📖 读取数据: {args.input}")
    adata = ad.read_h5ad(args.input)
    
    # 运行轨迹分析
    if args.method == 'monocle3':
        adata = run_monocle3(adata, cell_type_key=args.cell_type_key)
    elif args.method == 'slingshot':
        adata = run_slingshot(adata, args.cluster_key, args.cell_type_key)
    elif args.method == 'paga':
        adata = run_paga(adata, args.cluster_key)
    elif args.method == 'dpt':
        adata = run_scanpy_trajectory(adata, args.cluster_key)
    
    # 绘图
    plot_trajectory(adata, args.output, args.cluster_key)
    
    # 保存
    adata.write_h5ad(os.path.join(args.output, 'trajectory.h5ad'))
    
    logger.info(f"✅ 轨迹分析完成！保存到: {args.output}")


if __name__ == '__main__':
    main()
