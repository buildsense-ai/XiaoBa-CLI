#!/usr/bin/env python3
"""
Step 05: 细胞类型注释

【功能说明】
- SingleR自动化注释（基于参考数据集）
- Marker基因注释（内置30+种常见细胞类型Marker库）
- 支持人工覆盖注释结果
- 多种参考数据集：HPCA、Blueprint、MouseRNAseq等

【用法】
    python tools/05_annotation.py \\
        --input clustered.h5ad \\
        --output ./annotation \\
        --species mouse \\
        --cluster-key leiden \\
        --method all

【参数说明】
    --input       : 输入h5ad文件
    --output      : 输出目录
    --species     : 物种 (human/mouse/rat)
    --cluster-key : 聚类列名，默认leiden
    --method      : 注释方法 (all/singler/marker/manual)
    --annotations : 人工注释，格式: cluster0:Type1,cluster1:Type2

【内置Marker库】
    Human: T细胞、CD4+ T、CD8+ T、NK、B细胞、浆细胞、单核、巨噬、DC、pDC、...
    Mouse: Cd3d、Cd4、Il7r、Cd8a、Nkg7、Cd79a、Adgre1、S100a8、...

【输出】
    - annotated.h5ad   : 注释后的AnnData对象
    - celltype_final_umap.png : 细胞类型UMAP图
    - celltype_annotation.csv  : 注释结果表
    - celltype_distribution.png # 细胞类型分布图

【示例】
    # 自动注释
    python tools/05_annotation.py -i cluster/clustered.h5ad -o annot/ --species mouse
    
    # 只用Marker
    python tools/05_annotation.py -i cluster/clustered.h5ad -o annot/ --method marker
    
    # 人工注释
    python tools/05_annotation.py -i cluster/clustered.h5ad -o annot/ \\
        --method manual --annotations "0:T_cell,1:B_cell,2:Macrophage"
"""

__author__ = "CatsCo"
__version__ = "3.0.0"
import os
import sys
import argparse
import logging
from pathlib import Path
from typing import Dict, List, Optional

import numpy as np
import pandas as pd
import anndata as ad
import scanpy as sc
import matplotlib.pyplot as plt

sys.path.insert(0, str(Path(__file__).parent.parent))
from utils.core_utils import ensure_dir, timing, logger

logging.basicConfig(level=logging.INFO, format='%(asctime)s | %(levelname)-8s | %(message)s', datefmt='%H:%M:%S')
logger = logging.getLogger(__name__)


# 常用细胞类型Marker基因库
CELL_MARKER_DICT = {
    'human': {
        'T cell': ['CD3D', 'CD3E', 'CD3G', 'CD2'],
        'CD4+ T cell': ['CD4', 'IL7R', 'LTB', 'TCF7'],
        'CD8+ T cell': ['CD8A', 'CD8B', 'GZMK', 'GZMB'],
        'NK cell': ['NKG7', 'GNLY', 'KLRD1', 'KLRB1'],
        'B cell': ['CD79A', 'CD79B', 'MS4A1', 'CD19'],
        'Plasma cell': ['IGHA1', 'IGHA2', 'JCHAIN', 'MZB1'],
        'Monocyte': ['CD14', 'LYZ', 'S100A8', 'S100A9'],
        'Macrophage': ['CD68', 'CSF1R', 'MARCO', 'APOC1'],
        'DC': ['FCER1A', 'CST3', 'CD1C', 'IRF8'],
        'pDC': ['IRF8', 'IRF4', 'TCF4', 'LILRA4'],
        'Neutrophil': ['S100A8', 'S100A9', 'CXCL8', 'FCGR3B'],
        'Mast cell': ['TPSAB1', 'TPSB2', 'KIT', 'HDC'],
        'Megakaryocyte': ['PPBP', 'PF4', 'GP9', 'ITGA2B'],
        'Erythrocyte': ['HBA1', 'HBA2', 'HBB', 'HBD'],
        'Fibroblast': ['COL1A1', 'COL1A2', 'COL3A1', 'FAP'],
        'Endothelial': ['PECAM1', 'CDH5', 'VWF', 'CLDN5'],
        'Smooth muscle': ['ACTA2', 'MYH11', 'TAGLN', 'CNN1'],
        'Epithelial': ['EPCAM', 'KRT18', 'KRT19', 'KRT8'],
        'Hepatocyte': ['ALB', 'APOE', 'HP', 'TTR'],
        'Cholangiocyte': ['KRT7', 'KRT19', 'EPCAM', 'SOX9'],
        ' Stellate cell': ['DCN', 'LUM', 'COL1A1', 'PDGFRB'],
        'Schwann cell': ['SOX10', 'MPZ', 'MBP', 'PLP1'],
        'Astrocyte': ['GFAP', 'SLC1A3', 'AQP4', 'ALDH1L1'],
        'Neuron': ['RBFOX3', 'SNAP25', 'SYN1', 'MAP2'],
        'Oligodendrocyte': ['MBP', 'MOG', 'PLP1', 'OLIG2'],
        'Microglia': ['CX3CR1', 'P2RY12', 'TMSB4X', 'CSF1R'],
        'Osteoblast': ['RUNX2', 'ALPL', 'BGLAP', 'SPP1'],
        'Adipocyte': ['LEP', 'ADIPOQ', 'FABP4', 'LPL'],
        'Myoblast': ['MYOD1', 'MYOG', 'DES', 'ACTA1'],
        'Cardiomyocyte': ['TNNT2', 'MYH6', 'MYH7', 'ACTA1'],
        'AT2': ['SFTPC', 'SFTPA1', 'SFTPD', 'ABCA3'],
        'Club': ['SCGB1A1', 'SCGB3A2', 'MUC5B', 'MUC5AC'],
        'Goblet': ['MUC5AC', 'MUC5B', 'TFF3', 'SPDEF'],
        'Basal': ['KRT5', 'KRT14', 'TP63', 'COL14A1'],
    },
    'mouse': {
        'T cell': ['Cd3d', 'Cd3e', 'Cd3g', 'Cd2'],
        'CD4+ T cell': ['Cd4', 'Il7r', 'Ltbr', 'Tcf7'],
        'CD8+ T cell': ['Cd8a', 'Cd8b1', 'Gzmk', 'Gzmb'],
        'NK cell': ['Nkg7', 'Gnly', 'Klrd1', 'Klrb1'],
        'B cell': ['Cd79a', 'Cd79b', 'Ms4a1', 'Cd19'],
        'Plasma cell': ['Ighg1', 'Ighg2b', 'Jchain', 'Mzb1'],
        'Monocyte': ['Cd14', 'Lyz2', 'S100a8', 'S100a9'],
        'Macrophage': ['Adgre1', 'Csf1r', 'Marco', 'Apoc1'],
        'DC': ['Fcer1a', 'Cst3', 'Cd1c', 'Irf8'],
        'pDC': ['Irf8', 'Irf4', 'Tcf4', 'Lilra4'],
        'Neutrophil': ['S100a8', 'S100a9', 'Cxcl2', 'Fcgr3'],
        'Mast cell': ['Mcpt4', 'Mcpt1', 'Kit', 'Hdc'],
        'Megakaryocyte': ['Ppbp', 'Pf4', 'Gp9', 'Itga2b'],
        'Erythrocyte': ['Hba-a1', 'Hba-a2', 'Hbb-bs', 'Hbb-bt'],
        'Fibroblast': ['Col1a1', 'Col1a2', 'Col3a1', 'Fap'],
        'Endothelial': ['Pecam1', 'Cdh5', 'Vwf', 'Cldn5'],
        'Smooth muscle': ['Acta2', 'Myh11', 'Tagln', 'Cnn1'],
        'Epithelial': ['Epcam', 'Krt18', 'Krt19', 'Krt8'],
        'Hepatocyte': ['Alb', 'Apoe', 'Hp', 'Ttr'],
        'Astrocyte': ['Gfap', 'Slc1a3', 'Aqp4', 'Aldh1l1'],
        'Neuron': ['Rbfox3', 'Snap25', 'Syn1', 'Map2'],
        'Oligodendrocyte': ['Mbp', 'Mog', 'Plp1', 'Olig2'],
        'Microglia': ['Cx3cr1', 'P2ry12', 'Tmsb4x', 'Csf1r'],
        'Macrophage M1': ['Nos2', 'Cd86', 'Il1b', 'Tnf'],
        'Macrophage M2': ['Arg1', 'Retnla', 'Cd163', 'Mrc1'],
        'iNKT': ['Nkg7', 'Klre1', 'Klra7', 'Klrd1'],
        'Treg': ['Foxp3', 'Il2ra', 'Ctla4', 'Tnfrsf18'],
        'Memory T': ['Il7r', 'Cd44', 'Cd27', 'Tcf7'],
        'Naive T': ['Sell', 'Lef1', 'Tcf7', 'Ccr7'],
    },
    'rat': {
        'T cell': ['Cd3d', 'Cd3e', 'Cd3g'],
        'B cell': ['Cd79a', 'Cd79b', 'Ms4a1'],
        'NK cell': ['Nkg7', 'Klrd1'],
        'Monocyte': ['Cd14', 'Lyz2', 'S100a8'],
        'Macrophage': ['Adgre1', 'Csf1r'],
        'Neutrophil': ['S100a8', 'S100a9'],
        'Fibroblast': ['Col1a1', 'Col1a2', 'Col3a1'],
        'Endothelial': ['Pecam1', 'Cdh5', 'Vwf'],
        'Neuron': ['Rbfox3', 'Snap25'],
    }
}


@timing
def annotate_singler(adata: ad.AnnData,
                    species: str = 'mouse',
                    cluster_key: str = None) -> ad.AnnData:
    """
    SingleR自动化注释
    
    SingleR使用参考数据集自动注释细胞类型
    """
    # 自动检测cluster列
    if cluster_key is None:
        leiden_cols = [c for c in adata.obs.columns if c.startswith('leiden_')]
        if leiden_cols:
            cluster_key = leiden_cols[0]
            logger.info(f"🔍 自动使用聚类列: {cluster_key}")
    
    logger.info(f"🤖 SingleR 自动注释 ({species})...")
    
    try:
        import singler
    except ImportError:
        logger.error("❌ SingleR未安装！运行: pip install singleR")
        raise
    
    # 加载参考数据
    logger.info("  加载参考数据集...")
    
    if species == 'human':
        ref = singler.HumanPrimaryCellAtlasData()
    elif species == 'mouse':
        ref = singler.MouseRNAseqData()
    elif species == 'rat':
        ref = singler.RatRNAseqData()
    else:
        raise ValueError(f"不支持的物种: {species}")
    
    # 获取cluster平均表达
    logger.info("  计算cluster平均表达...")
    adata_raw = adata.raw.to_adata()
    sc.pp.normalize_total(adata_raw, target_sum=1e4)
    sc.pp.log1p(adata_raw)
    
    # 按cluster计算平均
    cluster_means = pd.DataFrame(index=adata_raw.var_names)
    for cluster in adata.obs[cluster_key].unique():
        cells = adata.obs[cluster_key] == cluster
        cluster_means[cluster] = adata_raw[cells].X.mean(axis=0).A1 if hasattr(adata_raw[cells].X, 'toarray') else adata_raw[cells].X.mean(axis=0)
    cluster_means = cluster_means.T
    
    # SingleR注释
    logger.info("  SingleR预测...")
    pred = singler.predict(cluster_means, ref)
    
    # 映射到细胞
    cluster_to_type = dict(zip(cluster_means.index, pred))
    adata.obs['cell_type_singler'] = adata.obs[cluster_key].map(cluster_to_type)
    
    # 统计
    type_counts = adata.obs['cell_type_singler'].value_counts()
    logger.info(f"  SingleR识别到 {len(type_counts)} 种细胞类型")
    
    return adata


@timing
def annotate_by_markers(adata: ad.AnnData,
                        species: str = 'mouse',
                        cluster_key: str = None,
                        markers: Dict[str, List[str]] = None,
                        score_threshold: float = 0.1) -> ad.AnnData:
    """
    基于Marker基因注释
    
    计算每个cluster对各细胞类型的Marker基因表达得分，
    得分最高者为该cluster的细胞类型
    """
    # 自动检测cluster列
    if cluster_key is None:
        leiden_cols = [c for c in adata.obs.columns if c.startswith('leiden_')]
        if leiden_cols:
            cluster_key = leiden_cols[0]
            logger.info(f"🔍 自动使用聚类列: {cluster_key}")
        else:
            raise ValueError("未找到聚类列！请先运行聚类步骤。")
    
    logger.info("🎯 Marker基因注释...")
    
    if markers is None:
        markers = CELL_MARKER_DICT.get(species.lower(), CELL_MARKER_DICT['mouse'])
    
    # 获取raw数据
    adata_raw = adata.raw.to_adata()
    sc.pp.normalize_total(adata_raw, target_sum=1e4)
    sc.pp.log1p(adata_raw)
    
    # 计算每个cluster的Marker得分
    cluster_scores = {}
    
    for cluster in adata.obs[cluster_key].unique():
        cluster_cells = adata.obs[cluster_key] == cluster
        cluster_data = adata_raw[cluster_cells]
        
        scores = {}
        for cell_type, gene_list in markers.items():
            # 过滤存在的基因
            valid_genes = [g for g in gene_list if g in adata_raw.var_names]
            
            if valid_genes:
                # 平均表达
                mean_exp = cluster_data[:, valid_genes].X.mean(axis=1).A1 if hasattr(cluster_data.X, 'toarray') else cluster_data[:, valid_genes].X.mean(axis=1)
                scores[cell_type] = np.mean(mean_exp)
            else:
                scores[cell_type] = 0
        
        cluster_scores[cluster] = scores
    
    # 为每个cluster分配细胞类型
    cell_type_assign = {}
    for cluster, scores in cluster_scores.items():
        # 找最高分
        best_type = max(scores, key=scores.get)
        best_score = scores[best_type]
        
        # 如果最高分低于阈值，标记为Unknown
        if best_score < score_threshold:
            cell_type_assign[cluster] = f"{best_type}?"
        else:
            cell_type_assign[cluster] = best_type
    
    # 映射到adata
    adata.obs['cell_type_marker'] = adata.obs[cluster_key].map(cell_type_assign)
    
    # 输出分配结果
    logger.info("  Marker注释结果:")
    for cluster, cell_type in sorted(cell_type_assign.items()):
        logger.info(f"    Cluster {cluster}: {cell_type}")
    
    return adata


@timing
def manual_annotation(adata: ad.AnnData,
                    cluster_key: str = 'leiden',
                    annotations: Dict[str, str] = None) -> ad.AnnData:
    """
    人工注释接口
    
    用户可以手动指定cluster的细胞类型
    """
    if annotations is None:
        logger.info("📝 人工注释: 未提供annotations参数")
        return adata
    
    logger.info("📝 应用人工注释...")
    
    adata.obs['cell_type'] = adata.obs[cluster_key].map(annotations)
    
    # 统计
    annotated = adata.obs['cell_type'].notna().sum()
    total = len(adata.obs)
    logger.info(f"  已注释: {annotated}/{total} cells ({annotated/total*100:.1f}%)")
    
    return adata


@timing
def annotate_azimuth(adata: ad.AnnData,
                    ref_level: str = 'mouse/mouse spleen') -> ad.AnnData:
    """
    Azimuth参考映射注释
    
    使用Azimuth进行参考映射注释
    """
    logger.info(f"🎯 Azimuth 参考映射注释...")
    
    try:
        import azimuth
        from azimuth.models.v2 import prediction
    except ImportError:
        logger.warning("⚠️ Azimuth未安装，跳过")
        return adata
    
    logger.info(f"  参考: {ref_level}")
    # Azimuth实现代码...
    
    return adata


@timing
def plot_annotation_results(adata: ad.AnnData,
                           output_dir: str,
                           cluster_key: str = 'leiden') -> None:
    """绘制注释结果"""
    ensure_dir(output_dir)
    
    logger.info("📊 绘制注释结果...")
    
    # 颜色
    n_types = adata.obs['cell_type'].nunique() if 'cell_type' in adata.obs else 10
    import seaborn as sns
    palette = sns.color_palette('tab20', n_types) if n_types <= 20 else sns.color_palette('husl', n_types)
    
    # UMAP - SingleR注释
    if 'cell_type_singler' in adata.obs:
        fig = sc.pl.umap(adata, color='cell_type_singler',
                        title='SingleR Cell Type',
                        palette=palette,
                        frameon=False, show=False, return_fig=True)
        fig.savefig(os.path.join(output_dir, 'celltype_singler_umap.png'), dpi=200, bbox_inches='tight')
        plt.close()
    
    # UMAP - Marker注释
    if 'cell_type_marker' in adata.obs:
        fig = sc.pl.umap(adata, color='cell_type_marker',
                        title='Marker-based Cell Type',
                        palette=palette,
                        frameon=False, show=False, return_fig=True)
        fig.savefig(os.path.join(output_dir, 'celltype_marker_umap.png'), dpi=200, bbox_inches='tight')
        plt.close()
    
    # UMAP - 最终注释
    if 'cell_type' in adata.obs:
        fig = sc.pl.umap(adata, color='cell_type',
                        title='Final Cell Type Annotation',
                        palette=palette,
                        frameon=False, show=False, return_fig=True)
        fig.savefig(os.path.join(output_dir, 'celltype_final_umap.png'), dpi=200, bbox_inches='tight')
        plt.close()
    
    # 细胞类型分布
    fig, axes = plt.subplots(1, 2, figsize=(14, 5))
    
    if 'cell_type' in adata.obs:
        type_counts = adata.obs['cell_type'].value_counts()
        type_counts.plot(kind='bar', ax=axes[0], color=palette[:len(type_counts)])
        axes[0].set_title('Cell Type Distribution')
        axes[0].tick_params(axis='x', rotation=45)
        
        # 饼图
        axes[1].pie(type_counts, labels=type_counts.index, autopct='%1.1f%%',
                    colors=palette[:len(type_counts)], startangle=90)
        axes[1].set_title('Cell Type Proportions')
    
    plt.tight_layout()
    plt.savefig(os.path.join(output_dir, 'celltype_distribution.png'), dpi=150, bbox_inches='tight')
    plt.close()
    
    logger.info(f"  图表保存到: {output_dir}")


def main():
    parser = argparse.ArgumentParser(description='Cell Type Annotation')
    
    parser.add_argument('--input', '-i', required=True, help='输入h5ad文件')
    parser.add_argument('--output', '-o', required=True, help='输出目录')
    parser.add_argument('--species', '-s', default='mouse', choices=['human', 'mouse', 'rat'])
    parser.add_argument('--cluster-key', default=None, help='聚类列(默认自动检测)')
    parser.add_argument('--method', '-m', default='all',
                       choices=['all', 'singler', 'marker', 'manual'],
                       help='注释方法')
    parser.add_argument('--annotations', default=None, help='人工注释JSON，格式: cluster0:Type1,cluster1:Type2')
    
    args = parser.parse_args()
    
    ensure_dir(args.output)
    
    logger.info(f"📖 读取数据: {args.input}")
    adata = ad.read_h5ad(args.input)
    
    # 执行注释
    if args.method in ['all', 'singler']:
        adata = annotate_singler(adata, args.species, args.cluster_key)
    
    if args.method in ['all', 'marker']:
        adata = annotate_by_markers(adata, args.species, args.cluster_key)
    
    if args.method == 'manual' and args.annotations:
        annotations = dict(x.split(':') for x in args.annotations.split(','))
        adata = manual_annotation(adata, args.cluster_key, annotations)
    
    # 使用最终注释（优先使用人工注释，然后是Marker，然后是SingleR）
    if 'cell_type' not in adata.obs:
        adata.obs['cell_type'] = adata.obs.get('cell_type_marker',
                                                adata.obs.get('cell_type_singler', 'Unknown'))
    
    # 绘图
    plot_annotation_results(adata, args.output, args.cluster_key)
    
    # 保存
    output_path = os.path.join(args.output, 'annotated.h5ad')
    adata.write_h5ad(output_path)
    
    # 保存注释结果表 - 只保存存在的列
    cols_to_save = ['cell_type_marker', 'cell_type']
    available_cols = [c for c in cols_to_save if c in adata.obs.columns]
    if available_cols:
        annotation_df = adata.obs[available_cols].copy()
        annotation_df.to_csv(os.path.join(args.output, 'celltype_annotation.csv'))
    
    logger.info(f"✅ 注释完成！保存到: {output_path}")


if __name__ == '__main__':
    main()
