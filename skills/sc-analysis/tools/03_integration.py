#!/usr/bin/env python3
"""
Step 03: 样本整合

【功能说明】
- scVI: GPU加速的变分自编码器批次校正（效果最好）
- Harmony: 经典软聚类批次校正（快速CPU）
- BBKNN: 邻居图级别批次校正（最快）
- ComBat: 经验贝叶斯方法
- scANVI: 半监督scVI（需要细胞注释）

【用法】
    python tools/03_integration.py \\
        --input sct.h5ad \\
        --output ./integration \\
        --method scvi \\
        --batch-key sample \\
        --n-latent 30 \\
        --max-epochs 100

【参数说明】
    --input       : 输入h5ad文件
    --output      : 输出目录
    --method      : 整合方法 (scvi/harmony/bbknn/combat/scanvi)
    --batch-key  : 批次列名，默认sample
    --n-latent   : scVI潜在维度，默认30
    --max-epochs : 最大训练轮数，默认100
    --n-pcs      : Harmony/BBKNN的PCA维度，默认50

【方法选择建议】
    scvi   : 大数据、追求最佳效果、需要GPU
    harmony : 中等数据、通用场景
    bbknn  : 超大10万+细胞、快速
    combat  : 简单批次校正

【输出】
    - integrated.h5ad : 整合后的AnnData对象

【示例】
    # GPU加速整合
    python tools/03_integration.py -i sct.h5ad -o int/ --method scvi --batch-key sample
    
    # CPU快速整合
    python tools/03_integration.py -i sct.h5ad -o int/ --method harmony --batch-key sample
"""

__author__ = "CatsCo"
__version__ = "3.1.0"

import os
import sys
import argparse
import logging
from pathlib import Path

import numpy as np
import anndata as ad
import scanpy as sc
import torch

sys.path.insert(0, str(Path(__file__).parent.parent))
from utils.core_utils import ensure_dir, timing, check_gpu, logger

logging.basicConfig(level=logging.INFO, format='%(asctime)s | %(levelname)-8s | %(message)s', datefmt='%H:%M:%S')
logger = logging.getLogger(__name__)

# R脚本的配色方案
COLOR_PANEL = ['#53A85F','#58A4C3','#AB3282','#8C549C','#BD956A','#57C3F3',
               '#6778AE','#F3B1A0','#F1BB72','#DCC1DD','#E95C59','#625D9E',
               '#F7F398','#E63863','#5F3D69','#C5DEBA','#CCE0F5','#B53E2B',
               '#AA9A59','#E39A35','#91D0BE','#23452F','#E4C755','#585658',
               '#C1E6F3','#D6E7A3','#712820','#CCC9E6','#3A6963','#68A180',
               '#476D87','#9FA3A8','#968175']

# 细胞周期基因（R脚本风格，来自merge-harmony.R）
CC_GENES = {
    's_genes': ['MCM5', 'PCNA', 'TYMS', 'FEN1', 'MCM2', 'MCM4', 'RRM1', 'UNG', 'GINS2', 'MCM6', 
                'CDCA7', 'DTL', 'PRIM1', 'SSRP1', 'ASF1B', 'PBX3', 'GINS4', 'SLBP', 'CCNE2', 'CDC45',
                'NASP', 'HELLS', 'RFC2', 'RPA2', 'WDR76', 'SLBP', 'EXO1', 'TIPIN', 'CSRP2', 'FAM64A',
                'CLSPN', 'HN1', 'PTX2', 'PAQR3', 'GMNN', 'WDR76', 'SPDLE1', 'EZH2', 'FAM64A', 'CITED4'],
    'g2m_genes': ['HMGB2', 'CDK1', 'NUSAP1', 'UBE2C', 'BIRC5', 'TPX2', 'TOP2A', 'NDC80', 'CKS2', 
                  'NUF2', 'CKS1B', 'MKI67', 'TMPO', 'CENPF', 'TACC3', 'FAM64A', 'SMNDC1', 'GTSE1', 
                  'KIF20B', 'HJURP', 'HN1', 'CDC25C', 'KIF2C', 'TMPO', 'CKAP5', 'CETN2', 'ACOT7', 
                  'GAS2L3', 'TUBB4B', 'GTSE1', 'CDCA3', 'HN1', 'CDC25C', 'ANP32E', 'TUBB4B']
}


@timing
def integrate_scvi(adata: ad.AnnData,
                   batch_key: str = 'sample',
                   n_latent: int = 30,
                   max_epochs: int = 100,
                   early_stopping: bool = True) -> ad.AnnData:
    """
    scVI整合 - GPU加速的深度学习方法
    
    scVI使用变分自编码器学习数据的潜在表示，
    能有效消除批次效应同时保留生物学变异
    """
    logger.info("🚀 scVI 整合 (GPU加速)...")
    
    use_gpu = check_gpu()
    
    try:
        import scvi
        from scvi.model import SCVI, SCVI_PLUS, SCANVI
    except ImportError:
        logger.error("❌ scvi-tools 未安装！运行: pip install scvi-tools")
        raise
    
    # 设置随机种子
    scvi.settings.seed = 42
    
    # 配置GPU
    if use_gpu:
        logger.info("  使用 GPU 加速训练")
        # pytorch会使用可用GPU
    else:
        logger.info("  使用 CPU 训练 (较慢)")
    
    # 准备数据
    adata_manager = scvi.data.setup_anndata(
        adata,
        batch_key=batch_key,
        labels_key=None,
        categorical_covariate_keys=None,
        continuous_covariate_keys=['n_counts']
    )
    
    # 创建模型
    model = SCVI(adata, n_latent=n_latent)
    
    # 训练
    logger.info(f"  训练中... (max_epochs={max_epochs})")
    model.train(
        max_epochs=max_epochs,
        early_stopping=early_stopping,
        patience=15,
        accelerator='gpu' if use_gpu else 'cpu',
        devices=1 if use_gpu else None,
        plan_kwargs={
            'lr': 0.001,
            'weight_decay': 0.01,
            'n_epochs_kl_warmup': 50
        }
    )
    
    # 获取潜在表示
    adata.obsm['X_scvi'] = model.get_latent_representation()
    
    # 计算邻居图
    sc.pp.neighbors(adata, use_rep='X_scvi', key_added='scvi')
    
    logger.info("✅ scVI 整合完成")
    return adata


@timing
def integrate_harmony(adata: ad.AnnData,
                     batch_key: str = 'sample',
                     max_iter: int = 20,
                     n_pcs: int = 50,
                     vars_to_regress: list = None) -> ad.AnnData:
    """
    Harmony整合 - 经典的批次校正方法（R脚本风格增强）
    
    Harmony使用迭代软聚类来校正批次效应，
    优点是速度快、不需要GPU
    """
    logger.info("🔄 Harmony 整合...")
    
    # 1. CellCycleScoring（R脚本风格，来自merge-harmony.R）
    if vars_to_regress is None:
        vars_to_regress = []
    
    # 检测是否有S/G2M score
    if 'S.Score' not in adata.obs or 'G2M.Score' not in adata.obs:
        logger.info("  执行CellCycleScoring...")
        try:
            # 过滤细胞周期基因（只保留在数据中存在的）
            s_genes = [g for g in CC_GENES['s_genes'] if g in adata.var_names]
            g2m_genes = [g for g in CC_GENES['g2m_genes'] if g in adata.var_names]
            
            if len(s_genes) > 10 and len(g2m_genes) > 10:
                sc.tl.score_genes_cell_cycle(adata, s_genes=s_genes, g2m_genes=g2m_genes)
                vars_to_regress = vars_to_regress + ['S.Score', 'G2M.Score']
                logger.info(f"  细胞周期评分完成: S.Score, G2M.Score")
        except Exception as e:
            logger.warning(f"  CellCycleScoring失败: {e}")
    
    # 2. 标准化和特征选择
    if adata.raw is not None:
        adata = adata.raw.to_adata()
    else:
        adata = adata.copy()
    
    sc.pp.normalize_total(adata, target_sum=1e4)
    sc.pp.log1p(adata)
    sc.pp.highly_variable_genes(adata, n_top_genes=2000, flavor='seurat_v3')
    sc.pp.scale(adata, max_value=10)
    
    # 3. 回归细胞周期分数
    if 'S.Score' in adata.obs and 'G2M.Score' in adata.obs and vars_to_regress:
        logger.info("  回归细胞周期效应...")
        sc.pp.regress_out(adata, vars_to_regress)
    
    # 4. PCA
    sc.tl.pca(adata, n_comps=n_pcs, svd_solver='arpack')
    
    try:
        import harmonypy as hm
    except ImportError:
        logger.error("❌ harmonypy 未安装！运行: pip install harmonypy")
        raise
    
    # 5. Harmony校正
    logger.info(f"  Harmony迭代中... (max_iter={max_iter})")
    ho = hm.run_harmony(
        adata.obsm['X_pca'],
        adata.obs,
        batch_key,
        max_iter_harmony=max_iter,
        n_pcs=n_pcs
    )
    
    adata.obsm['X_harmony'] = ho.Z_corr
    
    # 6. 用Harmony结果计算邻居图
    sc.pp.neighbors(adata, use_rep='X_harmony', key_added='harmony')
    
    logger.info("✅ Harmony 整合完成")
    return adata


def plot_integration_qc(adata: ad.AnnData, output_dir: str, batch_key: str = 'sample') -> None:
    """
    绘制整合后的QC图（R脚本风格）
    来自 merge-harmony.R 的可视化部分
    """
    import matplotlib.pyplot as plt
    
    ensure_dir(output_dir)
    ensure_dir(os.path.join(output_dir, 'merge_rds'))
    
    # 确保有UMAP
    if 'X_umap' not in adata.obsm:
        logger.info("  计算UMAP...")
        sc.tl.umap(adata)
    
    # 1. 聚类UMAP（按cluster标注）
    if 'leiden' in adata.obs or any(c.startswith('leiden') for c in adata.obs.columns):
        leiden_col = [c for c in adata.obs.columns if c.startswith('leiden')][0]
        fig = sc.pl.umap(adata, color=leiden_col, return_fig=True, frameon=False)
        fig.savefig(os.path.join(output_dir, '1.cluster', 'merge_umap.png'), dpi=150, bbox_inches='tight')
        fig.savefig(os.path.join(output_dir, '1.cluster', 'merge_umap.pdf'), bbox_inches='tight')
        plt.close()
    
    # 2. 分组UMAP
    if 'group' in adata.obs:
        fig = sc.pl.umap(adata, color='group', split_by='group', return_fig=True, frameon=False)
        fig.savefig(os.path.join(output_dir, '1.cluster', 'merge_group_umap.png'), dpi=150, bbox_inches='tight')
        plt.close()
    
    # 3. 样本UMAP
    fig = sc.pl.umap(adata, color=batch_key, split_by=batch_key, return_fig=True, frameon=False)
    fig.savefig(os.path.join(output_dir, '1.cluster', 'merge_sample_umap.png'), dpi=150, bbox_inches='tight')
    plt.close()
    
    # 4. QC特征图
    qc_features = [f for f in ['n_genes', 'n_counts', 'pct_mito', 'percent.mt'] if f in adata.obs.columns]
    ribo_features = [f for f in ['pct_ribo', 'percent.rp'] if f in adata.obs.columns]
    qc_features.extend(ribo_features)
    
    if qc_features:
        fig = sc.pl.umap(adata, color=qc_features[:4], return_fig=True, frameon=False)
        fig.savefig(os.path.join(output_dir, '1.cluster', 'nFeature_nCount_mt_featureplot.png'), dpi=150, bbox_inches='tight')
        plt.close()
    
    # 5. 小提琴图
    if qc_features:
        fig = sc.pl.violin(adata, keys=qc_features[:3], groupby='leiden' if 'leiden' in adata.obs else batch_key, 
                          return_fig=True)
        fig.savefig(os.path.join(output_dir, '1.cluster', 'nFeature_nCount_mt_violin.png'), dpi=150, bbox_inches='tight')
        plt.close()
    
    logger.info(f"  整合QC图保存到: {output_dir}/1.cluster/")


@timing
def integrate_bbknn(adata: ad.AnnData,
                    batch_key: str = 'sample',
                    n_pcs: int = 50) -> ad.AnnData:
    """
    BBKNN整合 - 最快的批次校正方法
    
    BBKNN在邻居图层面进行批次校正，
    速度最快，适合超大数据集
    """
    logger.info("⚡ BBKNN 整合...")
    
    try:
        import bbknn
    except ImportError:
        logger.error("❌ bbknn 未安装！运行: pip install bbknn")
        raise
    
    # 确保有PCA
    if 'X_pca' not in adata.obsm:
        logger.info("  先运行PCA...")
        sc.tl.pca(adata, n_comps=n_pcs, svd_solver='arpack')
    
    # BBKNN邻居图
    logger.info("  构建批次感知邻居图...")
    bbknn.knn_graph(
        adata,
        batch_key=batch_key,
        n_pcs=n_pcs,
        neighbors_within_batch=5,
        trim_or_swap=True
    )
    
    logger.info("✅ BBKNN 整合完成")
    return adata


@timing
def integrate_scanvi(adata: ad.AnnData,
                    batch_key: str = 'sample',
                    n_latent: int = 30,
                    max_epochs: int = 100) -> ad.AnnData:
    """
    scANVI整合 - 半监督的scVI
    
    scANVI可以整合有标签和无标签的数据，
    适合有参考注释数据的整合分析
    """
    logger.info("🎯 scANVI 半监督整合...")
    
    try:
        import scvi
        from scvi.model import SCANVI
    except ImportError:
        logger.error("❌ scvi-tools 未安装！")
        raise
    
    # 检查是否有标签
    if 'cell_type' not in adata.obs:
        logger.warning("⚠️ 没有细胞类型标签，使用普通scVI")
        return integrate_scvi(adata, batch_key, n_latent, max_epochs)
    
    # 标记未知细胞
    adata.obs['labels'] = adata.obs['cell_type'].fillna('Unknown')
    
    # 设置数据
    scvi.data.setup_anndata(
        adata,
        batch_key=batch_key,
        labels_key='labels'
    )
    
    # 训练scANVI
    model = SCANVI(adata, 'Unknown', n_latent=n_latent)
    model.unlabeled_category = 'Unknown'
    model.train(max_epochs=max_epochs)
    
    # 获取表示
    adata.obsm['X_scanvi'] = model.get_latent_representation()
    adata.obs['scanvi_pred'] = model.predict()
    
    sc.pp.neighbors(adata, use_rep='X_scanvi', key_added='scanvi')
    
    logger.info("✅ scANVI 整合完成")
    return adata


@timing
def integrate_combat(adata: ad.AnnData,
                    batch_key: str = 'sample') -> ad.AnnData:
    """
    ComBat整合 - 经典经验贝叶斯方法
    
    ComBat是最早的批次校正方法之一，
    简单有效，但可能过度校正
    """
    logger.info("📊 ComBat 整合...")
    
    try:
        from combat import combat
    except ImportError:
        # 使用scanpy内置的combat
        logger.info("  使用scanpy内置Combat")
        adata_int = adata.copy()
        sc.pp.combat(adata_int, key=batch_key)
        adata.obsm['X_combat'] = adata_int.X
        return adata
    
    # ComBat校正
    adata_combat = combat(adata.X.T, adata.obs[batch_key].values)
    adata.obsm['X_combat'] = adata_combat.T
    
    sc.pp.neighbors(adata, use_rep='X_combat', key_added='combat')
    
    logger.info("✅ ComBat 整合完成")
    return adata


def main():
    parser = argparse.ArgumentParser(description='Sample Integration')
    
    parser.add_argument('--input', '-i', required=True, help='输入h5ad文件')
    parser.add_argument('--output', '-o', required=True, help='输出目录')
    parser.add_argument('--method', '-m', 
                       choices=['scvi', 'harmony', 'bbknn', 'scanvi', 'combat'],
                       default='scvi',
                       help='整合方法')
    parser.add_argument('--batch-key', default='sample', help='批次列')
    parser.add_argument('--n-latent', type=int, default=30, help='scVI潜在维度')
    parser.add_argument('--max-epochs', type=int, default=100, help='最大训练轮数')
    parser.add_argument('--n-pcs', type=int, default=50, help='PCA维度')
    
    args = parser.parse_args()
    
    ensure_dir(args.output)
    
    logger.info(f"📖 读取数据: {args.input}")
    adata = ad.read_h5ad(args.input)
    
    # 执行整合
    if args.method == 'scvi':
        adata = integrate_scvi(adata, args.batch_key, args.n_latent, args.max_epochs)
    elif args.method == 'harmony':
        adata = integrate_harmony(adata, args.batch_key, n_pcs=args.n_pcs)
    elif args.method == 'bbknn':
        adata = integrate_bbknn(adata, args.batch_key, args.n_pcs)
    elif args.method == 'scanvi':
        adata = integrate_scanvi(adata, args.batch_key, args.n_latent, args.max_epochs)
    elif args.method == 'combat':
        adata = integrate_combat(adata, args.batch_key)
    
    # 保存
    output_path = os.path.join(args.output, 'integrated.h5ad')
    adata.write_h5ad(output_path)
    logger.info(f"✅ 保存到: {output_path}")


if __name__ == '__main__':
    main()
