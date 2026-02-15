#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SCI 论文解析工具 - 使用 MinerU
基于 MinerU API 进行专业的学术论文解析
"""

import json
import sys
import os
import time
import zipfile
import requests
from typing import Dict, List
from urllib.parse import quote

# 加载 .env 文件
try:
    from dotenv import load_dotenv
    # 查找项目根目录的 .env 文件
    current_dir = os.path.dirname(os.path.abspath(__file__))
    project_root = os.path.dirname(os.path.dirname(current_dir))
    env_path = os.path.join(project_root, '.env')
    if os.path.exists(env_path):
        load_dotenv(env_path)
        sys.stderr.write(f"[MinerU] 已加载环境变量: {env_path}\n")
        sys.stderr.flush()
except ImportError:
    sys.stderr.write(f"[MinerU] 警告: 未安装 python-dotenv，跳过 .env 加载\n")
    sys.stderr.flush()

class MinerUPDFParser:
    """使用 MinerU 解析 PDF 论文"""

    def __init__(self):
        # 从环境变量读取配置（安全默认：不提供弱默认值）
        self.minio_endpoint = os.getenv("MINIO_ENDPOINT")
        self.minio_access_key = os.getenv("MINIO_ACCESS_KEY")
        self.minio_secret_key = os.getenv("MINIO_SECRET_KEY")
        self.minio_bucket = os.getenv("MINIO_BUCKET")
        self.mineru_token = os.getenv("MINERU_TOKEN")
        self.mineru_base_url = "https://mineru.net/api/v4/extract/task"

        missing = []
        if not self.minio_endpoint:
            missing.append("MINIO_ENDPOINT")
        if not self.minio_access_key:
            missing.append("MINIO_ACCESS_KEY")
        if not self.minio_secret_key:
            missing.append("MINIO_SECRET_KEY")
        if not self.minio_bucket:
            missing.append("MINIO_BUCKET")
        if not self.mineru_token:
            missing.append("MINERU_TOKEN")
        if missing:
            raise ValueError(f"缺少环境变量: {', '.join(missing)}")

    def upload_to_minio(self, pdf_path: str) -> str:
        """上传 PDF 到 MinIO"""
        sys.stderr.write(f"[MinerU] 步骤1: 上传 PDF 到 MinIO...\n")
        sys.stderr.flush()

        try:
            from minio import Minio
        except ImportError:
            raise ImportError("缺少依赖：请安装 minio (pip install minio)")

        client = Minio(
            self.minio_endpoint,
            access_key=self.minio_access_key,
            secret_key=self.minio_secret_key,
            secure=False
        )

        # 确保 bucket 存在
        if not client.bucket_exists(self.minio_bucket):
            sys.stderr.write(f"[MinerU] 创建 bucket: {self.minio_bucket}\n")
            sys.stderr.flush()
            client.make_bucket(self.minio_bucket)

        # 上传文件
        filename = os.path.basename(pdf_path)
        object_name = f"uploaded/{int(time.time())}_{filename}"

        client.fput_object(
            self.minio_bucket,
            object_name,
            pdf_path,
            content_type='application/pdf'
        )

        # 生成 URL
        minio_url = f"http://{self.minio_endpoint}/{self.minio_bucket}/{quote(object_name)}"
        sys.stderr.write(f"[MinerU] 上传成功: {filename}\n")
        sys.stderr.flush()
        return minio_url

    def submit_task(self, minio_url: str) -> str:
        """提交解析任务到 MinerU"""
        sys.stderr.write(f"[MinerU] 步骤2: 提交解析任务到 MinerU API...\n")
        sys.stderr.flush()

        headers = {
            'Content-Type': 'application/json',
            'Authorization': f'Bearer {self.mineru_token}'
        }
        data = {
            'url': minio_url,
            'is_ocr': True,
            'enable_formula': False,
        }

        # 重试机制
        for attempt in range(3):
            try:
                response = requests.post(
                    self.mineru_base_url,
                    headers=headers,
                    json=data,
                    timeout=(10, 30)
                )
                response.raise_for_status()
                break
            except Exception as e:
                if attempt < 2:
                    sys.stderr.write(f"[MinerU] 提交失败 (尝试 {attempt+1}/3): {str(e)}, 5秒后重试...\n")
                    sys.stderr.flush()
                    time.sleep(5)
                else:
                    raise Exception(f"提交任务失败: {str(e)}")

        result = response.json()
        data = result.get("data", {})
        task_id = data.get("task_id") if isinstance(data, dict) else data

        sys.stderr.write(f"[MinerU] 任务提交成功 (任务ID: {task_id})\n")
        sys.stderr.flush()

        return task_id

    def wait_for_result(self, task_id: str, max_wait: int = 600) -> str:
        """等待解析完成并下载结果"""
        url = f"{self.mineru_base_url}/{task_id}"
        headers = {
            'Content-Type': 'application/json',
            'Authorization': f'Bearer {self.mineru_token}'
        }

        start_time = time.time()
        check_count = 0

        sys.stderr.write(f"[MinerU] 等待解析完成 (任务ID: {task_id})...\n")
        sys.stderr.flush()

        while time.time() - start_time < max_wait:
            check_count += 1
            elapsed = int(time.time() - start_time)

            try:
                response = requests.get(url, headers=headers, timeout=30)
                response.raise_for_status()
            except Exception as e:
                sys.stderr.write(f"[MinerU] 检查 #{check_count} 失败: {str(e)} (已等待 {elapsed}秒)\n")
                sys.stderr.flush()
                time.sleep(10)
                continue

            result = response.json()
            task_data = result.get("data", )
            state = task_data.get("status") or task_data.get("state")

            sys.stderr.write(f"[MinerU] 检查 #{check_count}: 状态={state} (已等待 {elapsed}秒)\n")
            sys.stderr.flush()

            if state in ["completed", "done", "success"]:
                # 获取下载链接
                zip_url = (task_data.get("download_url") or
                          task_data.get("full_zip_url") or
                          task_data.get("result_url"))

                if zip_url:
                    sys.stderr.write(f"[MinerU] 解析完成！开始下载结果...\n")
                    sys.stderr.flush()
                    return self.download_and_extract(zip_url)
                else:
                    raise Exception("未找到下载链接")

            elif state in ["failed", "error"]:
                error_msg = task_data.get('message', '未知错误')
                sys.stderr.write(f"[MinerU] 解析失败: {error_msg}\n")
                sys.stderr.flush()
                raise Exception(f"解析失败: {error_msg}")

            time.sleep(10)

        raise TimeoutError(f"任务超时({max_wait}秒)")

    def download_and_extract(self, zip_url: str) -> str:
        """下载并解压结果"""
        sys.stderr.write(f"[MinerU] 步骤4: 下载解析结果...\n")
        sys.stderr.flush()

        # 确保 extracted 目录存在
        base_dir = "extracted"
        if not os.path.exists(base_dir):
            os.makedirs(base_dir)
            sys.stderr.write(f"[MinerU] 创建目录: {base_dir}\n")
            sys.stderr.flush()

        # 下载 ZIP
        response = requests.get(zip_url, timeout=60)
        response.raise_for_status()

        zip_filename = os.path.join(base_dir, f"temp_{int(time.time())}.zip")
        with open(zip_filename, 'wb') as f:
            f.write(response.content)

        sys.stderr.write(f"[MinerU] 下载完成，开始解压...\n")
        sys.stderr.flush()

        # 解压到 extracted 目录下
        extract_dir = os.path.join(base_dir, f"pdf_{int(time.time())}")
        with zipfile.ZipFile(zip_filename, 'r') as zip_ref:
            zip_ref.extractall(extract_dir)

        os.remove(zip_filename)

        sys.stderr.write(f"[MinerU] 解压完成: {extract_dir}\n")
        sys.stderr.flush()

        return extract_dir

    def parse_content(self, extract_dir: str) -> Dict:
        """解析提取的内容"""
        sys.stderr.write(f"[MinerU] 步骤5: 解析提取的内容...\n")
        sys.stderr.flush()

        # 查找 content_list.json
        content_file = None
        for file in os.listdir(extract_dir):
            if file.endswith("_content_list.json"):
                content_file = os.path.join(extract_dir, file)
                break

        if not content_file:
            old_file = os.path.join(extract_dir, "_content_list.json")
            if os.path.exists(old_file):
                content_file = old_file
            else:
                raise FileNotFoundError("未找到 content_list.json")

        sys.stderr.write(f"[MinerU] 找到内容文件: {os.path.basename(content_file)}\n")
        sys.stderr.flush()

        with open(content_file, 'r', encoding='utf-8') as f:
            content_list = json.load(f)

        sys.stderr.write(f"[MinerU] 解析内容项: {len(content_list)} 项\n")
        sys.stderr.flush()

        # 按页面聚合
        pages_dict = {}

        for item in content_list:
            page_idx = item.get('page_idx', 0)

            if page_idx not in pages_dict:
                pages_dict[page_idx] = {
                    'page_number': page_idx,
                    'text': '',
                    'images': []
                }

            item_type = item.get('type', '')

            if item_type == 'text':
                text = item.get('text', '')
                if text.strip():
                    pages_dict[page_idx]['text'] += text + '\n'

            elif item_type in ['image', 'table', 'figure']:
                pages_dict[page_idx]['images'].append({
                    'type': item_type,
                    'caption': item.get('img_caption', []),
                    'content': item.get('text', '')
                })

        # 转换为列表
        pages = [pages_dict[idx] for idx in sorted(pages_dict.keys())]

        # 清理文本
        for page in pages:
            page['text'] = page['text'].strip()

        sys.stderr.write(f"[MinerU] 解析完成: {len(pages)} 页\n")
        sys.stderr.flush()

        return {
            'pages': pages,
            'total_pages': len(pages),
            'extract_dir': extract_dir
        }


def is_remote_url(path: str) -> bool:
    """判断是否为远程 URL"""
    return path.startswith("http://") or path.startswith("https://")


def parse_pdf_with_mineru(pdf_path: str) -> Dict:
    """使用 MinerU 解析 PDF，支持本地文件路径或远程 URL"""
    display_name = pdf_path if is_remote_url(pdf_path) else os.path.basename(pdf_path)
    sys.stderr.write(f"\n{'='*60}\n")
    sys.stderr.write(f"[MinerU] 开始解析 PDF: {display_name}\n")
    sys.stderr.write(f"{'='*60}\n\n")
    sys.stderr.flush()

    parser = MinerUPDFParser()

    # 1. 如果是远程 URL 则直接使用，否则上传到 MinIO
    if is_remote_url(pdf_path):
        sys.stderr.write(f"[MinerU] 检测到远程 URL，跳过 MinIO 上传，直接提交解析\n")
        sys.stderr.flush()
        file_url = pdf_path
    else:
        file_url = parser.upload_to_minio(pdf_path)

    # 2. 提交任务
    task_id = parser.submit_task(file_url)

    # 3. 等待结果
    sys.stderr.write(f"[MinerU] 步骤3: 等待 MinerU API 解析...\n")
    sys.stderr.flush()
    extract_dir = parser.wait_for_result(task_id)

    # 4. 解析内容
    result = parser.parse_content(extract_dir)

    # 5. 识别章节
    sys.stderr.write(f"[MinerU] 步骤6: 识别论文章节...\n")
    sys.stderr.flush()
    full_md_path = os.path.join(result['extract_dir'], "full.md")
    sections = []
    if os.path.exists(full_md_path):
        try:
            with open(full_md_path, 'r', encoding='utf-8') as f:
                full_md_text = f.read()
        except UnicodeDecodeError:
            with open(full_md_path, 'r', encoding='utf-8', errors='ignore') as f:
                full_md_text = f.read()
        sections = parse_sections_from_full_md(full_md_text)
        if sections:
            sys.stderr.write(f"[MinerU] 已从 full.md 解析章节结构\n")
            sys.stderr.flush()
        else:
            sys.stderr.write(f"[MinerU] full.md 章节解析失败，回退到纯文本识别\n")
            sys.stderr.flush()
    if not sections:
        sections = identify_sections(result['pages'])
    sys.stderr.write(f"[MinerU] 识别到 {len(sections)} 个章节\n")
    sys.stderr.flush()

    # 6. 提取元数据
    sys.stderr.write(f"[MinerU] 步骤7: 提取论文元数据...\n")
    sys.stderr.flush()
    metadata = extract_metadata(result['pages'])
    if (not metadata.get('title')) and os.path.exists(full_md_path):
        title_from_md = extract_title_from_full_md(full_md_path)
        if title_from_md:
            metadata['title'] = title_from_md
    sys.stderr.write(f"[MinerU] 标题: {metadata.get('title', 'N/A')[:50]}...\n")
    sys.stderr.flush()

    sys.stderr.write(f"\n{'='*60}\n")
    sys.stderr.write(f"[MinerU] 解析完成！\n")
    sys.stderr.write(f"{'='*60}\n\n")
    sys.stderr.flush()

    full_md_path = os.path.join(extract_dir, "full.md")
    images_dir = os.path.join(extract_dir, "images")

    return {
        'success': True,
        'file_path': pdf_path,
        'page_count': result['total_pages'],
        'title': metadata.get('title', ''),
        'abstract': metadata.get('abstract', ''),
        'sections': sections,
        'extract_dir': extract_dir,
        'full_md_path': full_md_path if os.path.exists(full_md_path) else '',
        'images_dir': images_dir if os.path.isdir(images_dir) else ''
    }


def identify_sections(pages: List[Dict]) -> List[Dict]:
    """识别论文章节"""
    import re

    # 合并所有文本
    full_text = '\n'.join(page['text'] for page in pages)

    # 章节标题模式
    patterns = [
        (r'(?:^|\n)\s*(?:\d+\.?\s+)?Abstract\s*\n', 'Abstract'),
        (r'(?:^|\n)\s*(?:\d+\.?\s+)?Introduction\s*\n', 'Introduction'),
        (r'(?:^|\n)\s*(?:\d+\.?\s+)?(?:Materials?\s+and\s+)?Methods?\s*\n', 'Methods'),
        (r'(?:^|\n)\s*(?:\d+\.?\s+)?Results?\s*\n', 'Results'),
        (r'(?:^|\n)\s*(?:\d+\.?\s+)?Discussion\s*\n', 'Discussion'),
        (r'(?:^|\n)\s*(?:\d+\.?\s+)?Conclusion\s*\n', 'Conclusion'),
        (r'(?:^|\n)\s*(?:\d+\.?\s+)?References?\s*\n', 'References'),
    ]

    sections = []
    positions = []

    for pattern, title in patterns:
        for match in re.finditer(pattern, full_text, re.IGNORECASE):
            positions.append({
                'title': title,
                'start': match.end()
            })

    # 排序
    positions.sort(key=lambda x: x['start'])

    # 提取内容
    for i, pos in enumerate(positions):
        end_pos = positions[i + 1]['start'] if i < len(positions) - 1 else len(full_text)
        content = full_text[pos['start']:end_pos].strip()

        content = truncate_content(content)

        sections.append({
            'title': pos['title'],
            'content': content
        })

    return sections


def parse_sections_from_full_md(full_text: str) -> List[Dict]:
    """
    从 full.md 解析章节结构（优先按 1./2./3. 这类一级编号聚合）

    说明：
    - MinerU 的 full.md 往往把所有标题都渲染成单个 `#`，仅靠 `#` 数量无法区分章节层级。
    - 本函数以标题中的编号层级作为“章”的边界：`2.` 是章，`2.1`/`2.2.1` 等作为章内内容保留。
    """
    import re

    lines = full_text.splitlines()
    sections = []
    current_title = None
    current_lines = []
    first_heading_seen = False

    def flush():
        nonlocal current_title, current_lines
        if not current_title:
            return
        content = '\n'.join(current_lines).strip()
        sections.append({
            'title': current_title,
            'content': truncate_content(content)
        })

    for line in lines:
        match = re.match(r'^\s*#{1,6}\s+(.+?)\s*$', line)
        if not match:
            if current_title is not None:
                current_lines.append(line)
            continue

        heading = match.group(1).strip()

        if not first_heading_seen:
            # 第一条标题通常是论文标题，不作为章节
            first_heading_seen = True
            continue

        num_match = re.match(r'^(\d+(?:\.\d+)*)(?:\.)?\s*(.*)$', heading)
        if num_match:
            number = num_match.group(1)
            is_top_level = '.' not in number
        else:
            number = ''
            is_top_level = heading.strip().lower() in ['references', 'acknowledgments', 'appendix']

        if is_top_level:
            flush()
            current_title = heading
            current_lines = []
            continue

        # 章内小节标题也保留在内容中，方便后续阅读与索引
        if current_title is not None:
            current_lines.append(line)

    flush()
    return sections


def extract_title_from_full_md(full_md_path: str) -> str:
    """从 full.md 提取论文标题（第一条一级标题）"""
    import re
    try:
        with open(full_md_path, 'r', encoding='utf-8') as f:
            for line in f:
                match = re.match(r'^\s*#\s+(.+?)\s*$', line)
                if match:
                    return match.group(1).strip()
    except Exception:
        return ''
    return ''


def truncate_content(content: str, max_len: int = 2000) -> str:
    """限制章节摘要长度，避免输出过长"""
    if len(content) > max_len:
        return content[:max_len] + "..."
    return content


def extract_metadata(pages: List[Dict]) -> Dict:
    """提取论文元数据"""
    import re

    if not pages:
        return {}

    # 从前几页提取
    first_pages_text = '\n'.join(page['text'] for page in pages[:3])

    metadata = {}

    # 提取标题（第一个非空行）
    lines = [line.strip() for line in first_pages_text.split('\n') if line.strip()]
    if lines:
        metadata['title'] = lines[0]

    # 提取摘要
    abstract_match = re.search(
        r'(?:Abstract|ABSTRACT)\s*\n(.*?)(?:\n\s*\n|\n(?:Introduction|INTRODUCTION|Keywords))',
        first_pages_text,
        re.DOTALL | re.IGNORECASE
    )

    if abstract_match:
        abstract = abstract_match.group(1).strip()
        abstract = re.sub(r'\s+', ' ', abstract)
        metadata['abstract'] = abstract

    return metadata


def main():
    """主函数"""
    try:
        if len(sys.argv) < 2:
            print(json.dumps({
                "success": False,
                "error": "缺少参数: pdf_path"
            }))
            sys.exit(1)

        args = json.loads(sys.argv[1])
        pdf_path = args.get("pdf_path")

        if not pdf_path:
            print(json.dumps({
                "success": False,
                "error": "缺少参数: pdf_path"
            }))
            sys.exit(1)

        if not is_remote_url(pdf_path) and not os.path.exists(pdf_path):
            print(json.dumps({
                "success": False,
                "error": f"文件不存在: {pdf_path}"
            }))
            sys.exit(1)

        # 解析 PDF
        result = parse_pdf_with_mineru(pdf_path)

        # 输出结果
        print(json.dumps(result, ensure_ascii=False, indent=2))

    except Exception as e:
        print(json.dumps({
            "success": False,
            "error": f"解析失败: {str(e)}"
        }))
        sys.exit(1)


if __name__ == "__main__":
    main()
