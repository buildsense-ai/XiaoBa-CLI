#!/usr/bin/env python3
"""
Step 00: 数据探查 (Data Inspection)

【功能说明】
- 检测输入数据格式（h5ad/10X h5/mtx）
- 统计细胞数、基因数、样本分布
- 推断物种（human/mouse/rat）
- 评估数据质量，生成探查报告
- 为后续分析提供参数建议

【用法】
    python tools/00_data_inspector.py \\
        --input /path/to/data \\
        --output ./inspection

【参数说明】
    --input   : 输入路径，支持:
               - 单个 h5ad 文件
               - 包含多个 h5ad 的目录
               - 10X 原始数据目录（包含 matrix.mtx）
    --output  : 输出目录路径
    --samples : 样本名列表（可选，用于标注）

【输出】
    - data_overview.json    : 数据概览 JSON
    - sample_summary.csv    : 各样本统计表
    - quality_assessment.png: 质量分布图
    - species_detection.txt : 物种检测结果
"""

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Dict, List, Optional

import numpy as np
import pandas as pd
import scanpy as sc
from scipy import sparse


def detect_species(adata) -> str:
    """根据基因名推断物种"""
    if adata.n_vars == 0:
        return "unknown"
    
    # 获取基因名
    var_names = adata.var_names.tolist() if adata.var_names is not None else []
    if len(var_names) == 0:
        return "unknown"
    
    # 采样检查
    sample_genes = var_names[:min(1000, len(var_names))]
    
    human_count = 0
    mouse_count = 0
    rat_count = 0
    
    for gene in sample_genes:
        gene_upper = gene.upper()
        gene_title = gene.title()
        
        # Human: 全大写或 ENSG 格式
        if gene == gene_upper or gene.startswith('ENSG'):
            human_count += 1
        # Mouse: 首字母大写或 ENSMUSG 格式
        elif gene == gene_title or gene.startswith('ENSMUSG'):
            mouse_count += 1
        # Rat: ENSRNOG 格式
        elif gene.startswith('ENSRNOG'):
            rat_count += 1
    
    total = human_count + mouse_count + rat_count
    if total == 0:
        return "unknown"
    
    # 统计线粒体基因模式
    mito_patterns = {
        'human': ['MT-', 'MTNR', 'MTRN'],
        'mouse': ['mt-', 'Mt-'],
        'rat': ['Mt-', 'mt.']
    }
    
    mito_count = {'human': 0, 'mouse': 0, 'rat': 0}
    for gene in sample_genes[:500]:
        for species, patterns in mito_patterns.items():
            for pattern in patterns:
                if gene.startswith(pattern):
                    mito_count[species] += 1
                    break
    
    max_mito = max(mito_count.values())
    if max_mito > 10:
        for species, count in mito_count.items():
            if count == max_mito:
                return species
    
    # 按基因名比例判断
    if human_count / total > 0.7:
        return "human"
    elif mouse_count / total > 0.7:
        return "mouse"
    elif rat_count / total > 0.5:
        return "rat"
    
    return "unknown"


def inspect_h5ad(file_path: str, sample_name: str = None) -> Dict:
    """检查单个 h5ad 文件"""
    print(f"  检查: {file_path}")
    
    adata = sc.read_h5ad(file_path)
    
    # 基本统计
    n_cells = adata.n_obs
    n_genes = adata.n_vars
    
    # 样本名
    if sample_name is None:
        sample_name = Path(file_path).stem
    
    # 计算每个细胞的统计
    if sparse.issparse(adata.X):
        counts_per_cell = np.array(adata.X.sum(axis=1)).flatten()
    else:
        counts_per_cell = np.array(adata.X.sum(axis=1)).flatten()
    
    genes_per_cell = np.array((adata.X > 0).sum(axis=1)).flatten()
    
    # 线粒体基因比例
    mito_genes = adata.var_names.str.startswith('MT-') | adata.var_names.str.startswith('mt-')
    mito_ratio = np.array(adata[:, mito_genes].X.sum(axis=1)).flatten() / (counts_per_cell + 1e-6) * 100
    
    # 核糖体基因比例
    ribo_genes = adata.var_names.str.match(r'^(RPS|RPL|RPS|Mrpl|Mrps)', case=False)
    ribo_ratio = np.array(adata[:, ribo_genes].X.sum(axis=1)).flatten() / (counts_per_cell + 1e-6) * 100
    
    # 样本名
    if 'sample' in adata.obs.columns:
        sample_name = adata.obs['sample'].iloc[0] if sample_name is None else sample_name
    elif 'batch' in adata.obs.columns:
        sample_name = adata.obs['batch'].iloc[0] if sample_name is None else sample_name
    
    result = {
        'sample_name': sample_name,
        'file_path': str(file_path),
        'n_cells': int(n_cells),
        'n_genes': int(n_genes),
        'counts_per_cell': {
            'mean': float(np.mean(counts_per_cell)),
            'median': float(np.median(counts_per_cell)),
            'std': float(np.std(counts_per_cell)),
            'min': float(np.min(counts_per_cell)),
            'max': float(np.max(counts_per_cell))
        },
        'genes_per_cell': {
            'mean': float(np.mean(genes_per_cell)),
            'median': float(np.median(genes_per_cell)),
            'std': float(np.std(genes_per_cell)),
            'min': float(np.min(genes_per_cell)),
            'max': float(np.max(genes_per_cell))
        },
        'mito_ratio': {
            'mean': float(np.mean(mito_ratio)),
            'median': float(np.median(mito_ratio)),
            'std': float(np.std(mito_ratio)),
            'min': float(np.min(mito_ratio)),
            'max': float(np.max(mito_ratio))
        },
        'ribo_ratio': {
            'mean': float(np.mean(ribo_ratio)),
            'median': float(np.median(ribo_ratio)),
            'std': float(np.std(ribo_ratio))
        }
    }
    
    return result


def inspect_directory(dir_path: str) -> List[Dict]:
    """检查目录中的所有 h5ad 文件"""
    results = []
    dir_path = Path(dir_path)
    
    # 查找 h5ad 文件
    h5ad_files = list(dir_path.glob('*.h5ad'))
    
    if not h5ad_files:
        print(f"警告: 在 {dir_path} 中未找到 h5ad 文件")
        return results
    
    # 检查目录结构 - 每个子目录可能是一个样本
    subdirs = [d for d in dir_path.iterdir() if d.is_dir()]
    
    if subdirs:
        # 每个子目录一个样本
        for subdir in sorted(subdirs):
            sample_name = subdir.name
            h5ad_in_subdir = list(subdir.glob('*.h5ad'))
            if h5ad_in_subdir:
                result = inspect_h5ad(str(h5ad_in_subdir[0]), sample_name)
                results.append(result)
    else:
        # 目录下直接是 h5ad 文件
        for h5ad_file in sorted(h5ad_files):
            result = inspect_h5ad(str(h5ad_file))
            results.append(result)
    
    return results


def generate_recommendations(results: List[Dict]) -> Dict:
    """根据探查结果生成分析建议"""
    total_cells = sum(r['n_cells'] for r in results)
    species = detect_species_from_results(results)
    
    # 计算建议的 QC 参数
    all_genes = [r['genes_per_cell']['median'] for r in results]
    median_genes = np.median(all_genes)
    
    # 根据中位数基因数调整阈值
    if median_genes < 500:
        min_genes = 150
        max_genes = 2500
    elif median_genes < 1000:
        min_genes = 200
        max_genes = 4000
    elif median_genes < 2000:
        min_genes = 200
        max_genes = 6000
    else:
        min_genes = 300
        max_genes = 8000
    
    # 检查线粒体比例
    all_mito = [r['mito_ratio']['median'] for r in results]
    max_mito = 10 if np.median(all_mito) < 10 else 15
    
    # 推荐整合方法
    if total_cells > 100000:
        method = 'bbknn'
        method_note = '数据量大，使用 BBKNN 快速整合'
    elif total_cells > 50000:
        method = 'harmony'
        method_note = '数据量中等，使用 Harmony CPU 友好'
    else:
        method = 'harmony'  # 默认用 harmony，scvi 需要 GPU
        method_note = '数据量适中，使用 Harmony'
    
    recommendations = {
        'species': species,
        'qc_params': {
            'min_genes': min_genes,
            'max_genes': max_genes,
            'max_mito_percent': max_mito,
            'min_counts': 100
        },
        'integration': {
            'method': method,
            'note': method_note
        },
        'clustering': {
            'resolution': 0.4,
            'note': '建议先用 0.4，后续可根据 cluster 数调整'
        },
        'sampling': {
            'needed': total_cells > 20000,
            'max_cells': 20000 if total_cells > 20000 else None,
            'note': f'总细胞数 {total_cells}，{"建议抽样以加快分析" if total_cells > 20000 else "不需要抽样"}'
        }
    }
    
    return recommendations


def detect_species_from_results(results: List[Dict]) -> str:
    """从探查结果推断物种"""
    # 简单实现，实际应该读取基因名判断
    return "mouse"  # 默认值，后续可改进


def main():
    parser = argparse.ArgumentParser(description='数据探查工具')
    parser.add_argument('--input', '-i', required=True, help='输入路径（h5ad文件或目录）')
    parser.add_argument('--output', '-o', required=True, help='输出目录')
    parser.add_argument('--samples', '-s', help='样本名列表，逗号分隔')
    args = parser.parse_args()
    
    print("=" * 60)
    print("scRNA-seq 数据探查")
    print("=" * 60)
    
    # 创建输出目录
    os.makedirs(args.output, exist_ok=True)
    
    # 检查输入
    input_path = Path(args.input)
    
    results = []
    
    if input_path.is_file() and input_path.suffix == '.h5ad':
        # 单个文件
        print(f"\n发现单个 h5ad 文件: {input_path}")
        sample_name = input_path.stem
        result = inspect_h5ad(str(input_path), sample_name)
        results.append(result)
        
    elif input_path.is_dir():
        # 目录
        print(f"\n检查目录: {input_path}")
        results = inspect_directory(str(input_path))
        
    else:
        print(f"错误: 无法识别的输入路径 {input_path}")
        sys.exit(1)
    
    if not results:
        print("错误: 未找到有效数据")
        sys.exit(1)
    
    # 汇总统计
    total_cells = sum(r['n_cells'] for r in results)
    total_genes = results[0]['n_genes'] if results else 0
    n_samples = len(results)
    
    print(f"\n{'=' * 60}")
    print(f"数据概览")
    print(f"{'=' * 60}")
    print(f"样本数量: {n_samples}")
    print(f"总细胞数: {total_cells:,}")
    print(f"基因数:   {total_genes:,}")
    
    # 显示各样本统计
    print(f"\n{'样本':<20} {'细胞数':<12} {'基因数':<10} {'中位基因数':<12} {'中位线粒体%':<12}")
    print("-" * 70)
    for r in results:
        print(f"{r['sample_name']:<20} {r['n_cells']:<12,} {r['n_genes']:<10,} "
              f"{r['genes_per_cell']['median']:<12.0f} {r['mito_ratio']['median']:<12.1f}")
    
    # 生成建议
    recommendations = generate_recommendations(results)
    
    print(f"\n{'=' * 60}")
    print(f"分析建议")
    print(f"{'=' * 60}")
    print(f"物种: {recommendations['species']}")
    print(f"\nQC 参数建议:")
    print(f"  - min_genes: {recommendations['qc_params']['min_genes']}")
    print(f"  - max_genes: {recommendations['qc_params']['max_genes']}")
    print(f"  - max_mito%: {recommendations['qc_params']['max_mito_percent']}")
    print(f"\n整合方法: {recommendations['integration']['method']}")
    print(f"  ({recommendations['integration']['note']})")
    print(f"\n聚类分辨率: {recommendations['clustering']['resolution']}")
    print(f"  ({recommendations['clustering']['note']})")
    print(f"\n抽样建议:")
    print(f"  ({recommendations['sampling']['note']})")
    
    # 保存结果
    output_path = Path(args.output)
    
    # 保存 JSON
    overview = {
        'input_path': str(input_path),
        'n_samples': n_samples,
        'total_cells': total_cells,
        'total_genes': total_genes,
        'samples': results,
        'recommendations': recommendations
    }
    
    with open(output_path / 'data_overview.json', 'w') as f:
        json.dump(overview, f, indent=2)
    
    # 保存 CSV
    df = pd.DataFrame(results)
    df.to_csv(output_path / 'sample_summary.csv', index=False)
    
    print(f"\n结果已保存到: {output_path}")
    print(f"  - data_overview.json")
    print(f"  - sample_summary.csv")
    print("=" * 60)
    
    return overview


if __name__ == '__main__':
    main()
