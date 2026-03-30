#!/usr/bin/env python3
"""生信数据库查询工具"""
import sys
import json
import argparse
from pathlib import Path

try:
    from Bio import Entrez, SeqIO
    from Bio.Entrez import efetch, esearch
except ImportError:
    print(json.dumps({"error": "请先安装 biopython: pip install biopython"}))
    sys.exit(1)

# 设置 email
Entrez.email = "xiaoba@local"


def search_gene(symbol, species='human'):
    """查询基因信息"""
    try:
        # 搜索基因 ID
        search = Entrez.esearch(
            term=f"{symbol}[Gene Name] AND {species}[Organism]",
            db="gene",
            retmax=1
        )
        search_result = Entrez.read(search)
        
        if not search_result['IdList']:
            return {"error": f"未找到基因: {symbol}"}
        
        gene_id = search_result['IdList'][0]
        
        # 获取详细信息
        fetch = Entrez.efetch(db="gene", id=gene_id, rettype="xml", retmode="xml")
        gene_info = Entrez.read(fetch)
        
        gene_data = gene_info[0]['Entrezgene']
        
        result = {
            "status": "success",
            "gene_symbol": symbol,
            "gene_id": gene_id,
            "description": gene_data.get('Description', ''),
            "chromosome": gene_data.get('Chromosome', ''),
            "location": gene_data.get('MapLocation', ''),
        }
        
        # 获取官方全名
        if 'Gene-ref' in gene_data:
            gene_ref = gene_data['Gene-ref']
            result["full_name"] = gene_ref.get('Desc', '')
            result["alias"] = gene_ref.get('Alias', [])
        
        return result
    except Exception as e:
        return {"error": str(e)}


def get_sequence(gene, region=None, species='human'):
    """获取基因序列"""
    try:
        # 先搜索基因
        search = Entrez.esearch(
            term=f"{gene}[Gene Name] AND {species}[Organism]",
            db="gene",
            retmax=1
        )
        result = Entrez.read(search)
        
        if not result['IdList']:
            return {"error": f"未找到基因: {gene}"}
        
        gene_id = result['IdList'][0]
        
        if region:
            # 特定区域
            chrom, pos = region.split(':')
            start, end = pos.split('-')
            seq_type = "fasta"
        else:
            # 完整基因序列
            start, end = None, None
        
        # 获取序列（简化版，需要 genomic 的实际坐标）
        handle = Entrez.efetch(
            db="gene",
            id=gene_id,
            rettype="fasta",
            retmode="text"
        )
        
        try:
            record = SeqIO.read(handle, "fasta")
            sequence = str(record.seq)
            
            output = f"{gene}_sequence.fasta"
            with open(output, 'w') as f:
                f.write(f">{gene}\n{sequence}\n")
            
            return {
                "status": "success",
                "gene": gene,
                "sequence_length": len(sequence),
                "sequence_preview": sequence[:100] + "...",
                "output": output
            }
        except:
            return {
                "status": "success",
                "gene": gene,
                "note": "需要完整基因组位置才能获取序列",
                "suggestion": "使用 --region chr:start-end 格式指定位置"
            }
        
    except Exception as e:
        return {"error": str(e)}


def get_uniprot_info(uniprot_id):
    """查询 UniProt"""
    try:
        handle = Entrez.efetch(
            db="protein",
            id=uniprot_id,
            rettype="fasta",
            retmode="text"
        )
        record = SeqIO.read(handle, "fasta")
        
        return {
            "status": "success",
            "id": uniprot_id,
            "description": record.description,
            "sequence_length": len(record.seq),
            "sequence": str(record.seq)[:50] + "..."
        }
    except Exception as e:
        return {"error": str(e)}


def search_pubmed(query, max_results=10):
    """搜索 PubMed 文献"""
    try:
        handle = Entrez.esearch(
            db="pubmed",
            term=query,
            retmax=max_results
        )
        results = Entrez.read(handle)
        
        pmids = results['IdList']
        
        articles = []
        for pmid in pmids[:5]:
            try:
                fetch = Entrez.efetch(db="pubmed", id=pmid, rettype="xml")
                article = Entrez.read(fetch)
                
                if 'MedlineCitation' in article:
                    medline = article['MedlineCitation']
                    article_info = medline['Article']
                    
                    articles.append({
                        "pmid": pmid,
                        "title": article_info.get('ArticleTitle', ''),
                        "abstract": str(article_info.get('Abstract', {}).get('AbstractText', ''))[:200]
                    })
            except:
                continue
        
        return {
            "status": "success",
            "query": query,
            "total_results": int(results['Count']),
            "returned": len(articles),
            "articles": articles
        }
    except Exception as e:
        return {"error": str(e)}


def batch_gene_info(genes_file, species='human', output='gene_info.csv'):
    """批量基因注释"""
    try:
        import pandas as pd
        
        with open(genes_file, 'r') as f:
            genes = [line.strip() for line in f if line.strip()]
        
        results = []
        for gene in genes:
            info = search_gene(gene, species)
            if "status" in info:
                results.append({
                    "gene": gene,
                    "gene_id": info.get("gene_id", ""),
                    "description": info.get("description", ""),
                    "location": info.get("location", ""),
                    "full_name": info.get("full_name", "")
                })
            else:
                results.append({"gene": gene, "error": info.get("error", "")})
        
        df = pd.DataFrame(results)
        df.to_csv(output, index=False)
        
        return {
            "status": "success",
            "total": len(genes),
            "success": len([r for r in results if "error" not in r]),
            "output": output
        }
    except Exception as e:
        return {"error": str(e)}


def pathway_query(gene, database='kegg'):
    """查询通路信息"""
    try:
        # KEGG API
        import urllib.request
        import urllib.parse
        
        if database == 'kegg':
            # 搜索 KEGG
            base_url = "http://rest.kegg.jp/link/hsa/"
            gene_clean = gene.replace("hsa:", "").replace(":", "")
            url = f"{base_url}{gene_clean}"
            
            try:
                response = urllib.request.urlopen(url, timeout=10)
                pathways = response.read().decode()
                
                pathway_list = []
                for line in pathways.strip().split('\n'):
                    if line:
                        parts = line.split('\t')
                        if len(parts) == 2:
                            pathway_list.append({
                                "pathway_id": parts[0].replace("hsa:", ""),
                                "pathway_name": parts[1].strip()
                            })
                
                return {
                    "status": "success",
                    "gene": gene,
                    "database": "KEGG",
                    "pathways": pathway_list[:10]
                }
            except:
                return {
                    "status": "success",
                    "gene": gene,
                    "database": "KEGG",
                    "note": "KEGG API 不可用，请手动查询: https://www.kegg.jp"
                }
        
        return {"error": f"不支持的数据库: {database}"}
    except Exception as e:
        return {"error": str(e)}


def geo_download(accession, save_file=None):
    """下载 GEO 数据"""
    try:
        import urllib.request
        
        if save_file is None:
            save_file = f"{accession}_data.csv"
        
        # GEO FTP 访问
        url = f"https://www.ncbi.nlm.nih.gov/geo/download/?acc={accession}&format=file"
        
        return {
            "status": "success",
            "accession": accession,
            "note": "GEO 数据较大，建议使用以下方式下载：",
            "methods": [
                "1. 网页下载: https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=" + accession,
                "2. R: GEOquery::getGEO('" + accession + "')",
                "3. Python: pandas.read_csv(url, sep='\\t')"
            ],
            "suggestion": "推荐使用 R 的 GEOquery 包或 Python 的 pandas 直接读取"
        }
    except Exception as e:
        return {"error": str(e)}


def main():
    parser = argparse.ArgumentParser(description='生信数据库工具')
    parser.add_argument('action', nargs='?', default='info',
                        choices=['gene', 'sequence', 'uniprot', 'pubmed', 'annotate', 'pathway', 'geo', 'info'],
                        help='操作类型')
    parser.add_argument('--symbol', help='基因符号')
    parser.add_argument('--gene', help='基因名')
    parser.add_argument('--genes', help='基因列表文件')
    parser.add_argument('--region', help='基因组区域 chr:start-end')
    parser.add_argument('--species', default='human', help='物种')
    parser.add_argument('--uniprot', help='UniProt ID')
    parser.add_argument('--query', help='搜索关键词')
    parser.add_argument('--database', default='kegg', help='数据库')
    parser.add_argument('--accession', help='GEO accession')
    parser.add_argument('--output', help='输出文件')
    parser.add_argument('--max-results', type=int, default=10, help='最大结果数')
    
    args = parser.parse_args()
    
    result = None
    
    if args.action == 'gene':
        result = search_gene(args.symbol, args.species)
    elif args.action == 'sequence':
        result = get_sequence(args.gene, args.region, args.species)
    elif args.action == 'uniprot':
        result = get_uniprot_info(args.uniprot)
    elif args.action == 'pubmed':
        result = search_pubmed(args.query, args.max_results)
    elif args.action == 'annotate':
        result = batch_gene_info(args.genes, args.species, args.output or 'gene_info.csv')
    elif args.action == 'pathway':
        result = pathway_query(args.gene, args.database)
    elif args.action == 'geo':
        result = geo_download(args.accession, args.output)
    
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
