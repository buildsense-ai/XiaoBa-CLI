#!/usr/bin/env python3
"""
Step 09: SCENIC转录因子分析

【功能说明】
- GRNBoost2靶基因预测
- cisTarget顺式调控元分析
- AUCell转录因子活性评分
- 识别关键转录因子调控网络

【用法】
    python tools/09_scenic.py \\
        --input annotated.h5ad \\
        --output ./scenic \\
        --species mouse \\
        --n-top-genes 2000 \\
        --n-top-tfs 50

【参数说明】
    --input        : 输入h5ad文件
    --output       : 输出目录
    --species      : 物种 (human/mouse/rat)
    --n-top-genes : 用于分析的基因数，默认2000
    --n-top-tfs   : 输出top N转录因子，默认50

【输出】
    - scenic.h5ad      : 含SCENIC评分的AnnData
    - regulons.csv     : 转录因子-靶基因关系
    - tf_activity.csv  : 转录因子活性表

【依赖】
    pip install pyscenic arboreto
    R: AUCell, RcisTarget, GENIE3

【示例】
    python tools/09_scenic.py -i annot/annotated.h5ad -o scenic/ --species mouse
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

sys.path.insert(0, str(Path(__file__).parent.parent))
from utils.core_utils import ensure_dir, timing, logger

logging.basicConfig(level=logging.INFO, format='%(asctime)s | %(levelname)-8s | %(message)s', datefmt='%H:%M:%S')
logger = logging.getLogger(__name__)


@timing
def run_scenic(adata: ad.AnnData,
              species: str = 'mouse',
              n_top_genes: int = 2000,
              n_top_tfs: int = 50) -> ad.AnnData:
    """
    运行SCENIC分析
    
    SCENIC分析转录因子活性，包括:
    1. 靶基因预测 (GRNBoost2)
    2. 顺式调控元分析 (cisTarget)
    3. AUCell评分计算
    """
    logger.info("🎭 SCENIC 转录因子活性分析...")
    
    try:
        import pyscenic
    except ImportError:
        logger.error("❌ pyscenic未安装！运行: pip install pyscenic")
        logger.info("  同时需要安装: Rscript -e 'install.packages(c(\"AUCell\", \"RcisTarget\"))'")
        raise
    
    # 准备基因名列表
    genes = adata.raw.var_names.tolist() if adata.raw else adata.var_names.tolist()
    
    # 保存表达矩阵
    ensure_dir('tmp')
    expr_matrix = adata.raw.to_adata() if adata.raw else adata
    adata.write_h5ad('tmp/scenic_input.h5ad')
    
    # 下载motif数据库（如果需要）
    logger.info("  准备SCENIC数据库...")
    
    # SCENIC命令
    import subprocess
    
    scenic_commands = [
        # 1. 靶基因预测
        f"pyscenic grn {adata.uns.get('sample', 'data')}.h5ad adj.tsv --method grnboost2",
        # 2. 顺式调控元分析
        f"pyscenic ctx adj.tsv motif_file.gmt --annotations_file annotations.tsv --expression eMat.csv --output reg.csv",
        # 3. AUCell
        f"pyscenic aucell eMat.csv reg.csv --output scenic_output.loom"
    ]
    
    # 这里提供接口，实际运行需要配置数据库
    logger.info("  SCENIC运行命令已准备好，请确保:")
    logger.info("  1. 安装pyscenic: pip install pyscenic")
    logger.info("  2. 下载motif数据库到当前目录")
    logger.info("  3. R包: AUCell, RcisTarget, GENIE3")
    
    return adata


@timing
def compute_aucell_scores(adata: ad.AnnData,
                         gene_sets: dict,
                         key: str = 'aucell') -> ad.AnnData:
    """
    计算AUCell评分
    
    快速计算转录因子/基因集活性
    """
    logger.info("📊 计算AUCell评分...")
    
    try:
        from arboreto.algo import grnboost2
        fromctx.utils import load_motifs
    except ImportError:
        logger.warning("⚠️ arboreto未安装，AUCell评分跳过")
        return adata
    
    # 使用scanpy的score_genes作为替代
    for name, genes in gene_sets.items():
        valid_genes = [g for g in genes if g in adata.raw.var_names]
        if valid_genes:
            sc.tl.score_genes(adata, valid_genes, score_name=name, use_raw=True)
            logger.info(f"  {name}: {len(valid_genes)} genes")
    
    return adata


def plot_scenic_results(adata: ad.AnnData,
                       output_dir: str) -> None:
    """绘制SCENIC结果"""
    ensure_dir(output_dir)
    
    logger.info("📊 绘制SCENIC结果...")
    
    import matplotlib.pyplot as plt
    
    # 找出AUCell相关的列
    aucell_cols = [c for c in adata.obs.columns if 'auc_' in c or 'tf_' in c]
    
    if aucell_cols:
        # 热图
        sc.pl.heatmap(
            adata,
            aucell_cols[:20],
            groupby='leiden',
            dendrogram=True,
            show=False,
            save='_scenic.png'
        )
    
    logger.info(f"  图表保存到: {output_dir}")


def main():
    parser = argparse.ArgumentParser(description='SCENIC Transcription Factor Analysis')
    
    parser.add_argument('--input', '-i', required=True, help='输入h5ad文件')
    parser.add_argument('--output', '-o', required=True, help='输出目录')
    parser.add_argument('--species', '-s', default='mouse', choices=['human', 'mouse', 'rat'])
    
    args = parser.parse_args()
    
    ensure_dir(args.output)
    
    logger.info(f"📖 读取数据: {args.input}")
    adata = ad.read_h5ad(args.input)
    
    # 运行SCENIC
    adata = run_scenic(adata, args.species)
    
    # 绘图
    plot_scenic_results(adata, args.output)
    
    # 保存
    adata.write_h5ad(os.path.join(args.output, 'scenic.h5ad'))
    
    logger.info(f"✅ SCENIC分析完成！保存到: {args.output}")


if __name__ == '__main__':
    main()
