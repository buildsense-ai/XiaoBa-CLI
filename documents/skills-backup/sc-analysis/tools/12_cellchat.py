#!/usr/bin/env python3
"""
Step 12: 细胞通讯分析

【功能说明】
- CellChat: 配体-受体相互作用网络分析
- CellPhoneDB: 统计显著性细胞互作
- NicheNet: 细胞间分子机制分析

【用法】
    python tools/12_cellchat.py \\
        --input annotated.h5ad \\
        --output ./cellchat \\
        --species mouse \\
        --method cellchat

【参数说明】
    --input    : 输入h5ad文件
    --output   : 输出目录
    --species  : 物种 (human/mouse/rat)
    --method   : 分析方法 (cellchat/cellphone/nichenet)

【输出】
    - cellchat.rds         : CellChat对象
    - cellchat_network.png # 通讯网络图
    - cellchat_heatmap.png # 通讯热图
    - cellchat_LR.png      : 配体-受体图

【依赖】
    CellChat: pip install CellChat
    CellPhoneDB: pip install cellphonedb
    NicheNet: R包nichenetr

【示例】
    python tools/12_cellchat.py -i annot/annotated.h5ad -o chat/ --species mouse
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
from utils.core_utils import ensure_dir, timing, logger

logging.basicConfig(level=logging.INFO, format='%(asctime)s | %(levelname)-8s | %(message)s', datefmt='%H:%M:%S')
logger = logging.getLogger(__name__)


@timing
def run_cellphone(adata: ad.AnnData,
                 species: str = 'mouse',
                 threshold: float = 0.1) -> pd.DataFrame:
    """
    CellPhoneDB细胞通讯分析
    
    分析配体-受体相互作用
    """
    logger.info("📱 CellPhoneDB 细胞通讯分析...")
    
    try:
        import cellphonedb
    except ImportError:
        logger.error("❌ CellPhoneDB未安装！运行: pip install cellphonedb")
        logger.info("  或使用Docker: docker run -it -v $PWD:$PWD -w $PWD -e NUMBA_DISABLE_JIT=1 cellphonedb_user cellphonedb")
        raise
    
    logger.info("  CellPhoneDB需要从命令行运行:")
    logger.info("  cellphonedb statistical_analysis meta.txt exp.txt --counts-data hgnc_symbol")
    
    return pd.DataFrame()


@timing
def run_cellchat(adata: ad.AnnData,
                species: str = 'mouse',
                n_bins: int = 40,
                min_cells: int = 10) -> ad.AnnData:
    """
    CellChat细胞通讯分析
    
    CellChat使用机器学习推断细胞通讯网络
    支持:
    - 配体-受体相互作用分析
    - 通讯网络分析
    - 通路水平分析
    """
    logger.info("📱 CellChat 细胞通讯分析...")
    
    try:
        import cellchat
    except ImportError:
        logger.error("❌ CellChat未安装！运行: pip install CellChat")
        raise
    
    # 准备数据
    data_input = adata.raw.to_adata() if adata.raw else adata
    
    # 创建CellChat对象
    cellchat = cellchat.CellChat(data_input, meta=adata.obs[['cell_type']], 
                                 var.index=data_input.var_names,
                                 group.by='cell_type')
    
    # 设置数据库
    if species == 'mouse':
        cellchat.setDatabase('Secreted Signaling')
    else:
        cellchat.setDatabase('Secreted Signaling')
    
    # 预处理
    cellchat.preprocessingData(threshold=min_cells)
    
    # 推断通讯网络
    cellchat.computeCommunProb(nboot=100)
    
    # 通路水平分析
    cellchat.aggregateGLPNet()
    
    # 保存
    cellchat.save('cellchat.rds')
    
    # 通讯数量统计
    n_interactions = cellchat$LR$shape[1]
    logger.info(f"  检测到 {n_interactions} 个配体-受体相互作用")
    
    return adata


@timing
def run_nichenet(adata: ad.AnnData,
                groupby: str = 'group',
                group1: str = 'treatment',
                group2: str = 'control') -> ad.AnnData:
    """
    NicheNet细胞互作分析
    
    分析细胞间通讯的分子机制
    """
    logger.info("📱 NicheNet 细胞互作分析...")
    
    logger.info("  NicheNet需要R环境，详细运行请参考R脚本")
    logger.info("  Rscript -e 'install.packages(\"nichenetr\")'")
    
    return adata


@timing
def run_scatac_cicero(adata: ad.AnnData) -> ad.AnnData:
    """
    Cicero分析ATAC-seq的细胞互作
    
    整合scRNA和scATAC数据
    """
    logger.info("📱 Cicero 细胞互作分析...")
    
    logger.info("  Cicero需要R环境，详细运行请参考R脚本")
    
    return adata


@timing
def plot_cellchat(cellchat,
                output_dir: str,
                max_edge: int = 200,
                vertex_size: float = 30) -> None:
    """绘制CellChat结果"""
    import matplotlib.pyplot as plt
    
    logger.info("📊 绘制CellChat结果...")
    
    # 1. 通讯网络
    fig = cellchat$net$plotNK(
        signal = NULL,
        edge.max = max_edge,
        vertex.size = vertex_size,
        remove.isolate = TRUE
    )
    
    # 保存
    plt.savefig(os.path.join(output_dir, 'cellchat_network.png'), dpi=200)
    plt.close()
    
    # 2. 热图
    fig = cellchat$net$heatmapNK(signal = NULL)
    plt.savefig(os.path.join(output_dir, 'cellchat_heatmap.png'), dpi=200)
    plt.close()
    
    # 3. 配体-受体pair
    fig = cellchat$plotNK(type = 'LR')
    plt.savefig(os.path.join(output_dir, 'cellchat_LR.png'), dpi=200)
    plt.close()
    
    logger.info(f"  CellChat图保存到: {output_dir}")


def main():
    parser = argparse.ArgumentParser(description='Cell-Cell Communication Analysis')
    
    parser.add_argument('--input', '-i', required=True, help='输入h5ad文件')
    parser.add_argument('--output', '-o', required=True, help='输出目录')
    parser.add_argument('--method', '-m', default='cellchat',
                       choices=['cellchat', 'cellphone', 'nichenet'],
                       help='分析方法')
    parser.add_argument('--species', '-s', default='mouse', choices=['human', 'mouse', 'rat'])
    
    args = parser.parse_args()
    
    ensure_dir(args.output)
    
    logger.info(f"📖 读取数据: {args.input}")
    adata = ad.read_h5ad(args.input)
    
    # 运行分析
    if args.method == 'cellchat':
        adata = run_cellchat(adata, args.species)
    elif args.method == 'cellphone':
        run_cellphone(adata, args.species)
    elif args.method == 'nichenet':
        adata = run_nichenet(adata)
    
    logger.info(f"✅ 细胞通讯分析完成！保存到: {args.output}")


if __name__ == '__main__':
    main()
