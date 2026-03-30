#!/usr/bin/env python3
"""RNA-seq 分析工具 - 差异表达、富集分析、可视化"""
import sys
import json
import argparse
import subprocess
from pathlib import Path

try:
    import pandas as pd
    import numpy as np
except ImportError:
    print(json.dumps({"error": "请先安装: pip install pandas numpy matplotlib seaborn"}))
    sys.exit(1)


def load_data(matrix_file, samples_file=None):
    """加载 RNA-seq 数据"""
    try:
        # 读取 counts 矩阵
        counts = pd.read_csv(matrix_file, index_col=0)
        
        result = {
            "status": "success",
            "shape": {"samples": counts.shape[0], "genes": counts.shape[1]},
            "top_genes": list(counts.var(axis=0).sort_values(ascending=False).head(10).index),
            "sample_names": list(counts.index[:10])
        }
        
        # 读取样本信息
        if samples_file and Path(samples_file).exists():
            samples = pd.read_csv(samples_file, index_col=0)
            result["samples"] = samples.to_dict()
            result["conditions"] = list(samples.columns)
        
        return result
    except Exception as e:
        return {"error": str(e)}


def deseq2_analysis(counts_file, samples_file, condition_col, contrast=None):
    """DESeq2 差异表达分析"""
    try:
        # 检查 R 是否可用
        r_check = subprocess.run("Rscript -e 'library(DESeq2)'", 
                                 shell=True, capture_output=True)
        if r_check.returncode != 0:
            return {"error": "需要安装 R 和 DESeq2: install.packages('DESeq2')"}
        
        # 生成 R 脚本
        r_script = f"""
library(DESeq2)

# 读取数据
counts <- read.csv("{counts_file}", row.names=1)
coldata <- read.csv("{samples_file}", row.names=1)

# 确保列名一致
coldata$sample <- rownames(coldata)
counts <- counts[, rownames(coldata)]

# 创建 DESeq2 数据集
dds <- DESeqDataSetFromMatrix(countData = counts,
                              colData = coldata,
                              design = ~ {condition_col})

# 过滤低表达基因
keep <- rowSums(counts(dds) >= 10) >= 3
dds <- dds[keep,]

# 运行 DESeq2
dds <- DESeq(dds)
resultsNames(dds)

# 获取结果
if (is.null("{contrast}")) {{
    res <- results(dds)
}} else {{
    res <- results(dds, contrast=c("{condition_col}", strsplit("{contrast}", ",")[[1]]))
}}

# 保存结果
res_df <- as.data.frame(res)
res_df$gene <- rownames(res_df)
write.csv(res_df, "deseq2_results.csv", row.names=FALSE)

# 显著性基因
sig <- res_df[res_df$padj < 0.05 & !is.na(res_df$padj),]
write.csv(sig, "significant_genes.csv", row.names=FALSE)

cat("完成了! 找到", nrow(sig), "个显著差异基因\\n")
"""
        
        # 写入临时脚本
        script_path = "deseq2_analysis.R"
        with open(script_path, 'w') as f:
            f.write(r_script)
        
        # 执行
        result = subprocess.run(
            f"Rscript {script_path}",
            shell=True, capture_output=True, text=True, timeout=600
        )
        
        if result.returncode == 0:
            # 读取结果
            if Path("deseq2_results.csv").exists():
                results = pd.read_csv("deseq2_results.csv")
                up = len(results[(results['log2FoldChange'] > 1) & (results['padj'] < 0.05)])
                down = len(results[(results['log2FoldChange'] < -1) & (results['padj'] < 0.05)])
                
                return {
                    "status": "success",
                    "total_genes": len(results),
                    "upregulated": up,
                    "downregulated": down,
                    "output_files": ["deseq2_results.csv", "significant_genes.csv"],
                    "stdout": result.stdout[-500:]
                }
        
        return {"error": result.stderr[-500:] if result.stderr else "分析失败"}
        
    except subprocess.TimeoutExpired:
        return {"error": "分析超时"}
    except Exception as e:
        return {"error": str(e)}


def go_enrichment(genes_file, species='human', organism='hsa'):
    """GO/KEGG 富集分析"""
    try:
        # 检查 R
        r_check = subprocess.run(
            "Rscript -e 'library(clusterProfiler)'",
            shell=True, capture_output=True
        )
        if r_check.returncode != 0:
            return {"error": "需要安装 R 和 clusterProfiler"}
        
        gene_list = pd.read_csv(genes_file)
        if 'gene' in gene_list.columns:
            genes = gene_list['gene'].dropna().tolist()
        else:
            genes = gene_list.iloc[:, 0].dropna().tolist()
        
        r_script = f"""
library(clusterProfiler)
library(org.{organism}.eg.db)

# 读取基因列表
genes <- scan("{genes_file}", what="character", sep="\\n")
genes <- unique(genes[genes != ""])

# GO 富集
go_bp <- enrichGO(gene=genes, OrgDb="org.{organism}.eg.db", ont="BP")
go_cc <- enrichGO(gene=genes, OrgDb="org.{organism}.eg.db", ont="CC")
go_mf <- enrichGO(gene=genes, OrgDb="org.{organism}.eg.db", ont="MF")

# KEGG 富集
kk <- enrichKEGG(gene=genes, organism="{organism}")

# 保存结果
write.csv(as.data.frame(go_bp), "go_bp_enrichment.csv", row.names=FALSE)
write.csv(as.data.frame(go_cc), "go_cc_enrichment.csv", row.names=FALSE)
write.csv(as.data.frame(go_mf), "go_mf_enrichment.csv", row.names=FALSE)
write.csv(as.data.frame(kk), "kegg_enrichment.csv", row.names=FALSE)

cat("GO BP:", nrow(go_bp), "terms\\n")
cat("GO CC:", nrow(go_cc), "terms\\n")
cat("GO MF:", nrow(go_mf), "terms\\n")
cat("KEGG:", nrow(kk), "pathways\\n")
"""
        
        script_path = "enrichment_analysis.R"
        with open(script_path, 'w') as f:
            f.write(r_script)
        
        result = subprocess.run(
            f"Rscript {script_path}",
            shell=True, capture_output=True, text=True, timeout=300
        )
        
        if result.returncode == 0:
            outputs = []
            for f in ['go_bp_enrichment.csv', 'kegg_enrichment.csv']:
                if Path(f).exists():
                    outputs.append(f)
            
            return {
                "status": "success",
                "output_files": outputs,
                "stdout": result.stdout[-500:]
            }
        
        return {"error": result.stderr[-500:] if result.stderr else "分析失败"}
        
    except Exception as e:
        return {"error": str(e)}


def volcano_plot(degs_file, fc_col='log2FoldChange', pval_col='padj', output='volcano.png'):
    """绘制火山图"""
    try:
        import matplotlib.pyplot as plt
        import seaborn as sns
        
        df = pd.read_csv(degs_file)
        
        # 处理列名
        fc_col = df.columns[df.columns.str.lower().str.contains('log2|fc')][0] if not fc_col else fc_col
        pval_col = df.columns[df.columns.str.lower().str.contains('pval|adj')][0] if not pval_col else pval_col
        
        df['-log10(padj)'] = -np.log10(df[pval_col])
        
        # 设置颜色
        df['color'] = 'ns'
        df.loc[(df[fc_col] > 1) & (df[pval_col] < 0.05), 'color'] = 'up'
        df.loc[(df[fc_col] < -1) & (df[pval_col] < 0.05), 'color'] = 'down'
        
        plt.figure(figsize=(10, 8))
        colors = {'ns': 'grey', 'up': 'red', 'down': 'blue'}
        
        for label, color in colors.items():
            subset = df[df['color'] == label]
            plt.scatter(subset[fc_col], subset['-log10(padj)'], 
                      c=color, label=label, alpha=0.6, s=20)
        
        plt.axhline(y=-np.log10(0.05), color='black', linestyle='--', linewidth=0.5)
        plt.axvline(x=1, color='black', linestyle='--', linewidth=0.5)
        plt.axvline(x=-1, color='black', linestyle='--', linewidth=0.5)
        
        plt.xlabel(fc_col)
        plt.ylabel('-log10(padj)')
        plt.title('Volcano Plot')
        plt.legend()
        plt.tight_layout()
        plt.savefig(output, dpi=150)
        plt.close()
        
        return {"status": "success", "plot_path": output}
        
    except Exception as e:
        return {"error": str(e)}


def heatmap_plot(counts_file, degs_file, top_n=50, output='heatmap.png'):
    """绘制热图"""
    try:
        import matplotlib.pyplot as plt
        import seaborn as sns
        
        counts = pd.read_csv(counts_file, index_col=0)
        degs = pd.read_csv(degs_file)
        
        # 获取 top 基因
        if 'gene' in degs.columns:
            top_genes = degs.nlargest(top_n, degs.columns[1])['gene'].tolist()
        else:
            top_genes = degs.iloc[:, 0].head(top_n).tolist()
        
        # 提取对应的基因
        common_genes = [g for g in top_genes if g in counts.index]
        subset = counts.loc[common_genes[:min(top_n, len(common_genes))]]
        
        # 标准化
        subset_norm = (subset.T - subset.T.mean()) / subset.T.std()
        
        plt.figure(figsize=(12, max(8, len(common_genes) * 0.2)))
        sns.heatmap(subset_norm.T, cmap='RdBu_r', center=0, 
                   xticklabels=True, yticklabels=True)
        plt.title(f'Top {len(common_genes)} Differentially Expressed Genes')
        plt.xlabel('Samples')
        plt.ylabel('Genes')
        plt.tight_layout()
        plt.savefig(output, dpi=150)
        plt.close()
        
        return {"status": "success", "plot_path": output, "genes_shown": len(common_genes)}
        
    except Exception as e:
        return {"error": str(e)}


def main():
    parser = argparse.ArgumentParser(description='RNA-seq 分析工具')
    parser.add_argument('action', nargs='?', default='info',
                        choices=['load', 'deseq2', 'enrich', 'volcano', 'heatmap', 'info'],
                        help='操作类型')
    parser.add_argument('--matrix', help='表达矩阵文件')
    parser.add_argument('--samples', help='样本信息文件')
    parser.add_argument('--counts', help='counts 文件')
    parser.add_argument('--degs', help='差异表达结果文件')
    parser.add_argument('--genes', help='基因列表文件')
    parser.add_argument('--condition', help='条件列名')
    parser.add_argument('--contrast', help='对比，如 tumor,normal')
    parser.add_argument('--species', default='human', help='物种')
    parser.add_argument('--organism', default='Hs', help='KEGG 物种代码')
    parser.add_argument('--fc-col', help='log2FC 列名')
    parser.add_argument('--pval-col', help='pval 列名')
    parser.add_argument('--output', default='output.png', help='输出文件')
    parser.add_argument('--top-n', type=int, default=50, help='top N 基因')
    
    args = parser.parse_args()
    
    result = None
    
    if args.action == 'load':
        result = load_data(args.matrix, args.samples)
    elif args.action == 'deseq2':
        result = deseq2_analysis(args.counts, args.samples, args.condition, args.contrast)
    elif args.action == 'enrich':
        result = go_enrichment(args.genes, args.species, args.organism)
    elif args.action == 'volcano':
        result = volcano_plot(args.degs, args.fc_col, args.pval_col, args.output)
    elif args.action == 'heatmap':
        result = heatmap_plot(args.counts, args.degs, args.top_n, args.output)
    
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
