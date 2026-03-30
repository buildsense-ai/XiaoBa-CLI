#!/usr/bin/env python3
"""R 语言生信工具封装"""
import sys
import json
import argparse
import subprocess
from pathlib import Path


def check_r_package(package):
    """检查 R 包是否安装"""
    cmd = f'Rscript -e "library({package})"'
    result = subprocess.run(cmd, shell=True, capture_output=True)
    return result.returncode == 0


def seurat_analysis(data_file, samples_file, group_by, output='seurat_results'):
    """Seurat 单细胞分析"""
    try:
        if not check_r_package('Seurat'):
            return {"error": "请先安装 Seurat: install.packages('Seurat')"}
        
        r_script = f"""
library(Seurat)
library(dplyr)

# 读取数据
counts <- read.csv("{data_file}", row.names=1)
samples <- read.csv("{samples_file}", row.names=1)

# 创建 Seurat 对象
seurat_obj <- CreateSeuratObject(counts = t(counts), meta.data = samples)

# QC
seurat_obj <- PercentageFeatureSet(seurat_obj, pattern = "^MT-", col.name = "percent.mt")
seurat_obj <- subset(seurat_obj, subset = nFeature_RNA > 200 & percent.mt < 20)

# 标准化
seurat_obj <- NormalizeData(seurat_obj)
seurat_obj <- FindVariableFeatures(seurat_obj, nfeatures = 2000)
seurat_obj <- ScaleData(seurat_obj)

# PCA
seurat_obj <- RunPCA(seurat_obj, features = VariableFeatures(seurat_obj))

# 聚类
seurat_obj <- FindNeighbors(seurat_obj, dims = 1:30)
seurat_obj <- FindClusters(seurat_obj, resolution = 0.5)

# UMAP
seurat_obj <- RunUMAP(seurat_obj, dims = 1:30)

# 保存
saveRDS(seurat_obj, "{output}.rds")

# 统计
cluster_counts <- table(seurat_obj@meta.data$seurat_clusters)
cat("Clusters:", length(unique(seurat_obj@meta.data$seurat_clusters)), "\\n")
cat("Cells:", ncol(seurat_obj), "\\n")
"""
        
        with open('seurat_analysis.R', 'w') as f:
            f.write(r_script)
        
        result = subprocess.run(
            'Rscript seurat_analysis.R',
            shell=True, capture_output=True, text=True, timeout=600
        )
        
        if result.returncode == 0:
            return {
                "status": "success",
                "output": f"{output}.rds",
                "stdout": result.stdout[-500:]
            }
        
        return {"error": result.stderr[-500:] if result.stderr else "分析失败"}
        
    except subprocess.TimeoutExpired:
        return {"error": "分析超时"}
    except Exception as e:
        return {"error": str(e)}


def seurat_visualize(seurat_file, method='umap', color_by='seurat_clusters', output='plot.png'):
    """Seurat 可视化"""
    try:
        r_script = f"""
library(Seurat)

obj <- readRDS("{seurat_file}")

# 创建可视化
png("{output}", width = 2000, height = 2000, res = 150)

if ("{method}" == "umap") {{
    p <- DimPlot(obj, reduction = "umap", group.by = "{color_by}")
}} else if ("{method}" == "tsne") {{
    p <- DimPlot(obj, reduction = "tsne", group.by = "{color_by}")
}} else {{
    p <- DimPlot(obj, reduction = "pca", group.by = "{color_by}")
}}

print(p)
dev.off()

cat("Plot saved to {output}\\n")
"""
        
        with open('seurat_plot.R', 'w') as f:
            f.write(r_script)
        
        result = subprocess.run(
            'Rscript seurat_plot.R',
            shell=True, capture_output=True, text=True, timeout=300
        )
        
        if result.returncode == 0:
            return {
                "status": "success",
                "plot_path": output,
                "method": method,
                "color_by": color_by
            }
        
        return {"error": result.stderr[-500:] if result.stderr else "绘图失败"}
        
    except Exception as e:
        return {"error": str(e)}


def deseq2_analysis(counts_file, coldata_file, design, output='deseq2_results'):
    """DESeq2 差异分析"""
    try:
        if not check_r_package('DESeq2'):
            return {"error": "请先安装 DESeq2"}
        
        r_script = f"""
library(DESeq2)

# 读取数据
counts <- read.csv("{counts_file}", row.names=1)
coldata <- read.csv("{coldata_file}", row.names=1)

# 确保列名一致
counts <- counts[, rownames(coldata)]

# 创建设计
coldata$sample <- rownames(coldata)
design_formula <- as.formula("{design}")

# 创建 DESeq2 数据集
dds <- DESeqDataSetFromMatrix(countData = counts,
                              colData = coldata,
                              design = design_formula)

# 过滤
keep <- rowSums(counts(dds) >= 10) >= 3
dds <- dds[keep,]

# 分析
dds <- DESeq(dds)

# 保存所有结果
res <- results(dds)
res_df <- as.data.frame(res)
res_df$gene <- rownames(res_df)
write.csv(res_df, "{output}_all.csv", row.names=FALSE)

# 显著基因
sig <- res_df[!is.na(res_df$padj) & res_df$padj < 0.05,]
write.csv(sig, "{output}_significant.csv", row.names=FALSE)

cat("Total:", nrow(res_df), "genes\\n")
cat("Significant:", nrow(sig), "genes (padj < 0.05)\\n")
cat("Up-regulated:", sum(sig$log2FoldChange > 1, na.rm=TRUE), "\\n")
cat("Down-regulated:", sum(sig$log2FoldChange < -1, na.rm=TRUE), "\\n")
"""
        
        with open('deseq2_analysis.R', 'w') as f:
            f.write(r_script)
        
        result = subprocess.run(
            'Rscript deseq2_analysis.R',
            shell=True, capture_output=True, text=True, timeout=600
        )
        
        if result.returncode == 0:
            return {
                "status": "success",
                "outputs": [f"{output}_all.csv", f"{output}_significant.csv"],
                "stdout": result.stdout[-500:]
            }
        
        return {"error": result.stderr[-500:] if result.stderr else "分析失败"}
        
    except Exception as e:
        return {"error": str(e)}


def go_enrichment(genes_file, species='human', output='go_results'):
    """GO/KEGG 富集分析"""
    try:
        if not check_r_package('clusterProfiler'):
            return {"error": "请先安装 clusterProfiler"}
        
        # 物种映射
        org_map = {
            'human': 'org.Hs.eg.db',
            'mouse': 'org.Mm.eg.db'
        }
        org_db = org_map.get(species.lower(), 'org.Hs.eg.db')
        
        kegg_species = {
            'human': 'hsa',
            'mouse': 'mmu'
        }
        kegg_org = kegg_species.get(species.lower(), 'hsa')
        
        r_script = f"""
library(clusterProfiler)
library({org_db})

# 读取基因
genes <- read.csv("{genes_file}")$gene
# 去除空格
genes <- trimws(as.character(genes))
genes <- unique(genes[genes != ""])

cat("Total genes:", length(genes), "\\n")

# GO 富集
go_bp <- enrichGO(gene=genes, OrgDb="{org_db}", ont="BP", pvalueCutoff=0.05)
go_cc <- enrichGO(gene=genes, OrgDb="{org_db}", ont="CC", pvalueCutoff=0.05)
go_mf <- enrichGO(gene=genes, OrgDb="{org_db}", ont="MF", pvalueCutoff=0.05)

# KEGG
kk <- enrichKEGG(gene=genes, organism="{kegg_org}", pvalueCutoff=0.05)

# 保存
write.csv(as.data.frame(go_bp), "{output}_GO_BP.csv", row.names=FALSE)
write.csv(as.data.frame(go_cc), "{output}_GO_CC.csv", row.names=FALSE)
write.csv(as.data.frame(go_mf), "{output}_GO_MF.csv", row.names=FALSE)
write.csv(as.data.frame(kk), "{output}_KEGG.csv", row.names=FALSE)

cat("GO BP terms:", nrow(go_bp), "\\n")
cat("GO CC terms:", nrow(go_cc), "\\n")
cat("GO MF terms:", nrow(go_mf), "\\n")
cat("KEGG pathways:", nrow(kk), "\\n")
"""
        
        with open('go_enrichment.R', 'w') as f:
            f.write(r_script)
        
        result = subprocess.run(
            'Rscript go_enrichment.R',
            shell=True, capture_output=True, text=True, timeout=300
        )
        
        if result.returncode == 0:
            return {
                "status": "success",
                "outputs": [
                    f"{output}_GO_BP.csv",
                    f"{output}_GO_CC.csv", 
                    f"{output}_GO_MF.csv",
                    f"{output}_KEGG.csv"
                ],
                "stdout": result.stdout[-500:]
            }
        
        return {"error": result.stderr[-500:] if result.stderr else "分析失败"}
        
    except Exception as e:
        return {"error": str(e)}


def volcano_plot_r(degs_file, output='volcano.png'):
    """R 版火山图（更美观）"""
    try:
        r_script = f"""
library(ggplot2)
library(dplyr)

# 读取数据
degs <- read.csv("{degs_file}")

# 识别列名
log2fc_col <- grep("log2|fc", names(degs), value=TRUE, ignore.case=TRUE)[1]
pval_col <- grep("pval|adj", names(degs), value=TRUE, ignore.case=TRUE)[1]

if (is.na(log2fc_col)) log2fc_col <- names(degs)[2]
if (is.na(pval_col)) pval_col <- names(degs)[3]

cat("Using columns:", log2fc_col, ",", pval_col, "\\n")

# 添加颜色
degs <- degs %>%
    mutate(
        significance = case_when(
            get(log2fc_col) > 1 & get(pval_col) < 0.05 ~ "Up",
            get(log2fc_col) < -1 & get(pval_col) < 0.05 ~ "Down",
            TRUE ~ "Not Significant"
        )
    )

# 绘图
p <- ggplot(degs, aes(x = get(log2fc_col), y = -log10(get(pval_col)), color = significance)) +
    geom_point(alpha = 0.6, size = 1) +
    scale_color_manual(values = c("Up" = "#E74C3C", "Down" = "#3498DB", "Not Significant" = "grey80")) +
    geom_hline(yintercept = -log10(0.05), linetype = "dashed", color = "black") +
    geom_vline(xintercept = c(-1, 1), linetype = "dashed", color = "black") +
    theme_minimal() +
    labs(x = log2fc_col, y = "-log10(padj)", title = "Volcano Plot")

ggsave("{output}", plot = p, width = 10, height = 8, dpi = 150)
cat("Plot saved to {output}\\n")
"""
        
        with open('volcano_r.R', 'w') as f:
            f.write(r_script)
        
        result = subprocess.run(
            'Rscript volcano_r.R',
            shell=True, capture_output=True, text=True, timeout=120
        )
        
        if result.returncode == 0:
            return {
                "status": "success",
                "plot_path": output
            }
        
        return {"error": result.stderr[-500:] if result.stderr else "绘图失败"}
        
    except Exception as e:
        return {"error": str(e)}


def main():
    parser = argparse.ArgumentParser(description='R 生信工具')
    parser.add_argument('action', nargs='?', default='info',
                        choices=['seurat', 'deseq2', 'go', 'plot', 'volcano', 'info'],
                        help='操作类型')
    parser.add_argument('--data', help='表达矩阵文件')
    parser.add_argument('--counts', help='counts 文件')
    parser.add_argument('--samples', help='样本信息文件')
    parser.add_argument('--coldata', help='coldata 文件')
    parser.add_argument('--genes', help='基因列表文件')
    parser.add_argument('--seurat', help='Seurat RDS 文件')
    parser.add_argument('--degs', help='差异分析结果文件')
    parser.add_argument('--group-by', default='group', help='分组字段')
    parser.add_argument('--design', default='~ condition', help='DESeq2 设计公式')
    parser.add_argument('--species', default='human', help='物种')
    parser.add_argument('--method', default='umap', help='可视化方法')
    parser.add_argument('--color-by', default='seurat_clusters', help='颜色字段')
    parser.add_argument('--output', default='results', help='输出前缀')
    
    args = parser.parse_args()
    
    result = None
    
    if args.action == 'seurat':
        result = seurat_analysis(args.data, args.samples, args.group_by, args.output)
    elif args.action == 'deseq2':
        result = deseq2_analysis(args.counts, args.coldata, args.design, args.output)
    elif args.action == 'go':
        result = go_enrichment(args.genes, args.species, args.output)
    elif args.action == 'plot':
        result = seurat_visualize(args.seurat, args.method, args.color_by, f'{args.output}.png')
    elif args.action == 'volcano':
        result = volcano_plot_r(args.degs, f'{args.output}.png')
    
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
