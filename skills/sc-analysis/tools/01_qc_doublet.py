#!/usr/bin/env python3
"""
Step 01: QC质控 + Doublet检测

【功能说明】
- 加载10X HDF5/MTX格式的原始数据
- 计算QC指标（基因数、UMI数、线粒体比例、核糖体比例）
- 过滤低质量细胞（基因数、线粒体阈值过滤）
- 使用Scrublet检测doublets

【用法】
    python tools/01_qc_doublet.py \\
        --input /path/to/data/*.h5 \\
        --samples Sample1,Sample2 \\
        --output ./qc \\
        --species mouse \\
        --min-genes 200 \\
        --max-genes 6000 \\
        --max-mito 10 \\
        --doublet-rate 0.05

【参数说明】
    --input       : 输入文件路径，支持:
                   - 10X HDF5文件 (*.h5)
                   - 10X MTX目录 (包含 matrix.mtx, genes.tsv, barcodes.tsv)
                   - 多文件用逗号分隔
    --samples     : 样本名称，逗号分隔，与--input顺序对应
    --output      : 输出目录路径
    --species     : 物种 (human/mouse/rat)，用于识别线粒体基因模式
    --min-genes  : 最小基因数阈值，默认200
    --max-genes  : 最大基因数阈值，默认6000
    --max-mito   : 最大线粒体比例(%)，默认10
    --doublet-rate: 预期doublet比例，默认0.05
    --no-scrublet : 跳过Scrublet doublet检测

【输出】
    - clean.h5ad      : 清洗后的AnnData对象
    - qc_summary.csv  : 各样本QC统计表
    - qc_metrics.png  : QC指标可视化图

【示例】
    # 单样本
    python tools/01_qc_doublet.py -i sample.h5 -s S1 -o qc/ -s mouse
    
    # 多样本
    python tools/01_qc_doublet.py -i S1.h5,S2.h5 -s S1,S2 -o qc/ -s mouse
    
    # 大数据（目录形式）
    python tools/01_qc_doublet.py -i /data/10X/run1/ -s S1 -o qc/
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
from scipy import sparse

# 添加父目录到路径
sys.path.insert(0, str(Path(__file__).parent.parent))
from utils.core_utils import ensure_dir, plot_qc, compute_qc_metrics, filter_cells, timing, check_gpu, logger

logging.basicConfig(level=logging.INFO, format='%(asctime)s | %(levelname)-8s | %(message)s', datefmt='%H:%M:%S')
logger = logging.getLogger(__name__)

# 物种线粒体基因模式（R脚本风格）
MT_PATTERNS = {
    'human': r'^MT-',      # 大写MT-
    'mouse': r'^mt-',      # 小写mt-
    'rat': r'^Mt-'         # 首字母大写
}

# 核糖体基因模式
RIBOSOME_PATTERNS = r'^RP[LS]'

# R脚本的配色方案
COLOR_PANEL = ['#53A85F','#58A4C3','#AB3282','#8C549C','#BD956A','#57C3F3',
               '#6778AE','#F3B1A0','#F1BB72','#DCC1DD','#E95C59','#625D9E',
               '#F7F398','#E63863','#5F3D69','#C5DEBA','#CCE0F5','#B53E2B',
               '#AA9A59','#E39A35','#91D0BE','#23452F','#E4C755','#585658',
               '#C1E6F3','#D6E7A3','#712820','#CCC9E6','#3A6963','#68A180',
               '#476D87','#9FA3A8','#968175']


def calculate_mad_threshold(values: np.ndarray, nmads: int = 3) -> dict:
    """
    使用MAD（中位数绝对偏差）自动计算阈值
    来自R脚本 qc-filter.R 的 calculate_mad_threshold 函数
    
    Args:
        values: 数值数组
        nmads: MAD倍数，默认3
        
    Returns:
        {'lower': 下界, 'upper': 上界}
    """
    med = np.median(values)
    mad_val = np.median(np.abs(values - med))
    lower = med - nmads * mad_val
    upper = med + nmads * mad_val
    return {'lower': max(lower, 0), 'upper': upper}  # 下界不小于0


@timing
def load_10x_data(input_paths: List[str], sample_names: List[str]) -> ad.AnnData:
    """加载10X数据"""
    logger.info(f"📁 加载 {len(input_paths)} 个样本...")
    
    adatas = []
    for path, name in zip(input_paths, sample_names):
        path = path.strip()
        if not path:
            continue
            
        logger.info(f"  → {name}: {path}")
        
        if path.endswith('.h5') or 'matrix.mtx' in path:
            if os.path.isdir(path):
                adata = sc.read_10x_mtx(path, var_names='gene_symbols')
            else:
                adata = sc.read_10x_h5(path)
        elif path.endswith('.h5ad'):
            adata = ad.read_h5ad(path)
        elif path.endswith('.csv') or path.endswith('.txt'):
            adata = sc.read_text(path, delimiter='\t' if path.endswith('.txt') else ',')
        else:
            raise ValueError(f"不支持的文件格式: {path}")
        
        adata.var_names_make_unique()
        adata.obs['sample'] = name
        adata.obs['n_genes'] = (adata.X > 0).sum(axis=1).A1 if sparse.issparse(adata.X) else (adata.X > 0).sum(axis=1)
        adata.obs['n_counts'] = adata.X.sum(axis=1).A1 if sparse.issparse(adata.X) else adata.X.sum(axis=1)
        
        adatas.append(adata)
    
    # 合并
    if len(adatas) == 1:
        combined = adatas[0]
    else:
        combined = ad.concat(adatas, join='outer', merge='same')
    
    logger.info(f"✅ 合并完成: {combined.n_obs} cells, {combined.n_vars} genes")
    return combined


@timing
def detect_doublets_scrublet(adata: ad.AnnData, 
                              expected_doublet_rate: float = 0.05,
                              sample_name: str = 'sample') -> ad.AnnData:
    """使用Scrublet检测doublets"""
    try:
        import scrublet as scr
    except ImportError:
        logger.warning("⚠️ Scrublet未安装，跳过doublet检测")
        return adata
    
    logger.info(f"🧪 Scrublet doublet检测 (expected_rate={expected_doublet_rate})...")
    
    # 准备原始count矩阵
    if sparse.issparse(adata.X):
        counts_matrix = adata.X.toarray()
    else:
        counts_matrix = adata.X
    
    # 初始化Scrublet
    scrub = scr.Scrublet(
        counts_matrix=counts_matrix,
        expected_doublet_rate=expected_doublet_rate,
        sim_doublet_ratio=3,
        n_neighbors=None
    )
    
    # 检测doublets
    doublet_scores, predicted_doublets = scrub.scrub_doublets(
        min_counts=2,
        min_cells=3,
        min_gene_variability_pctl=85,
        n_prin_comps=30
    )
    
    adata.obs['doublet_score_scrublet'] = doublet_scores
    adata.obs['is_doublet_scrublet'] = predicted_doublets
    
    n_doublets = predicted_doublets.sum()
    logger.info(f"  Scrublet检测到 {n_doublets} doublets ({n_doublets/len(predicted_doublets)*100:.1f}%)")
    
    return adata


@timing  
def detect_doublets_doubletfinder(adata: ad.AnnData, 
                                   n_neighbors: int = 20,
                                   prop_fk: float = 0.25) -> ad.AnnData:
    """使用DoubletFinder检测doublets"""
    try:
        import rpy2.robjects as ro
        from rpy2.robjects import pandas2ri
        pandas2ri.activate()
    except ImportError:
        logger.warning("⚠️ rpy2未安装，跳过DoubletFinder")
        return adata
    
    logger.info("🧪 DoubletFinder doublet检测...")
    
    # R代码
    r_code = f'''
    library(DoubletFinder)
    library(Seurat)
    
    # 转换为Seurat
    counts <- Seurat::as.sparse(GetAssayData({adata.__class__.__name__}, slot="counts"))
    seurat_obj <- CreateSeuratObject(counts)
    seurat_obj <- NormalizeData(seurat_obj)
    seurat_obj <- FindVariableFeatures(seurat_obj, nfeatures = 2000)
    seurat_obj <- ScaleData(seurat_obj)
    seurat_obj <- RunPCA(seurat_obj)
    seurat_obj <- FindNeighbors(seurat_obj, dims = 1:{n_neighbors*2})
    seurat_obj <- FindClusters(seurat_obj, resolution = 0.8)
    
    # 优化PK
    sweep.res <- paramSweep_v3(seurat_obj, PCs = 1:{n_neighbors*2}, sct = FALSE)
    sweep.stats <- summarizeSweep(sweep.res)
    bcmvn <- find.pK(sweep.stats)
    optimal.pk <- as.numeric(as.vector(bcmvn$pK[which.max(bcmvarn$bcmvn + 0)]))
    
    # DoubletFinder
    nExp_poi <- round({prop_fk} * nrow(seurat_obj@meta.data))
    seurat_obj <- doubletFinder_v3(seurat_obj, PCs = 1:{n_neighbors*2}, pN = 0.25, pK = optimal.pk, nExp = nExp_poi)
    
    DF.name <- colnames(seurat_obj@meta.data)[grep("DF.classifications", colnames(seurat_obj@meta.data))]
    seurat_obj$is_doublet_df <- seurat_obj@meta.data[, DF.name] == "Doublet"
    '''
    
    # 这个需要R环境，这里提供接口，实际运行时需要R脚本
    logger.info("  注: DoubletFinder需要R环境，请运行配套的R脚本")
    return adata


@timing
def remove_doublets(adata: ad.AnnData, 
                     max_doublet_score: float = 0.4,
                     remove_scrublet: bool = True) -> ad.AnnData:
    """去除doublets"""
    n_before = adata.n_obs
    
    # 基于Scrublet score过滤
    if remove_scrublet and 'doublet_score_scrublet' in adata.obs:
        threshold = adata.obs['doublet_score_scrublet'].quantile(1 - 0.05)  # top 5%
        threshold = min(threshold, max_doublet_score)
        adata = adata[adata.obs['doublet_score_scrublet'] < threshold, :]
        logger.info(f"  基于Scrublet score过滤 (threshold={threshold:.3f})")
    
    n_after = adata.n_obs
    logger.info(f"✅ Doublet过滤: {n_before} → {n_after} cells (移除 {n_before - n_after})")
    
    return adata


@timing
def run_qc_pipeline(input_paths: List[str], 
                    sample_names: List[str],
                    output_dir: str,
                    species: str = 'mouse',
                    min_genes: int = 200,
                    max_genes: int = 6000,
                    max_mito_pct: float = 10,
                    expected_doublet_rate: float = 0.05,
                    run_scrublet: bool = True,
                    auto_threshold: bool = False) -> str:
    """完整QC流程（R脚本风格增强版）"""
    
    ensure_dir(output_dir)
    
    # 1. 加载数据
    adata = load_10x_data(input_paths, sample_names)
    
    # 记录原始细胞数
    total_cells_before = adata.n_obs
    
    # 2. 计算QC指标（包含核糖体比例，R脚本风格）
    adata = compute_qc_metrics(adata, species)
    
    # 如果有n_genes_raw等原始指标，用它们计算阈值
    if 'n_genes_raw' in adata.obs.columns:
        n_genes = adata.obs['n_genes_raw'].values
    else:
        n_genes = adata.obs['n_genes'].values if 'n_genes' in adata.obs.columns else adata.obs['nCount_RNA'].values if 'nCount_RNA' in adata.obs.columns else None
    
    if 'pct_mito_raw' in adata.obs.columns:
        pct_mito = adata.obs['pct_mito_raw'].values
    elif 'percent.mt' in adata.obs.columns:
        pct_mito = adata.obs['percent.mt'].values
    else:
        pct_mito = adata.obs['pct_mito'].values if 'pct_mito' in adata.obs.columns else None
    
    # 3. 自动阈值检测（R脚本风格MAD方法）
    if auto_threshold:
        logger.info("🔍 使用MAD自动检测阈值...")
        if n_genes is not None:
            gene_thresh = calculate_mad_threshold(n_genes, nmads=3)
            min_genes = int(gene_thresh['lower'])
            max_genes = int(gene_thresh['upper'])
            logger.info(f"  基因数阈值: [{min_genes}, {max_genes}]")
        if pct_mito is not None:
            mt_thresh = calculate_mad_threshold(pct_mito, nmads=3)
            max_mito_pct = mt_thresh['upper']
            logger.info(f"  线粒体阈值: < {max_mito_pct:.1f}%")
    
    # 4. 过滤前QC图（R脚本风格）
    plot_qc_by_sample(adata, os.path.join(output_dir, '0.QC'), sample_names, prefix='raw')
    
    # 5. 过滤
    adata = filter_cells(adata, min_genes, max_genes, max_mito_pct)
    
    # 6. Doublet检测
    n_doublets = 0
    if run_scrublet:
        adata = detect_doublets_scrublet(adata, expected_doublet_rate)
        n_doublets = adata.obs['is_doublet_scrublet'].sum() if 'is_doublet_scrublet' in adata.obs.columns else 0
        adata = remove_doublets(adata)
    
    # 7. 过滤后QC图
    plot_qc_by_sample(adata, os.path.join(output_dir, '0.QC'), sample_names, prefix='filter')
    
    # 8. 保存raw数据
    adata.raw = adata.copy()
    
    # 9. 保存结果
    output_path = os.path.join(output_dir, 'clean.h5ad')
    adata.write_h5ad(output_path)
    
    # 10. 保存详细QC统计（R脚本风格）
    qc_stats = []
    for sample in sample_names:
        sample_data = adata[adata.obs['sample'] == sample]
        qc_stats.append({
            'Sample': sample,
            'Cells_Before': total_cells_before // len(sample_names),  # 估算
            'Cells_After': sample_data.n_obs,
            'Min_Features': min_genes,
            'Max_Features': max_genes,
            'Max_MT': max_mito_pct,
            'Mean_Genes': round(sample_data.obs['n_genes'].mean(), 1) if 'n_genes' in sample_data.obs.columns else 0,
            'Mean_Counts': round(sample_data.obs['n_counts'].mean(), 1) if 'n_counts' in sample_data.obs.columns else 0,
            'Mean_MT_pct': round(sample_data.obs['pct_mito'].mean(), 2) if 'pct_mito' in sample_data.obs.columns else 0
        })
    
    qc_stats_df = pd.DataFrame(qc_stats)
    qc_stats_df.to_csv(os.path.join(output_dir, '0.QC', 'QC_summary.txt'), sep='\t', index=False)
    
    logger.info(f"✅ QC完成！结果保存到: {output_path}")
    return output_path


def plot_qc_by_sample(adata: ad.AnnData, 
                     output_dir: str,
                     sample_names: list,
                     prefix: str = 'raw') -> None:
    """绘制每个样本的QC图（R脚本风格）"""
    import matplotlib.pyplot as plt
    import seaborn as sns
    
    ensure_dir(output_dir)
    
    n_samples = len(sample_names)
    n_cols = min(4, n_samples)
    n_rows = (n_samples + n_cols - 1) // n_cols
    
    # nFeature图
    fig, axes = plt.subplots(n_rows, n_cols, figsize=(5*n_cols, 4*n_rows))
    if n_rows == 1:
        axes = [axes] if n_samples == 1 else axes.flatten()
    else:
        axes = axes.flatten()
    
    for idx, sample in enumerate(sample_names):
        ax = axes[idx]
        sample_data = adata[adata.obs['sample'] == sample]
        if 'n_genes' in sample_data.obs.columns:
            data = sample_data.obs['n_genes']
        elif 'nFeature_RNA' in sample_data.obs.columns:
            data = sample_data.obs['nFeature_RNA']
        else:
            continue
        sns.violinplot(y=data, ax=ax, color='steelblue')
        ax.set_title(f'{sample} - nFeature')
        ax.set_ylabel('nFeature_RNA')
    
    # 隐藏多余的子图
    for idx in range(len(sample_names), len(axes)):
        axes[idx].set_visible(False)
    
    plt.tight_layout()
    plt.savefig(os.path.join(output_dir, f'nFeature_{prefix}.png'), dpi=100, bbox_inches='tight')
    plt.close()
    
    # nCount图
    fig, axes = plt.subplots(n_rows, n_cols, figsize=(5*n_cols, 4*n_rows))
    if n_rows == 1:
        axes = [axes] if n_samples == 1 else axes.flatten()
    else:
        axes = axes.flatten()
    
    for idx, sample in enumerate(sample_names):
        ax = axes[idx]
        sample_data = adata[adata.obs['sample'] == sample]
        if 'n_counts' in sample_data.obs.columns:
            data = sample_data.obs['n_counts']
        elif 'nCount_RNA' in sample_data.obs.columns:
            data = sample_data.obs['nCount_RNA']
        else:
            continue
        sns.violinplot(y=data, ax=ax, color='coral')
        ax.set_title(f'{sample} - nCount')
        ax.set_ylabel('nCount_RNA')
    
    for idx in range(len(sample_names), len(axes)):
        axes[idx].set_visible(False)
    
    plt.tight_layout()
    plt.savefig(os.path.join(output_dir, f'nCount_{prefix}.png'), dpi=100, bbox_inches='tight')
    plt.close()
    
    # MT图
    fig, axes = plt.subplots(n_rows, n_cols, figsize=(5*n_cols, 4*n_rows))
    if n_rows == 1:
        axes = [axes] if n_samples == 1 else axes.flatten()
    else:
        axes = axes.flatten()
    
    for idx, sample in enumerate(sample_names):
        ax = axes[idx]
        sample_data = adata[adata.obs['sample'] == sample]
        if 'pct_mito' in sample_data.obs.columns:
            data = sample_data.obs['pct_mito']
        elif 'percent.mt' in sample_data.obs.columns:
            data = sample_data.obs['percent.mt']
        else:
            continue
        sns.violinplot(y=data, ax=ax, color='indianred')
        ax.set_title(f'{sample} - %MT')
        ax.set_ylabel('percent.mt')
    
    for idx in range(len(sample_names), len(axes)):
        axes[idx].set_visible(False)
    
    plt.tight_layout()
    plt.savefig(os.path.join(output_dir, f'mt_{prefix}.png'), dpi=100, bbox_inches='tight')
    plt.close()
    
    logger.info(f"  QC图保存: {output_dir}/{prefix}_*.png")


def main():
    parser = argparse.ArgumentParser(description='scRNA-seq QC + Doublet Detection')
    
    parser.add_argument('--input', '-i', required=True, help='输入文件/目录，逗号分隔多样本')
    parser.add_argument('--samples', '-s', required=True, help='样本名，逗号分隔')
    parser.add_argument('--output', '-o', required=True, help='输出目录')
    parser.add_argument('--species', default='mouse', choices=['human', 'mouse', 'rat'], 
                       help='物种 (human/mouse/rat)')
    parser.add_argument('--min-genes', type=int, default=200, help='最小基因数')
    parser.add_argument('--max-genes', type=int, default=6000, help='最大基因数')
    parser.add_argument('--max-mito', type=float, default=10, help='最大线粒体比例(%%)')
    parser.add_argument('--doublet-rate', type=float, default=0.05, help='预期doublet比例')
    parser.add_argument('--no-scrublet', action='store_true', help='跳过Scrublet检测')
    parser.add_argument('--auto-threshold', action='store_true', 
                       help='使用MAD自动检测阈值（R脚本风格）')
    
    args = parser.parse_args()
    
    inputs = [x.strip() for x in args.input.split(',')]
    samples = [x.strip() for x in args.samples.split(',')]
    
    check_gpu()
    run_qc_pipeline(inputs, samples, args.output, args.species,
                   args.min_genes, args.max_genes, args.max_mito,
                   args.doublet_rate, not args.no_scrublet,
                   auto_threshold=args.auto_threshold)


if __name__ == '__main__':
    main()
