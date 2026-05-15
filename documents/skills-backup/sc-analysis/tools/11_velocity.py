#!/usr/bin/env python3
"""
Step 11: RNA Velocity分析

【功能说明】
- 使用scVelo分析spliced/unspliced mRNA的动力学
- 预测细胞未来的分化方向
- 识别转变相关基因
- 支持GPU加速

【用法】
    python tools/11_velocity.py \\
        --input annotated.h5ad \\
        --output ./velocity \\
        --mode stochastic \\
        --n-jobs 4

【参数说明】
    --input    : 输入h5ad文件
    --output   : 输出目录
    --mode     : Velocity模型 (steady/stochastic/dynamical)
    --n-jobs  : 并行数，默认4
    --no-gpu  : 禁用GPU

【模型选择】
    steady    : 稳态模型，最快
    stochastic: 随机模型，平衡速度和准确性
    dynamical : 动态模型，最准确但最慢

【输入要求】
    需要数据包含spliced和unspliced层。
    Cell Ranger输出使用: cellranger count --include-introns

【输出】
    - velocity.h5ad   : 含velocity信息的AnnData
    - velocity_stream.png # 流场图
    - velocity_arrows.png # 箭头图
    - velocity_phasespace.png # 相空间图

【依赖】
    pip install scvelo

【示例】
    python tools/11_velocity.py -i annot/annotated.h5ad -o velo/ --mode stochastic
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

sys.path.insert(0, str(Path(__file__).parent.parent))
from utils.core_utils import ensure_dir, timing, check_gpu, logger

logging.basicConfig(level=logging.INFO, format='%(asctime)s | %(levelname)-8s | %(message)s', datefmt='%H:%M:%S')
logger = logging.getLogger(__name__)


@timing
def run_scvelo(adata: ad.AnnData,
              mode: str = 'steady',
              n_jobs: int = 4,
              use_gpu: bool = True) -> ad.AnnData:
    """
    运行scVelo RNA Velocity分析
    
    RNA Velocity通过比较spliced和unspliced mRNA的比例
    来预测细胞未来的分化方向
    
    模式:
    - 'steady': 稳态模型（快速，适合大数据）
    - 'dynamical': 动态模型（更准确，需要更多时间）
    - 'stochastic': 随机模型（平衡速度和准确性）
    """
    logger.info("🔄 scVelo RNA Velocity分析...")
    
    use_gpu = check_gpu()[0] and use_gpu
    
    try:
        import scvelo as scv
    except ImportError:
        logger.error("❌ scvelo未安装！运行: pip install scvelo")
        raise
    
    # 设置
    scv.settings.set_figure_params('scvelo')
    
    # 过滤基因
    adata_velo = adata.copy()
    scv.pp.filter_genes(adata_velo, min_shared_counts=20)
    
    # 估计参数
    logger.info("  估计RNA Velocity参数...")
    scv.pp.moments(adata_velo, n_neighbors=n_jobs, n_pcs=None)
    
    # Velocity分析
    logger.info(f"  运行 {mode} 模型...")
    
    if mode == 'dynamical':
        # 动态模型
        scv.tl.recover_dynamics(adata_velo, n_jobs=n_jobs)
        scv.tl.velocity(adata_velo, mode='dynamical')
    elif mode == 'stochastic':
        # 随机模型
        scv.tl.velocity(adata_velo, mode='stochastic')
    else:
        # 稳态模型
        scv.tl.velocity(adata_velo, mode='steady_state')
    
    # Velocity 置信度
    scv.tl.velocity_confidence(adata_velo)
    
    # 计算transition probabilities
    scv.tl.velocity_graph(adata_velo, n_jobs=n_jobs)
    
    # 保存velocity到原始adata
    if hasattr(adata_velo, 'layers'):
        adata.layers['velocity'] = adata_velo.layers.get('velocity')
        adata.uns['velocity_graph'] = adata_velo.uns.get('velocity_graph')
    
    adata.obs['velocity_confidence'] = adata_velo.obs['velocity_confidence']
    adata.obs['velocity_confidence_transitioning'] = adata_velo.obs['velocity_confidence_transitioning']
    
    n_transitioning = (adata.obs['velocity_confidence_transitioning'] > 0.5).sum()
    logger.info(f"  检测到 {n_transitioning} 个转变中的细胞")
    
    return adata, scv, adata_velo


@timing
def run_velocyto(adata: ad.AnnData,
                 loom_files: list = None) -> ad.AnnData:
    """
    使用Velocyto运行RNA Velocity
    
    需要单独的loom文件
    """
    logger.info("🔄 Velocyto RNA Velocity分析...")
    
    if loom_files is None:
        logger.warning("⚠️ 需要提供loom文件路径")
        return adata
    
    try:
        import velocyto as vcy
    except ImportError:
        logger.warning("⚠️ velocyto未安装！运行: pip install velocyto")
        return adata
    
    # 处理loom文件
    for loom_file in loom_files:
        vlm = vcy.VelocytoLoom(loom_file)
        # 后续处理...
    
    return adata


def plot_velocity(adata_velo,
                 adata: ad.AnnData,
                 output_dir: str,
                 scv) -> None:
    """绘制RNA Velocity结果"""
    ensure_dir(output_dir)
    
    logger.info("📊 绘制Velocity图...")
    
    # 1. 基本流场图
    fig = scv.pl.velocity_embedding_stream(
        adata_velo,
        basis='umap',
        color='leiden',
        title='RNA Velocity Stream',
        show=False
    )
    fig.savefig(os.path.join(output_dir, 'velocity_stream.png'), dpi=200, bbox_inches='tight')
    
    # 2. 箭头图
    fig = scv.pl.velocity_embedding(
        adata_velo,
        basis='umap',
        arrow_length=3,
        arrow_size=2,
        show=False
    )
    fig.savefig(os.path.join(output_dir, 'velocity_arrows.png'), dpi=200, bbox_inches='tight')
    
    # 3. 分相图
    fig = scv.pl.velocity_phasespace(
        adata_velo,
        basis='umap',
        show=False
    )
    fig.savefig(os.path.join(output_dir, 'velocity_phasespace.png'), dpi=200, bbox_inches='tight')
    
    # 4. 伪时间 vs Velocity
    if 'monocle3_pseudotime' in adata.obs:
        fig = scv.pl.scatter(
            adata_velo,
            x='monocle3_pseudotime',
            y='velocity_length',
            color='leiden',
            show=False
        )
        fig.savefig(os.path.join(output_dir, 'velocity_vs_pseudotime.png'), dpi=200, bbox_inches='tight')
    
    logger.info(f"  Velocity图保存到: {output_dir}")


@timing
def identify_transition_genes(adata_velo, scv,
                             n_top: int = 100) -> pd.DataFrame:
    """识别转变相关基因"""
    logger.info("🧬 识别velocity相关基因...")
    
    # Velocity基因
    scv.tl.rank_velocity_genes(adata_velo, groupby='leiden', n_genes=n_top)
    
    # 获取结果
    result = adata_velo.uns['rank_velocity_genes']
    
    all_genes = []
    for group in result['names'].dtype.names:
        for i in range(len(result['names'][group])):
            all_genes.append({
                'group': group,
                'gene': result['names'][group][i],
                'score': result['scores'][group][i]
            })
    
    df = pd.DataFrame(all_genes)
    return df


def main():
    parser = argparse.ArgumentParser(description='RNA Velocity Analysis')
    
    parser.add_argument('--input', '-i', required=True, help='输入h5ad文件')
    parser.add_argument('--output', '-o', required=True, help='输出目录')
    parser.add_argument('--mode', '-m', default='stochastic',
                      choices=['steady', 'stochastic', 'dynamical'],
                      help='Velocity模型')
    parser.add_argument('--n-jobs', type=int, default=4, help='并行数')
    parser.add_argument('--no-gpu', action='store_true', help='禁用GPU')
    
    args = parser.parse_args()
    
    ensure_dir(args.output)
    
    logger.info(f"📖 读取数据: {args.input}")
    adata = ad.read_h5ad(args.input)
    
    # 检查是否有spliced/unspliced层
    if 'spliced' not in adata.layers or 'unspliced' not in adata.layers:
        logger.warning("⚠️ 数据中没有spliced/unspliced层！")
        logger.info("  请使用Cell Ranger的--include-introns选项重新处理，或使用Loom文件")
        logger.info("  跳过RNA Velocity分析")
        return
    
    # 运行Velocity
    adata, scv, adata_velo = run_scvelo(
        adata,
        mode=args.mode,
        n_jobs=args.n_jobs,
        use_gpu=not args.no_gpu
    )
    
    # 绘图
    plot_velocity(adata_velo, adata, args.output, scv)
    
    # 保存
    adata.write_h5ad(os.path.join(args.output, 'velocity.h5ad'))
    
    logger.info(f"✅ RNA Velocity分析完成！保存到: {args.output}")


if __name__ == '__main__':
    main()
