"""
Search Tool - 文献搜索工具
支持 Semantic Scholar、arXiv 数据源
"""

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from utils.base_tool import BaseTool
from typing import Dict, Any, List, Optional
import requests
import time


# Semantic Scholar API 基础地址
S2_API_BASE = "https://api.semanticscholar.org/graph/v1"
S2_RECOMMEND_BASE = "https://api.semanticscholar.org/recommendations/v1"
# 请求的字段
S2_PAPER_FIELDS = "paperId,title,abstract,authors,year,citationCount,url,openAccessPdf,publicationTypes,fieldsOfStudy,venue"


class SearchTool(BaseTool):
    """文献搜索工具"""

    def execute(self, params: Dict[str, Any]) -> Dict[str, Any]:
        self.validate_params(params, ['query'])

        query = params['query']
        source = params.get('source', 'semantic_scholar')
        limit = min(params.get('limit', 10), 100)
        year_from = params.get('year_from')

        if source == 'semantic_scholar':
            papers = self._search_semantic_scholar(query, limit, year_from)
        elif source == 'arxiv':
            papers = self._search_arxiv(query, limit, year_from)
        else:
            raise ValueError(f"不支持的数据源: {source}，可选: semantic_scholar, arxiv")

        return {
            'papers': papers,
            'total': len(papers),
            'source': source,
            'query': query
        }

    @staticmethod
    def _s2_get(url: str, params: Dict[str, Any], max_retries: int = 3) -> Dict[str, Any]:
        """带重试的 Semantic Scholar API GET 请求"""
        for attempt in range(max_retries):
            resp = requests.get(url, params=params, timeout=15)
            if resp.status_code == 429:
                wait = 2 ** attempt
                time.sleep(wait)
                continue
            resp.raise_for_status()
            return resp.json()
        raise Exception("Semantic Scholar API 请求频率受限，请稍后重试")

    def _search_semantic_scholar(self, query: str, limit: int, year_from: Optional[int] = None) -> List[Dict[str, Any]]:
        """通过 Semantic Scholar API 搜索论文"""
        params: Dict[str, Any] = {
            'query': query,
            'limit': limit,
            'fields': S2_PAPER_FIELDS,
        }
        if year_from:
            params['year'] = f"{year_from}-"

        data = self._s2_get(f"{S2_API_BASE}/paper/search", params)

        papers = []
        for item in data.get('data', []):
            papers.append(self._normalize_s2_paper(item))
        return papers

    def _search_arxiv(self, query: str, limit: int, year_from: Optional[int] = None) -> List[Dict[str, Any]]:
        """通过 arxiv 库搜索论文"""
        import arxiv

        client = arxiv.Client()
        search = arxiv.Search(
            query=query,
            max_results=limit,
            sort_by=arxiv.SortCriterion.Relevance
        )

        papers = []
        for result in client.results(search):
            year = result.published.year if result.published else None
            if year_from and year and year < year_from:
                continue
            papers.append({
                'paperId': result.entry_id,
                'title': result.title,
                'authors': [a.name for a in result.authors],
                'abstract': (result.summary or '')[:500],
                'year': year,
                'citationCount': None,
                'url': result.entry_id,
                'pdfUrl': result.pdf_url,
                'venue': 'arXiv',
                'fieldsOfStudy': list(result.categories) if hasattr(result, 'categories') else [],
                'source': 'arxiv'
            })
        return papers

    @staticmethod
    def _normalize_s2_paper(item: Dict[str, Any]) -> Dict[str, Any]:
        """将 Semantic Scholar 返回的论文标准化"""
        authors = item.get('authors') or []
        pdf_info = item.get('openAccessPdf') or {}
        return {
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
            'source': 'semantic_scholar'
        }


if __name__ == '__main__':
    tool = SearchTool()
    tool.run()
