"""
Paper Detail Tool - 论文详情工具
基于 Semantic Scholar API，提供论文详情、引用、参考文献、推荐等功能
"""

from base_tool import BaseTool
from typing import Dict, Any, List, Optional
import requests
import time


S2_API_BASE = "https://api.semanticscholar.org/graph/v1"
S2_RECOMMEND_BASE = "https://api.semanticscholar.org/recommendations/v1"
S2_PAPER_FIELDS = "paperId,title,abstract,authors,year,citationCount,url,openAccessPdf,venue,fieldsOfStudy"
S2_DETAIL_FIELDS = "paperId,title,abstract,authors,year,citationCount,referenceCount,url,openAccessPdf,venue,fieldsOfStudy,publicationTypes,tldr"


class PaperDetailTool(BaseTool):
    """论文详情工具 - 获取详情、引用、参考文献、推荐"""

    tool_name = "paper_detail"
    tool_description = "获取论文详情、引用列表、参考文献列表、相似论文推荐。基于 Semantic Scholar API。"
    tool_parameters = {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "description": "操作类型",
                "enum": ["detail", "citations", "references", "recommend"]
            },
            "paper_id": {
                "type": "string",
                "description": "Semantic Scholar 论文 ID"
            },
            "limit": {
                "type": "number",
                "description": "返回结果数量上限（最大 100）",
                "default": 20
            }
        },
        "required": ["action", "paper_id"]
    }
    tool_timeout = 30

    def execute(self, params: Dict[str, Any]) -> Dict[str, Any]:
        self.validate_params(params, ['action'])

        action = params['action']
        if action == 'detail':
            return self._get_detail(params)
        elif action == 'citations':
            return self._get_citations(params)
        elif action == 'references':
            return self._get_references(params)
        elif action == 'recommend':
            return self._get_recommendations(params)
        else:
            raise ValueError(f"不支持的操作: {action}，可选: detail, citations, references, recommend")

    @staticmethod
    def _s2_get(url: str, params: Dict[str, Any], max_retries: int = 3) -> Dict[str, Any]:
        """带重试的 Semantic Scholar API GET 请求"""
        for attempt in range(max_retries):
            resp = requests.get(url, params=params, timeout=15)
            if resp.status_code == 429:
                time.sleep(2 ** attempt)
                continue
            resp.raise_for_status()
            return resp.json()
        raise Exception("Semantic Scholar API 请求频率受限，请稍后重试")

    def _get_detail(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """获取论文详情"""
        self.validate_params(params, ['paper_id'])
        paper_id = params['paper_id']

        item = self._s2_get(
            f"{S2_API_BASE}/paper/{paper_id}",
            {'fields': S2_DETAIL_FIELDS}
        )

        return {'paper': self._normalize_paper(item, detail=True)}

    def _get_citations(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """获取引用该论文的论文列表"""
        self.validate_params(params, ['paper_id'])
        paper_id = params['paper_id']
        limit = min(params.get('limit', 20), 100)

        data = self._s2_get(
            f"{S2_API_BASE}/paper/{paper_id}/citations",
            {'fields': S2_PAPER_FIELDS, 'limit': limit}
        )

        papers = []
        for entry in data.get('data', []):
            citing = entry.get('citingPaper', {})
            if citing.get('paperId'):
                papers.append(self._normalize_paper(citing))
        return {'citations': papers, 'total': len(papers)}

    def _get_references(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """获取该论文引用的论文列表"""
        self.validate_params(params, ['paper_id'])
        paper_id = params['paper_id']
        limit = min(params.get('limit', 20), 100)

        data = self._s2_get(
            f"{S2_API_BASE}/paper/{paper_id}/references",
            {'fields': S2_PAPER_FIELDS, 'limit': limit}
        )

        papers = []
        for entry in data.get('data', []):
            cited = entry.get('citedPaper', {})
            if cited.get('paperId'):
                papers.append(self._normalize_paper(cited))
        return {'references': papers, 'total': len(papers)}

    def _get_recommendations(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """获取推荐的相似论文"""
        self.validate_params(params, ['paper_id'])
        paper_id = params['paper_id']
        limit = min(params.get('limit', 10), 100)

        data = self._s2_get(
            f"{S2_RECOMMEND_BASE}/papers/forpaper/{paper_id}",
            {'fields': S2_PAPER_FIELDS, 'limit': limit, 'from': 'recent'}
        )

        papers = []
        for item in data.get('recommendedPapers', []):
            if item.get('paperId'):
                papers.append(self._normalize_paper(item))
        return {'recommendations': papers, 'total': len(papers)}

    @staticmethod
    def _normalize_paper(item: Dict[str, Any], detail: bool = False) -> Dict[str, Any]:
        """标准化论文数据"""
        authors = item.get('authors') or []
        pdf_info = item.get('openAccessPdf') or {}
        result = {
            'paperId': item.get('paperId'),
            'title': item.get('title'),
            'authors': [a.get('name', '') for a in authors],
            'abstract': (item.get('abstract') or '')[:500],
            'year': item.get('year'),
            'citationCount': item.get('citationCount'),
            'url': item.get('url'),
            'pdfUrl': pdf_info.get('url'),
            'venue': item.get('venue'),
            'fieldsOfStudy': item.get('fieldsOfStudy') or [],
        }
        if detail:
            result['referenceCount'] = item.get('referenceCount')
            tldr = item.get('tldr')
            result['tldr'] = tldr.get('text') if tldr else None
        return result


if __name__ == '__main__':
    tool = PaperDetailTool()
    tool.run()
