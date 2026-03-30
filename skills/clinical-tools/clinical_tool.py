#!/usr/bin/env python3
"""临床生信数据挖掘工具 - TCGA/GEO/生存分析"""
import sys
import json
import argparse
import subprocess
from pathlib import Path

try:
    import pandas as pd
    import numpy as np
except ImportError:
    print(json.dumps({"error": "请先安装: pip install pandas numpy"}))
    sys.exit(1)


def check_dependencies():
    """检查依赖"""
    deps = {
        'tcga_downloader': False,
        'survival': False,
        'geo': False
    }
    
    # 检查 RTCGA
    r_check = subprocess.run(
        'Rscript -e "library(RTCGA)"', 
        shell=True, capture_output=True
    )
    if r_check.returncode == 0:
        deps['tcga_downloader'] = True
    
    return deps


def survival_analysis(clinical_file, expr_file=None, gene=None, 
                      time_col='time', event_col='event', output='survival.png'):
    """生存分析"""
    try:
        import matplotlib.pyplot as plt
        from lifelines import KaplanMeierFitter
        from lifelines.statistics import logrank_test
        
        clinical = pd.read_csv(clinical_file)
        
        # 处理时间列
        if time_col not in clinical.columns:
            # 尝试自动识别
            for col in clinical.columns:
                if 'time' in col.lower() or 'day' in col.lower() or 'month' in col.lower():
                    time_col = col
                    break
        
        if time_col not in clinical.columns:
            return {"error": f"未找到时间列: {time_col}"}
        
        if event_col not in clinical.columns:
            for col in clinical.columns:
                if 'event' in col.lower() or 'death' in col.lower() or 'status' in col.lower():
                    event_col = col
                    break
        
        # 简单两分组分析
        T = clinical[time_col]
        E = clinical[event_col] if event_col in clinical.columns else np.ones(len(clinical))
        
        # 中位生存时间分组
        median_value = clinical[time_col].median()
        clinical['group'] = (clinical[time_col] > median_value).map({True: 'High', False: 'Low'})
        
        # 绘图
        plt.figure(figsize=(10, 8))
        
        kmf = KaplanMeierFitter()
        
        for group in ['High', 'Low']:
            mask = clinical['group'] == group
            kmf.fit(T[mask], E[mask] if isinstance(E, pd.Series) else E[mask], label=group)
            kmf.plot_survival_function()
        
        # Log-rank 检验
        if len(clinical['group'].unique()) == 2:
            t1 = T[clinical['group'] == 'High']
            t2 = T[clinical['group'] == 'Low']
            e1 = E[clinical['group'] == 'High'] if isinstance(E, pd.Series) else E[clinical['group'] == 'High']
            e2 = E[clinical['group'] == 'Low'] if isinstance(E, pd.Series) else E[clinical['group'] == 'Low']
            
            results = logrank_test(t1, t2, e1, e2)
            p_value = results.p_value
            
            plt.title(f'Survival Analysis (p={p_value:.4f})')
        
        plt.xlabel('Time')
        plt.ylabel('Survival Probability')
        plt.legend()
        plt.tight_layout()
        plt.savefig(output, dpi=150)
        plt.close()
        
        # 统计信息
        stats = clinical.groupby('group').agg({
            time_col: ['count', 'median', 'mean']
        }).to_dict()
        
        return {
            "status": "success",
            "plot_path": output,
            "n_high": int((clinical['group'] == 'High').sum()),
            "n_low": int((clinical['group'] == 'Low').sum()),
            "median_time_high": float(median_value) if 'High' in clinical['group'].values else None,
            "p_value": float(p_value) if 'p_value' in dir() else None
        }
        
    except ImportError:
        return {"error": "请安装 lifelines: pip install lifelines"}
    except Exception as e:
        return {"error": str(e)}


def correlation_analysis(expr_file, gene1, gene2):
    """基因相关性分析"""
    try:
        import matplotlib.pyplot as plt
        from scipy import stats
        
        expr = pd.read_csv(expr_file, index_col=0)
        
        if gene1 not in expr.index:
            return {"error": f"基因 {gene1} 不在数据中"}
        if gene2 not in expr.index:
            return {"error": f"基因 {gene2} 不在数据中"}
        
        x = expr.loc[gene1].values
        y = expr.loc[gene2].values
        
        # Pearson 相关
        r, p = stats.pearsonr(x, y)
        
        # 绘图
        plt.figure(figsize=(8, 6))
        plt.scatter(x, y, alpha=0.5)
        
        # 回归线
        z = np.polyfit(x, y, 1)
        p_line = np.poly1d(z)
        plt.plot(x, p_line(x), 'r--', alpha=0.8)
        
        plt.xlabel(gene1)
        plt.ylabel(gene2)
        plt.title(f'Correlation: r={r:.3f}, p={p:.2e}')
        plt.tight_layout()
        plt.savefig('correlation_plot.png', dpi=150)
        plt.close()
        
        return {
            "status": "success",
            "gene1": gene1,
            "gene2": gene2,
            "pearson_r": round(float(r), 4),
            "p_value": f"{p:.2e}",
            "n_samples": len(x),
            "plot": "correlation_plot.png"
        }
        
    except Exception as e:
        return {"error": str(e)}


def batch_survival(clinical_file, expr_file, genes=None, output='batch_survival.csv'):
    """批量生存分析"""
    try:
        from lifelines import KaplanMeierFitter
        from lifelines.statistics import logrank_test
        
        clinical = pd.read_csv(clinical_file)
        expr = pd.read_csv(expr_file, index_col=0)
        
        # 找时间列
        time_col = None
        for col in clinical.columns:
            if 'time' in col.lower() or 'day' in col.lower():
                time_col = col
                break
        
        if not time_col:
            return {"error": "未找到时间列"}
        
        results = []
        
        if genes:
            gene_list = genes.split(',')
        else:
            # 使用方差最大的前20个基因
            gene_list = list(expr.var(axis=1).nlargest(20).index)
        
        T = clinical[time_col]
        E = clinical.get('event', pd.Series(np.ones(len(clinical))))
        
        for gene in gene_list:
            if gene not in expr.index:
                continue
            
            median_expr = expr.loc[gene].median()
            high = expr.loc[gene] > median_expr
            
            if high.sum() < 5 or (~high).sum() < 5:
                continue
            
            try:
                results_lr = logrank_test(
                    T[high], T[~high],
                    E[high], E[~high]
                )
                results.append({
                    "gene": gene,
                    "p_value": results_lr.p_value,
                    "hazard_ratio": "N/A",
                    "n_high": int(high.sum()),
                    "n_low": int((~high).sum())
                })
            except:
                continue
        
        df = pd.DataFrame(results)
        df = df.sort_values('p_value')
        df.to_csv(output, index=False)
        
        sig_genes = df[df['p_value'] < 0.05]
        
        return {
            "status": "success",
            "total_genes_tested": len(results),
            "significant_genes": len(sig_genes),
            "output": output,
            "top_results": sig_genes.head(10).to_dict('records') if len(sig_genes) > 0 else []
        }
        
    except Exception as e:
        return {"error": str(e)}


def tcga_query(cancer, data_type='expression', save_file=None):
    """TCGA 数据查询（模拟）"""
    try:
        # 实际需要通过 RTCGA 包获取
        r_script = f"""
library(RTCGA)
library(RTCGAToolbox)

# 获取 {cancer} 数据
# 具体实现需要配置
cat("TCGA {cancer} {data_type} data query\\n")
cat("Note: 需要配置 GDC 密钥才能下载真实数据\\n")
"""
        
        result = subprocess.run(
            f"Rscript -e '{r_script}'",
            shell=True, capture_output=True, text=True, timeout=60
        )
        
        return {
            "status": "success",
            "message": f"TCGA {cancer} 数据查询",
            "note": "需要安装 RTCGA 包和配置 GDC 认证",
            "suggestion": "推荐使用 Xena、GEPIA2 等网页工具获取 TCGA 数据"
        }
        
    except Exception as e:
        return {"error": str(e)}


def main():
    parser = argparse.ArgumentParser(description='临床生信工具')
    parser.add_argument('action', nargs='?', default='info',
                        choices=['survival', 'correlation', 'batch-survival', 'tcga', 'info'],
                        help='操作类型')
    parser.add_argument('--clinical', help='临床数据文件')
    parser.add_argument('--expr', help='表达数据文件')
    parser.add_argument('--gene', help='基因名')
    parser.add_argument('--genes', help='基因列表（逗号分隔）')
    parser.add_argument('--gene1', help='基因1')
    parser.add_argument('--gene2', help='基因2')
    parser.add_argument('--time-col', default='time', help='时间列名')
    parser.add_argument('--event-col', default='event', help='事件列名')
    parser.add_argument('--cancer', help='癌症类型')
    parser.add_argument('--output', default='output.png', help='输出文件')
    parser.add_argument('--save', help='保存文件')
    
    args = parser.parse_args()
    
    result = None
    
    if args.action == 'survival':
        result = survival_analysis(
            args.clinical, args.expr, args.gene,
            args.time_col, args.event_col, args.output
        )
    elif args.action == 'correlation':
        result = correlation_analysis(args.expr, args.gene1, args.gene2)
    elif args.action == 'batch-survival':
        result = batch_survival(args.clinical, args.expr, args.genes, args.output)
    elif args.action == 'tcga':
        result = tcga_query(args.cancer, save_file=args.save)
    else:
        result = {"status": "ready", "message": "临床生信工具就绪"}
    
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
