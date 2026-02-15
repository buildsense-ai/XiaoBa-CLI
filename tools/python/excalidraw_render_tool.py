"""
Excalidraw 渲染工具 - 通过 Kroki API 将 Excalidraw JSON 渲染为 SVG/PNG 图片
"""

import sys
import os
import json
import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from utils.base_tool import BaseTool
from typing import Dict, Any


class ExcalidrawRenderTool(BaseTool):
    """将 Excalidraw JSON 渲染为图片文件"""

    KROKI_BASE_URL = os.environ.get('KROKI_BASE_URL', 'https://kroki.io')

    def execute(self, params: Dict[str, Any]) -> Dict[str, Any]:
        self.validate_params(params, ['json_content', 'output_path'])

        json_content = params['json_content']
        output_path = params['output_path']
        fmt = params.get('format', 'svg')

        # 解析 JSON
        if isinstance(json_content, str):
            parsed = json.loads(json_content)
        else:
            parsed = json_content

        if not isinstance(parsed.get('elements'), list):
            raise ValueError('JSON 缺少 elements 数组，不是合法的 Excalidraw 格式')

        # 补全必要字段
        parsed.setdefault('type', 'excalidraw')
        parsed.setdefault('version', 2)
        parsed.setdefault('source', 'xiaoba')
        parsed.setdefault('appState', {
            'viewBackgroundColor': '#ffffff',
            'exportWithDarkMode': False,
            'exportBackground': True,
        })
        parsed.setdefault('files', {})

        # 创建输出目录
        out_dir = os.path.dirname(os.path.abspath(output_path))
        os.makedirs(out_dir, exist_ok=True)

        # 调用 Kroki API
        url = f'{self.KROKI_BASE_URL}/excalidraw/{fmt}'
        print(f'[excalidraw_render] 渲染 {len(parsed["elements"])} 个元素 → {fmt}', file=sys.stderr)

        resp = requests.post(
            url,
            data=json.dumps(parsed),
            headers={'Content-Type': 'text/plain'},
            timeout=30,
        )
        resp.raise_for_status()

        # 写入文件
        mode = 'wb' if fmt == 'png' else 'w'
        content = resp.content if fmt == 'png' else resp.text
        with open(output_path, mode) as f:
            f.write(content)

        size_kb = os.path.getsize(output_path) / 1024
        abs_path = os.path.abspath(output_path)

        print(f'[excalidraw_render] ✓ 已保存: {abs_path} ({size_kb:.1f} KB)', file=sys.stderr)

        return {
            'file_path': abs_path,
            'format': fmt,
            'size_kb': round(size_kb, 1),
            'element_count': len(parsed['elements']),
            'message': f'图片已渲染并保存到: {abs_path}',
        }


if __name__ == '__main__':
    tool = ExcalidrawRenderTool()
    tool.run()
