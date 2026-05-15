#!/usr/bin/env python3
"""
Step 08: 功能富集分析

【功能说明】
- GO富集分析（BP/MF/CC分开展示 + ALL合并）
- KEGG通路富集
- 支持按上调/下调基因分组分析
- 纯本地运行（调用R clusterProfiler）

【用法】
    python tools/08_enrichment.py \\
        --input markers.csv \\
        --output ./enrichment \\
        --species mouse \\
        --pval 0.05 \\
        --qval 0.25 \\
        --top-n 30

【输出】
    - GO_enrichment_ALL.csv     : GO合并结果
    - GO_enrichment_BP.csv      : BP结果
    - GO_enrichment_MF.csv      : MF结果
    - GO_enrichment_CC.csv      : CC结果
    - KEGG_enrichment.csv       : KEGG通路结果
    - *.png/pdf                 : 可视化图
"""

__author__ = "CatsCo"
__version__ = "3.2.0"

import scanpy as sc
import os
import sys
import subprocess
import argparse
import logging
from pathlib import Path

import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
import seaborn as sns

sys.path.insert(0, str(Path(__file__).parent.parent))
from utils.core_utils import ensure_dir, timing, logger

logging.basicConfig(level=logging.INFO, format='%(asctime)s | %(levelname)-8s | %(message)s', datefmt='%H:%M:%S')
logger = logging.getLogger(__name__)

# 物种配置
SPECIES_MAP = {
    'human': {'orgdb': 'org.Hs.eg.db', 'kegg_org': 'hsa'},
    'mouse': {'orgdb': 'org.Mm.eg.db', 'kegg_org': 'mmu'},
    'rat': {'orgdb': 'org.Rn.eg.db', 'kegg_org': 'rno'}
}

# ONTOLOGY配色
ONTOLOGY_COLORS = {
    'BP': '#E64B35',  # 红色
    'MF': '#4DBBD5',  # 蓝色
    'CC': '#00A087'   # 绿色
}


def get_r_script_path():
    """获取R富集脚本路径"""
    base_dir = Path(__file__).parent.parent.parent.parent
    # 尝试多个可能的位置
    possible_paths = [
        base_dir / "bio-skills" / "scripts" / "gmt_enrich.R",
        base_dir / "bio-skills" / "scripts" / "gmt_enrich.py",  # 原文件名
        base_dir / "scripts" / "gmt_enrich.R",
        base_dir / "scripts" / "gmt_enrich.py",
    ]
    
    for r_script in possible_paths:
        if r_script.exists():
            logger.info(f"  找到R脚本: {r_script}")
            return str(r_script)
    
    logger.warning(f"  未找到R脚本，尝试内嵌R代码")
    return None


@timing
def run_local_enrichment(genes: list,
                          species: str = 'mouse',
                          output_prefix: str = None,
                          pval: float = 0.05,
                          qval: float = 0.2) -> dict:
    """
    调用R脚本执行本地GO/KEGG富集分析
    
    Returns:
        dict: 包含GO_BP, GO_MF, GO_CC, GO_ALL, KEGG的DataFrame
    """
    results = {}
    
    # 写临时基因文件
    import tempfile
    with tempfile.NamedTemporaryFile(mode='w', suffix='.txt', delete=False) as f:
        for g in genes:
            f.write(f"{g}\n")
        gene_file = f.name
    
    try:
        # 构建R命令
        rscript = get_r_script_path()
        
        if rscript and os.path.exists(rscript):
            logger.info("  使用本地R脚本进行富集分析...")
            cmd = [
                'Rscript', rscript,
                gene_file,
                species,
                output_prefix
            ]
        else:
            # 动态构建R命令
            logger.info("  使用内嵌R代码进行富集分析...")
            r_code = _build_r_enrichment_code(genes, species, output_prefix, pval, qval)
            
            # 写临时R脚本
            with tempfile.NamedTemporaryFile(mode='w', suffix='.R', delete=False) as f:
                f.write(r_code)
                r_script_file = f.name
            
            cmd = ['Rscript', r_script_file]
        
        logger.info(f"  执行: {' '.join(cmd[:3])}...")
        
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=600  # 10分钟超时
        )
        
        if result.returncode != 0:
            logger.warning(f"  R脚本执行异常: {result.stderr[:500]}")
        else:
            logger.info(f"  R富集完成")
            if result.stdout:
                for line in result.stdout.strip().split('\n'):
                    if line.strip():
                        logger.info(f"    {line}")
        
        # 读取结果文件
        for ont in ['BP', 'MF', 'CC', 'ALL']:
            f = f"{output_prefix}_GO_{ont}.csv"
            if os.path.exists(f):
                try:
                    df = pd.read_csv(f)
                    results[f'GO_{ont}'] = df
                    logger.info(f"  读取GO_{ont}: {len(df)} 条记录")
                except:
                    pass
        
        kegg_file = f"{output_prefix}_KEGG.csv"
        if os.path.exists(kegg_file):
            try:
                df = pd.read_csv(kegg_file)
                results['KEGG'] = df
                logger.info(f"  读取KEGG: {len(df)} 条记录")
            except:
                pass
        
    except subprocess.TimeoutExpired:
        logger.error("  富集分析超时（10分钟）")
    except Exception as e:
        logger.error(f"  富集分析失败: {e}")
    finally:
        # 清理临时文件
        try:
            os.unlink(gene_file)
        except:
            pass
    
    return results


def _build_r_enrichment_code(genes: list, species: str, output_prefix: str, 
                               pval: float = 0.05, qval: float = 0.2) -> str:
    """构建R富集分析代码"""
    
    species_lower = species.lower()
    
    r_code = f'''
suppressPackageStartupMessages({{
  library(clusterProfiler)
  library(org.Hs.eg.db)
  library(org.Mm.eg.db)
  library(org.Rn.eg.db)
  library(ggplot2)
  library(enrichplot)
}})

# 基因列表
genes <- c({",".join([f'"{g}"' for g in genes])})
cat("分析", length(genes), "个基因\\n")

# 物种配置
species <- "{species_lower}"
if (species == "mouse") {{
  org_db <- org.Mm.eg.db
  kegg_org <- "mmu"
}} else if (species == "human") {{
  org_db <- org.Hs.eg.db
  kegg_org <- "hsa"
}} else {{
  org_db <- org.Rn.eg.db
  kegg_org <- "rno"
}}

output_prefix <- "{output_prefix}"

# GO富集分析
cat("\\n[1] GO富集分析...\\n")

for (ont in c("BP", "MF", "CC")) {{
  cat("  GO", ont, "...\\n")
  ego <- enrichGO(
    gene = genes,
    OrgDb = org_db,
    ont = ont,
    keyType = "SYMBOL",
    pvalueCutoff = {pval},
    qvalueCutoff = {qval},
    readable = FALSE
  )
  
  if (!is.null(ego) && nrow(ego) > 0) {{
    ego_df <- as.data.frame(ego)
    write.csv(ego_df, paste0(output_prefix, "_GO_", ont, ".csv"), row.names = FALSE)
    cat("    找到", nrow(ego_df), "个通路\\n")
  }}
}}

# 合并GO结果
cat("  合并GO结果...\\n")
go_files <- c()
for (ont in c("BP", "MF", "CC")) {{
  f <- paste0(output_prefix, "_GO_", ont, ".csv")
  if (file.exists(f)) {{
    df <- read.csv(f)
    df$Ontology <- ont
    go_files <- c(go_files, list(df))
  }}
}}

if (length(go_files) > 0) {{
  go_all <- do.call(rbind, go_files)
  write.csv(go_all, paste0(output_prefix, "_GO_ALL.csv"), row.names = FALSE)
  cat("  合并GO结果:", nrow(go_all), "个通路\\n")
}}

# KEGG富集分析
cat("\\n[2] KEGG通路富集...\\n")

gene_ids <- tryCatch({{
  bitr(
    genes,
    fromType = "SYMBOL",
    toType = "ENTREZID",
    OrgDb = org_db,
    drop = TRUE
  )
}}, error = function(e) {{
  NULL
}})

if (!is.null(gene_ids) && nrow(gene_ids) > 10) {{
  cat("  转换得到", nrow(gene_ids), "个Entrez ID\\n")
  
  ekegg <- enrichKEGG(
    gene = gene_ids$ENTREZID,
    organism = kegg_org,
    keyType = "kegg",
    pvalueCutoff = {pval},
    qvalueCutoff = {qval},
    use_internal_data = FALSE
  )
  
  if (!is.null(ekegg) && nrow(ekegg) > 0) {{
    ekegg_df <- as.data.frame(ekegg)
    write.csv(ekegg_df, paste0(output_prefix, "_KEGG.csv"), row.names = FALSE)
    cat("  KEGG找到", nrow(ekegg_df), "个通路\\n")
  }}
}}

cat("\\n富集分析完成!\\n")
'''
    return r_code


def plot_go_barplot(enrich_df: pd.DataFrame,
                    output_path: str,
                    title: str = "GO Enrichment",
                    top_n: int = 30,
                    color: str = None) -> None:
    """绘制GO柱状图"""
    if enrich_df.empty:
        logger.warning("  富集结果为空，跳过绘图")
        return
    
    logger.info(f"  绘制GO柱状图...")
    
    # 找p值列
    p_col = None
    for col in ['p.adjust', 'pvalue', 'pvalue_cutoff', 'qvalue']:
        if col in enrich_df.columns:
            p_col = col
            break
    
    if p_col is None:
        logger.warning("  无法找到p值列")
        return
    
    df = enrich_df.sort_values(p_col).head(top_n).copy()
    df['-log10(padj)'] = -np.log10(df[p_col].astype(float) + 1e-300)
    
    # 通路名称
    if 'Description' in df.columns:
        df['Term'] = df['Description'].apply(lambda x: str(x)[:60] if len(str(x)) > 60 else str(x))
    elif 'ID' in df.columns:
        df['Term'] = df['ID'].astype(str)
    else:
        df['Term'] = df.index.astype(str)
    
    if color is None:
        color = '#3B4992'
    
    fig, ax = plt.subplots(figsize=(12, min(14, len(df) * 0.4 + 2)))
    
    bars = ax.barh(range(len(df)), df['-log10(padj)'], color=color, edgecolor='none')
    
    if 'Count' in df.columns:
        for i, (bar, count) in enumerate(zip(bars, df['Count'])):
            ax.text(bar.get_width() + 0.1, bar.get_y() + bar.get_height()/2,
                   f'({int(count)})', va='center', fontsize=8, color='gray')
    
    ax.set_yticks(range(len(df)))
    ax.set_yticklabels(df['Term'].values, fontsize=9)
    ax.set_xlabel('-log10(adjusted P-value)', fontsize=11)
    ax.set_title(title, fontsize=12, fontweight='bold')
    ax.invert_yaxis()
    ax.spines['top'].set_visible(False)
    ax.spines['right'].set_visible(False)
    
    plt.tight_layout()
    plt.savefig(output_path, dpi=150, bbox_inches='tight')
    plt.savefig(output_path.replace('.png', '.pdf'), bbox_inches='tight')
    plt.close()
    
    logger.info(f"    保存: {output_path}")


def plot_go_dotplot(enrich_df: pd.DataFrame,
                    output_path: str,
                    title: str = "GO Enrichment",
                    top_n: int = 30) -> None:
    """绘制GO点图"""
    if enrich_df.empty:
        return
    
    logger.info("  绘制GO点图...")
    
    p_col = None
    for col in ['p.adjust', 'pvalue', 'qvalue']:
        if col in enrich_df.columns:
            p_col = col
            break
    
    if p_col is None:
        return
    
    df = enrich_df.sort_values(p_col).head(top_n).copy()
    df['-log10(padj)'] = -np.log10(df[p_col].astype(float) + 1e-300)
    
    if 'Description' in df.columns:
        df['Term'] = df['Description'].apply(lambda x: str(x)[:50] if len(str(x)) > 50 else str(x))
    elif 'ID' in df.columns:
        df['Term'] = df['ID'].astype(str)
    else:
        df['Term'] = df.index.astype(str)
    
    # 颜色
    if 'Ontology' in df.columns:
        df['color'] = df['Ontology'].map(ONTOLOGY_COLORS).fillna('#808080')
    else:
        df['color'] = '#3B4992'
    
    fig, ax = plt.subplots(figsize=(10, min(12, len(df) * 0.4 + 2)))
    
    for i, (_, row) in enumerate(df.iterrows()):
        count = row.get('Count', 20) if 'Count' in row.columns else 20
        ax.scatter(row['-log10(padj)'], i, 
                  s=count * 8,
                  c=row['color'], alpha=0.7, edgecolors='white', linewidths=0.5)
    
    ax.set_yticks(range(len(df)))
    ax.set_yticklabels(df['Term'].values, fontsize=8)
    ax.set_xlabel('-log10(adjusted P-value)', fontsize=10)
    ax.set_title(title, fontsize=11, fontweight='bold')
    ax.invert_yaxis()
    ax.spines['top'].set_visible(False)
    ax.spines['right'].set_visible(False)
    
    if 'Ontology' in df.columns:
        from matplotlib.patches import Patch
        legend_elements = [Patch(facecolor=ONTOLOGY_COLORS.get(o, 'gray'), label=o) 
                          for o in df['Ontology'].unique() if o in ONTOLOGY_COLORS]
        if legend_elements:
            ax.legend(handles=legend_elements, loc='lower right', title='ONTOLOGY')
    
    plt.tight_layout()
    plt.savefig(output_path, dpi=150, bbox_inches='tight')
    plt.savefig(output_path.replace('.png', '.pdf'), bbox_inches='tight')
    plt.close()
    
    logger.info(f"    保存: {output_path}")


def plot_go_facet_barplot(enrich_df: pd.DataFrame,
                          output_path: str,
                          title: str = "GO Enrichment",
                          top_n: int = 15) -> None:
    """绘制分面柱状图"""
    if enrich_df.empty or 'Ontology' not in enrich_df.columns:
        return
    
    logger.info("  绘制分面柱状图...")
    
    p_col = None
    for col in ['p.adjust', 'pvalue', 'qvalue']:
        if col in enrich_df.columns:
            p_col = col
            break
    
    if p_col is None:
        return
    
    df = enrich_df.sort_values(p_col).copy()
    df['-log10(padj)'] = -np.log10(df[p_col].astype(float) + 1e-300)
    
    if 'Description' in df.columns:
        df['Term'] = df['Description'].apply(lambda x: str(x)[:40] if len(str(x)) > 40 else str(x))
    
    # 每个ONTOLOGY取top N
    df_list = []
    for ont in ['BP', 'MF', 'CC']:
        if ont in df['Ontology'].values:
            ont_df = df[df['Ontology'] == ont].head(top_n).copy()
            if not ont_df.empty:
                df_list.append(ont_df)
    
    if not df_list:
        return
    
    df_plot = pd.concat(df_list, ignore_index=True)
    n_ont = len(df_plot['Ontology'].unique())
    
    fig, axes = plt.subplots(1, n_ont, figsize=(6 * n_ont, min(10, len(df_plot) * 0.5 + 2)))
    if n_ont == 1:
        axes = [axes]
    
    ont_names = {'BP': 'Biological Process', 'MF': 'Molecular Function', 'CC': 'Cellular Component'}
    
    for ax, (ont, group) in zip(axes, df_plot.groupby('Ontology')):
        group = group.sort_values('-log10(padj)')
        colors = [ONTOLOGY_COLORS.get(ont, '#808080')] * len(group)
        
        ax.barh(range(len(group)), group['-log10(padj)'], color=colors)
        ax.set_yticks(range(len(group)))
        ax.set_yticklabels(group['Term'].values, fontsize=8)
        ax.set_xlabel('-log10(padj)', fontsize=9)
        ax.set_title(f'{ont_names.get(ont, ont)} ({ont})', fontsize=10, fontweight='bold')
        ax.invert_yaxis()
        ax.spines['top'].set_visible(False)
        ax.spines['right'].set_visible(False)
    
    plt.suptitle(title, fontsize=12, fontweight='bold', y=1.02)
    plt.tight_layout()
    plt.savefig(output_path, dpi=150, bbox_inches='tight')
    plt.savefig(output_path.replace('.png', '.pdf'), bbox_inches='tight')
    plt.close()
    
    logger.info(f"    保存: {output_path}")


def plot_kegg_barplot(enrich_df: pd.DataFrame,
                      output_path: str,
                      title: str = "KEGG Enrichment",
                      top_n: int = 30) -> None:
    """绘制KEGG柱状图"""
    if enrich_df.empty:
        logger.warning("  KEGG结果为空，跳过绘图")
        return
    
    logger.info("  绘制KEGG柱状图...")
    
    p_col = None
    for col in ['p.adjust', 'pvalue', 'qvalue']:
        if col in enrich_df.columns:
            p_col = col
            break
    
    if p_col is None:
        return
    
    df = enrich_df.sort_values(p_col).head(top_n).copy()
    df['-log10(padj)'] = -np.log10(df[p_col].astype(float) + 1e-300)
    
    if 'Description' in df.columns:
        df['Term'] = df['Description'].apply(lambda x: str(x)[:50] if len(str(x)) > 50 else str(x))
    elif 'ID' in df.columns:
        df['Term'] = df['ID'].astype(str)
    else:
        df['Term'] = df.index.astype(str)
    
    fig, ax = plt.subplots(figsize=(12, min(14, len(df) * 0.4 + 2)))
    
    color = '#0072B5'  # KEGG蓝色
    
    bars = ax.barh(range(len(df)), df['-log10(padj)'], color=color, edgecolor='none')
    
    if 'Count' in df.columns:
        for i, (bar, count) in enumerate(zip(bars, df['Count'])):
            ax.text(bar.get_width() + 0.1, bar.get_y() + bar.get_height()/2,
                   f'({int(count)})', va='center', fontsize=8, color='gray')
    
    ax.set_yticks(range(len(df)))
    ax.set_yticklabels(df['Term'].values, fontsize=9)
    ax.set_xlabel('-log10(adjusted P-value)', fontsize=11)
    ax.set_title(title, fontsize=12, fontweight='bold')
    ax.invert_yaxis()
    ax.spines['top'].set_visible(False)
    ax.spines['right'].set_visible(False)
    
    plt.tight_layout()
    plt.savefig(output_path, dpi=150, bbox_inches='tight')
    plt.savefig(output_path.replace('.png', '.pdf'), bbox_inches='tight')
    plt.close()
    
    logger.info(f"    保存: {output_path}")


def main():
    parser = argparse.ArgumentParser(description='Enrichment Analysis (Local)')
    
    parser.add_argument('--input', '-i', required=True, help='输入基因列表CSV或h5ad')
    parser.add_argument('--output', '-o', required=True, help='输出目录')
    parser.add_argument('--species', '-s', default='mouse', choices=['human', 'mouse', 'rat'])
    parser.add_argument('--pval', type=float, default=0.05, help='P值阈值')
    parser.add_argument('--qval', type=float, default=0.2, help='Q值阈值')
    parser.add_argument('--top-n', type=int, default=30, help='显示top N')
    parser.add_argument('--group', default=None, help='分组列名（如avg_log2FC）')
    parser.add_argument('--foldchange', type=float, default=0, help='差异基因筛选foldchange阈值')
    
    args = parser.parse_args()
    
    ensure_dir(args.output)
    
    # 创建子目录
    enrich_dir = os.path.join(args.output, 'GO')
    kegg_dir = os.path.join(args.output, 'KEGG')
    ensure_dir(enrich_dir)
    ensure_dir(kegg_dir)
    
    # 读取基因列表
    if args.input.endswith('.csv'):
        df = pd.read_csv(args.input)
        if 'gene' in df.columns:
            genes = df['gene'].dropna().unique().tolist()
        elif 'genes' in df.columns:
            genes = df['genes'].dropna().unique().tolist()
        else:
            genes = df.iloc[:, 0].dropna().unique().tolist()
        
        # 限制基因数量
        if len(genes) > 2000:
            logger.info(f"  基因数量({len(genes)})过多，限制为2000个")
            if 'pvalue' in df.columns or 'pval' in df.columns:
                pcol = 'pvalue' if 'pvalue' in df.columns else 'pval'
                if 'gene' in df.columns:
                    genes = df.dropna(subset=[pcol]).sort_values(pcol).head(2000)['gene'].tolist()
                else:
                    genes = df.dropna(subset=[pcol]).sort_values(pcol).head(2000).iloc[:, 0].tolist()
            else:
                genes = genes[:2000]
    elif args.input.endswith('.h5ad'):
        adata = sc.read_h5ad(args.input)
        if 'rank_genes_groups' in adata.uns:
            result = adata.uns['rank_genes_groups']
            genes = []
            for group in result['names'].dtype.names:
                genes.extend([str(g) for g in result['names'][group]])
            genes = list(set(genes))
        else:
            genes = []
    else:
        with open(args.input, 'r') as f:
            genes = [line.strip() for line in f if line.strip()]
    
    logger.info(f"📊 分析 {len(genes)} 个基因")
    
    if not genes:
        logger.error("  没有找到基因")
        return
    
    # ========== 1. 全局富集 ==========
    logger.info("\n" + "="*50)
    logger.info("【1】富集分析 (ALL)")
    
    prefix = os.path.join(args.output, 'enrichment_all')
    results = run_local_enrichment(
        genes=genes,
        species=args.species,
        output_prefix=prefix,
        pval=args.pval,
        qval=args.qval
    )
    
    # 保存并绘图
    if 'GO_ALL' in results:
        results['GO_ALL'].to_csv(os.path.join(enrich_dir, 'GO_enrichment_ALL.csv'), index=False)
        plot_go_barplot(results['GO_ALL'], os.path.join(enrich_dir, 'GO_ALL_barplot.png'),
                       "GO Enrichment (ALL)", args.top_n)
        plot_go_dotplot(results['GO_ALL'], os.path.join(enrich_dir, 'GO_ALL_dotplot.png'),
                       "GO Enrichment (ALL)", args.top_n)
        if 'Ontology' in results['GO_ALL'].columns:
            plot_go_facet_barplot(results['GO_ALL'], os.path.join(enrich_dir, 'GO_ALL_facet_barplot.png'),
                                 "GO Enrichment", args.top_n)
    
    for ont in ['BP', 'MF', 'CC']:
        if f'GO_{ont}' in results:
            results[f'GO_{ont}'].to_csv(os.path.join(enrich_dir, f'GO_enrichment_{ont}.csv'), index=False)
            plot_go_barplot(results[f'GO_{ont}'], os.path.join(enrich_dir, f'GO_{ont}_barplot.png'),
                           f"GO {ont}", args.top_n, color=ONTOLOGY_COLORS.get(ont, '#808080'))
    
    if 'KEGG' in results:
        results['KEGG'].to_csv(os.path.join(kegg_dir, 'KEGG_enrichment.csv'), index=False)
        plot_kegg_barplot(results['KEGG'], os.path.join(kegg_dir, 'KEGG_barplot.png'),
                          "KEGG Pathway Enrichment", args.top_n)
    
    # ========== 2. UP/DOWN分组分析 ==========
    if args.group is not None and args.input.endswith('.csv'):
        df_full = pd.read_csv(args.input)
        
        if 'avg_log2FC' in df_full.columns or 'log2FoldChange' in df_full.columns:
            fc_col = 'avg_log2FC' if 'avg_log2FC' in df_full.columns else 'log2FoldChange'
            gene_col = 'gene' if 'gene' in df_full.columns else 'genes'
            
            up_genes = df_full[df_full[fc_col] > args.foldchange][gene_col].dropna().unique().tolist()
            down_genes = df_full[df_full[fc_col] < -args.foldchange][gene_col].dropna().unique().tolist()
            
            logger.info(f"\n{'='*50}")
            logger.info(f"【2】分组分析")
            logger.info(f"  上调基因: {len(up_genes)}")
            logger.info(f"  下调基因: {len(down_genes)}")
            
            # 上调基因
            if up_genes:
                up_dir = os.path.join(args.output, 'UP')
                ensure_dir(up_dir)
                prefix_up = os.path.join(up_dir, 'enrichment_up')
                
                results_up = run_local_enrichment(up_genes, args.species, prefix_up, args.pval, args.qval)
                
                if 'GO_ALL' in results_up:
                    results_up['GO_ALL'].to_csv(os.path.join(up_dir, 'GO_UP_ALL.csv'), index=False)
                    if 'Ontology' in results_up['GO_ALL'].columns:
                        plot_go_facet_barplot(results_up['GO_ALL'], os.path.join(up_dir, 'GO_UP_facet.png'),
                                            "GO Enrichment (UP)", args.top_n)
                
                if 'KEGG' in results_up:
                    results_up['KEGG'].to_csv(os.path.join(up_dir, 'KEGG_UP.csv'), index=False)
            
            # 下调基因
            if down_genes:
                down_dir = os.path.join(args.output, 'DOWN')
                ensure_dir(down_dir)
                prefix_down = os.path.join(down_dir, 'enrichment_down')
                
                results_down = run_local_enrichment(down_genes, args.species, prefix_down, args.pval, args.qval)
                
                if 'GO_ALL' in results_down:
                    results_down['GO_ALL'].to_csv(os.path.join(down_dir, 'GO_DOWN_ALL.csv'), index=False)
                    if 'Ontology' in results_down['GO_ALL'].columns:
                        plot_go_facet_barplot(results_down['GO_ALL'], os.path.join(down_dir, 'GO_DOWN_facet.png'),
                                            "GO Enrichment (DOWN)", args.top_n)
                
                if 'KEGG' in results_down:
                    results_down['KEGG'].to_csv(os.path.join(down_dir, 'KEGG_DOWN.csv'), index=False)
    
    logger.info(f"\n{'='*50}")
    logger.info(f"✅ 富集分析完成！")
    logger.info(f"   输出目录: {args.output}")


if __name__ == '__main__':
    main()
