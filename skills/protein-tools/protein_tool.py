#!/usr/bin/env python3
"""蛋白质结构预测与分析工具"""
import sys
import json
import argparse
import subprocess
from pathlib import Path

try:
    from Bio import SeqIO, pairwise2, Align
    from Bio.Seq import Seq
except ImportError:
    print(json.dumps({"error": "请先安装 biopython: pip install biopython"}))
    sys.exit(1)


def sequence_align(seq1, seq2, output='alignment.txt'):
    """双序列比对"""
    try:
        aligner = Align.PairwiseAligner()
        alignments = aligner.align(seq1, seq2)
        
        result = {
            "status": "success",
            "n_alignments": len(list(alignments)),
            "best_score": alignments[0].score,
            "best_alignment": str(alignments[0])
        }
        
        with open(output, 'w') as f:
            f.write(str(alignments[0]))
        
        result["output"] = output
        return result
    except Exception as e:
        return {"error": str(e)}


def multiple_align(fasta_file, output='msa.fasta'):
    """多序列比对"""
    try:
        from Bio import AlignIO
        
        # 使用 muscle 或 clustalo
        cmd = f"muscle -in {fasta_file} -out {output}"
        result = subprocess.run(cmd, shell=True, capture_output=True)
        
        if result.returncode != 0:
            # 回退到 Bioython 内置方法
            records = list(SeqIO.parse(fasta_file, 'fasta'))
            from Bio.Align.Applications import MuscleCommandline
            muscle_cline = MuscleCommandline(input=fasta_file, out=output)
            stdout, stderr = muscle_cline()
        
        # 读取结果
        alignments = AlignIO.read(output, 'fasta')
        
        return {
            "status": "success",
            "n_sequences": len(alignments),
            "output": output
        }
    except Exception as e:
        return {"error": str(e)}


def homolog_search(seq_file, database='pdb', output='homologs.csv'):
    """同源搜索"""
    try:
        # 使用 mmseqs2 或 blast
        cmd = f"mmseqs easy-search {seq_file} {database} {output} --format-output 'query,target,fident,alnlen,mismatch,gapopen,qstart,qend,tstart,tend,evalue,bits'"
        
        result = subprocess.run(cmd, shell=True, capture_output=True, timeout=300)
        
        if result.returncode == 0:
            # 解析结果
            lines = result.stdout.strip().split('\n')
            homologs = []
            for line in lines[1:min(11, len(lines))]:  # 取前10个
                parts = line.split('\t')
                if len(parts) >= 11:
                    homologs.append({
                        "target": parts[1],
                        "identity": float(parts[2]),
                        "aln_len": int(parts[3]),
                        "evalue": parts[10],
                        "bitscore": float(parts[11])
                    })
            
            return {
                "status": "success",
                "n_homologs": len(homologs),
                "top_homologs": homologs,
                "output": output
            }
        else:
            return {
                "error": "同源搜索失败，请安装 mmseqs2",
                "hint": "conda install -c bioconda mmseqs2"
            }
    except subprocess.TimeoutExpired:
        return {"error": "搜索超时"}
    except Exception as e:
        return {"error": str(e)}


def predict_structure(seq, output_dir='structures'):
    """蛋白质结构预测（调用 AlphaFold）"""
    try:
        Path(output_dir).mkdir(exist_ok=True)
        
        # 检查是否有 alphafold
        af_check = subprocess.run("which alphafold", shell=True, capture_output=True)
        
        if af_check.returncode == 0:
            cmd = f"alphafold --sequence {seq} --output_dir {output_dir}"
            result = subprocess.run(cmd, shell=True, capture_output=True, timeout=3600)
            
            if result.returncode == 0:
                return {
                    "status": "success",
                    "method": "AlphaFold",
                    "output_dir": output_dir
                }
        
        # 回退到在线 API 建议
        return {
            "status": "success",
            "method": "online",
            "suggestion": "推荐使用以下在线工具:",
            "tools": [
                "ColabFold: https://colab.research.google.com",
                "AlphaFold Server: https://alphafold.ebi.ac.uk",
                "ESMFold: https://esmatlas.com"
            ],
            "input_required": "将序列保存为 FASTA 文件"
        }
    except Exception as e:
        return {"error": str(e)}


def visualize_structure(pdb_file, save_path='structure.png'):
    """结构可视化"""
    try:
        import matplotlib.pyplot as plt
        from Bio.PDB import PDBParser
        
        parser = PDBParser()
        structure = parser.get_structure('protein', pdb_file)
        
        # 简单 2D 可视化
        fig = plt.figure(figsize=(10, 8))
        ax = fig.add_subplot(111, projection='3d')
        
        atoms = list(structure.get_atoms())
        coords = [atom.get_coord() for atom in atoms[:1000]]  # 限制数量
        
        xs, ys, zs = zip(*coords)
        ax.scatter(xs, ys, zs, s=1, c='blue', alpha=0.5)
        
        ax.set_xlabel('X')
        ax.set_ylabel('Y')
        ax.set_zlabel('Z')
        ax.set_title('Protein Structure')
        
        plt.savefig(save_path, dpi=150)
        plt.close()
        
        return {
            "status": "success",
            "plot_path": save_path,
            "n_atoms": len(atoms)
        }
    except ImportError:
        return {"error": "请安装 matplotlib"}
    except Exception as e:
        return {"error": str(e)}


def protein_properties(seq):
    """蛋白质性质分析"""
    try:
        from Bio.SeqUtils.ProtParam import ProteinAnalysis
        
        analysis = ProteinAnalysis(seq)
        
        # 分子量
        mw = analysis.molecular_weight()
        
        # 等电点
        pI = analysis.isoelectric_point()
        
        # 氨基酸组成
        aa_comp = analysis.get_amino_acids_percent()
        
        # 疏水性
        hydrophobicity = analysis.gravy()
        
        # 二级结构预测
        sec_struct = analysis.secondary_structure_prediction()
        
        return {
            "status": "success",
            "length": len(seq),
            "molecular_weight": round(mw, 2),
            "isoelectric_point": round(pI, 2),
            "hydrophobicity": round(hydrophobicity, 3),
            "amino_acid_composition": {k: round(v, 4) for k, v in aa_comp.items()},
            "secondary_structure": {
                "helix": sec_struct[0],
                "turn": sec_struct[1],
                "sheet": sec_struct[2]
            }
        }
    except Exception as e:
        return {"error": str(e)}


def drug_docking(receptor_pdb, ligand_pdb, output='docking_results'):
    """分子对接（调用 AutoDock Vina）"""
    try:
        # 检查 vina
        vina_check = subprocess.run("which vina", shell=True, capture_output=True)
        
        if vina_check.returncode != 0:
            return {
                "error": "AutoDock Vina 未安装",
                "suggestion": "conda install -c bioconda vina"
            }
        
        # 简化版对接命令
        cmd = f"vina --receptor {receptor_pdb} --ligand {ligand_pdb} --out {output}.pdbqt --log {output}.log"
        result = subprocess.run(cmd, shell=True, capture_output=True, timeout=300)
        
        if result.returncode == 0:
            return {
                "status": "success",
                "method": "AutoDock Vina",
                "output": f"{output}.pdbqt",
                "log": f"{output}.log"
            }
        
        return {"error": result.stderr[-500:] if result.stderr else "对接失败"}
    except Exception as e:
        return {"error": str(e)}


def main():
    parser = argparse.ArgumentParser(description='蛋白质工具')
    parser.add_argument('action', nargs='?', default='info',
                        choices=['align', 'msa', 'search', 'fold', 'visualize', 'properties', 'dock', 'info'],
                        help='操作类型')
    parser.add_argument('--seq', help='蛋白质序列')
    parser.add_argument('--seq2', help='第二条序列')
    parser.add_argument('--fasta', help='FASTA 文件')
    parser.add_argument('--pdb', help='PDB 文件')
    parser.add_argument('--receptor', help='受体蛋白')
    parser.add_argument('--ligand', help='配体分子')
    parser.add_argument('--database', default='pdb', help='搜索数据库')
    parser.add_argument('--output', help='输出路径')
    parser.add_argument('--save', help='图片保存路径')
    
    args = parser.parse_args()
    
    result = None
    
    if args.action == 'align':
        result = sequence_align(args.seq, args.seq2, args.output or 'alignment.txt')
    elif args.action == 'msa':
        result = multiple_align(args.fasta, args.output or 'msa.fasta')
    elif args.action == 'search':
        result = homolog_search(args.fasta or args.seq, args.database, args.output or 'homologs.csv')
    elif args.action == 'fold':
        result = predict_structure(args.seq or args.fasta, args.output or 'structures')
    elif args.action == 'visualize':
        result = visualize_structure(args.pdb, args.save or 'structure.png')
    elif args.action == 'properties':
        result = protein_properties(args.seq)
    elif args.action == 'dock':
        result = drug_docking(args.receptor, args.ligand, args.output or 'docking')
    
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
