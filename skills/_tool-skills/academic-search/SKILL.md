---
name: academic-search
description: "学术论文搜索：通过 Semantic Scholar / arXiv 搜索论文、获取论文详情、引用关系和推荐。适用于查找文献、了解论文引用情况等场景。"
additional-tools: [search_papers, paper_detail]
---

# 学术论文搜索

通过 Semantic Scholar 和 arXiv API 搜索和查询学术论文。

## 可用工具

| 工具 | 用途 |
|------|------|
| `search_papers` | 按关键词搜索论文 |
| `paper_detail` | 获取论文详情、引用、被引、推荐 |

## search_papers 用法

```json
{"query": "<关键词>", "source": "semantic_scholar", "limit": 20}
```

source 可选：`semantic_scholar`（默认）、`arxiv`

## paper_detail 用法

```json
{"action": "detail", "paper_id": "<paperId>"}
{"action": "citations", "paper_id": "<paperId>", "limit": 20}
{"action": "references", "paper_id": "<paperId>", "limit": 20}
{"action": "recommend", "paper_id": "<paperId>", "limit": 10}
```
