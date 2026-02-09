#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
PDF 章节分割工具
将 PDF 按章节分割成多个 Markdown 文件
"""

import json
import sys
import os
import re
from typing import List, Dict, Tuple


def extract_text_from_pdf(pdf_path: str) -> str:
    """使用 pdf-parse 提取 PDF 文本（通过 Node.js）"""
    try:
        import subprocess

        # 创建临时 Node.js 脚本
        node_script = """
        const fs = require('fs');
        const pdf = require('pdf-parse');

        async function extract() {
            const dataBuffer = fs.readFileSync(process.argv[1]);
            const data = await pdf(dataBuffer);
            console.log(data.text);
        }

        extract().catch(err => {
            console.error('Error:', err.message);
            process.exit(1);
        });
        """

        # 写入临时脚本
        script_path = 'temp_pdf_extract.js'
        with open(script_path, 'w', encoding='utf-8') as f:
            f.write(node_script)

        # 执行脚本
        result = subprocess.run(
            ['node', script_path, pdf_path],
            capture_output=True,
            text=True,
            encoding='utf-8'
        )

        # 清理临时文件
        if os.path.exists(script_path):
            os.remove(script_path)

        if result.returncode != 0:
            raise Exception(f"PDF 提取失败: {result.stderr}")

        return result.stdout

    except Exception as e:
        raise Exception(f"PDF 文本提取失败: {str(e)}")


def identify_sections(text: str) -> List[Dict[str, any]]:
    """识别文本中的章节"""
    sections = []

    # 常见的学术论文章节标题模式
    patterns = [
        # 标准章节标题（带编号或不带）
        (r'(?:^|\n)\s*(?:\d+\.?\s+)?Abstract\s*(?:\n|$)', 'Abstract'),
        (r'(?:^|\n)\s*(?:\d+\.?\s+)?Introduction\s*(?:\n|$)', 'Introduction'),
        (r'(?:^|\n)\s*(?:\d+\.?\s+)?(?:Materials?\s+and\s+)?Methods?\s*(?:\n|$)', 'Methods'),
        (r'(?:^|\n)\s*(?:\d+\.?\s+)?(?:Experimental\s+)?Results?\s*(?:\n|$)', 'Results'),
        (r'(?:^|\n)\s*(?:\d+\.?\s+)?Discussion\s*(?:\n|$)', 'Discussion'),
        (r'(?:^|\n)\s*(?:\d+\.?\s+)?Conclusion\s*(?:\n|$)', 'Conclusion'),
        (r'(?:^|\n)\s*(?:\d+\.?\s+)?References?\s*(?:\n|$)', 'References'),
        (r'(?:^|\n)\s*(?:\d+\.?\s+)?Acknowledgments?\s*(?:\n|$)', 'Acknowledgments'),
        (r'(?:^|\n)\s*(?:\d+\.?\s+)?Appendix\s*(?:\n|$)', 'Appendix'),
    ]

    # 查找所有章节位置
    positions = []
    for pattern, title in patterns:
        for match in re.finditer(pattern, text, re.IGNORECASE):
            positions.append({
                'title': title,
                'start': match.end(),
                'match_text': match.group(0).strip()
            })

    # 按位置排序
    positions.sort(key=lambda x: x['start'])

    # 提取每个章节的内容
    for i, pos in enumerate(positions):
        # 确定章节结束位置
        end_pos = positions[i + 1]['start'] if i < len(positions) - 1 else len(text)

        # 提取内容
        content = text[pos['start']:end_pos].strip()

        sections.append({
            'title': pos['title'],
            'content': content,
            'start': pos['start'],
            'end': end_pos
        })

    return sections


def clean_text(text: str) -> str:
    """清理文本，移除多余的空白"""
    # 移除多余的空行
    text = re.sub(r'\n\s*\n\s*\n+', '\n\n', text)
    # 移除行首行尾空白
    lines = [line.strip() for line in text.split('\n')]
    return '\n'.join(lines)


def save_sections_as_markdown(sections: List[Dict], output_dir: str, pdf_name: str) -> List[str]:
    """将章节保存为 Markdown 文件"""
    # 创建输出目录
    if not os.path.exists(output_dir):
        os.makedirs(output_dir)

    saved_files = []

    for i, section in enumerate(sections):
        # 生成文件名
        title_slug = section['title'].lower().replace(' ', '_')
        filename = f"{i+1:02d}_{title_slug}.md"
        filepath = os.path.join(output_dir, filename)

        # 准备 Markdown 内容
        md_content = f"# {section['title']}\n\n"
        md_content += f"> 来源: {pdf_name}\n\n"
        md_content += "---\n\n"
        md_content += clean_text(section['content'])

        # 写入文件
        with open(filepath, 'w', encoding='utf-8') as f:
            f.write(md_content)

        saved_files.append(filepath)

    return saved_files


def split_pdf_to_markdown(pdf_path: str, output_dir: str = None) -> Dict:
    """主函数：将 PDF 分割为多个 Markdown 文件"""
    try:
        # 检查文件是否存在
        if not os.path.exists(pdf_path):
            raise FileNotFoundError(f"文件不存在: {pdf_path}")

        # 确定输出目录
        if output_dir is None:
            pdf_basename = os.path.splitext(os.path.basename(pdf_path))[0]
            output_dir = f"output_{pdf_basename}"

        # 1. 提取 PDF 文本
        print(f"正在提取 PDF 文本: {pdf_path}", file=sys.stderr)
        text = extract_text_from_pdf(pdf_path)

        if not text or len(text) < 100:
            raise Exception("PDF 文本提取失败或内容过少")

        # 2. 识别章节
        print(f"正在识别章节...", file=sys.stderr)
        sections = identify_sections(text)

        if not sections:
            raise Exception("未能识别到任何章节")

        # 3. 保存为 Markdown 文件
        print(f"正在保存章节到: {output_dir}", file=sys.stderr)
        saved_files = save_sections_as_markdown(
            sections,
            output_dir,
            os.path.basename(pdf_path)
        )

        return {
            'success': True,
            'pdf_path': pdf_path,
            'output_dir': output_dir,
            'sections_count': len(sections),
            'sections': [
                {
                    'title': s['title'],
                    'length': len(s['content']),
                    'file': saved_files[i]
                }
                for i, s in enumerate(sections)
            ],
            'saved_files': saved_files
        }

    except Exception as e:
        return {
            'success': False,
            'error': str(e)
        }


def main():
    """命令行入口"""
    try:
        if len(sys.argv) < 2:
            print(json.dumps({
                "success": False,
                "error": "缺少参数: 需要 pdf_path"
            }))
            sys.exit(1)

        # 解析参数
        args = json.loads(sys.argv[1])
        pdf_path = args.get("pdf_path")
        output_dir = args.get("output_dir")

        if not pdf_path:
            print(json.dumps({
                "success": False,
                "error": "缺少参数: pdf_path"
            }))
            sys.exit(1)

        # 执行分割
        result = split_pdf_to_markdown(pdf_path, output_dir)

        # 输出结果
        print(json.dumps(result, ensure_ascii=False, indent=2))

    except Exception as e:
        print(json.dumps({
            "success": False,
            "error": f"执行失败: {str(e)}"
        }))
        sys.exit(1)


if __name__ == "__main__":
    main()
