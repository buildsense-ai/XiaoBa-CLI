---
name: academic-search
description: "学术论文搜索：通过 Semantic Scholar / arXiv 搜索论文、获取论文详情、引用关系和推荐。"
---

# 学术论文搜索

通过 Semantic Scholar 和 arXiv API 搜索和查询学术论文。

## 可用脚本

本 skill 包含以下 Python 工具脚本：

### 1. search_papers_tool.py - 搜索论文

**调用方式**:
```bash
python3 skills/_tool-skills/academic-search/search_papers_tool.py '{"query":"关键词","source":"semantic_scholar","limit":20}'
```

**参数**:
- `query` (必需): 搜索关键词
- `source` (可选): 数据源，`semantic_scholar` 或 `arxiv`，默认 `semantic_scholar`
- `limit` (可选): 返回数量，默认 20

**返回**: JSON 格式的论文列表

### 2. paper_detail_tool.py - 获取论文详情

**调用方式**:
```bash
# 获取论文详情
python3 skills/_tool-skills/academic-search/paper_detail_tool.py '{"action":"detail","paper_id":"<paperId>"}'

# 获取引用
python3 skills/_tool-skills/academic-search/paper_detail_tool.py '{"action":"citations","paper_id":"<paperId>","limit":20}'

# 获取参考文献
python3 skills/_tool-skills/academic-search/paper_detail_tool.py '{"action":"references","paper_id":"<paperId>","limit":20}'

# 获取推荐论文
python3 skills/_tool-skills/academic-search/paper_detail_tool.py '{"action":"recommend","paper_id":"<paperId>","limit":10}'
```

**参数**:
- `action` (必需): 操作类型，`detail` / `citations` / `references` / `recommend`
- `paper_id` (必需): 论文 ID
- `limit` (可选): 返回数量

## 工作流程

1. 用户提供搜索关键词或论文 ID
2. 使用 bash 工具调用相应的 Python 脚本
3. 解析 JSON 返回结果
4. 向用户展示论文信息

## 示例

用户: "搜索关于 transformer 的论文"

你:
1. 调用 `bash python3 skills/_tool-skills/academic-search/search_papers_tool.py '{"query":"transformer","limit":10}'`
2. 解析返回的论文列表
3. 向用户展示标题、作者、摘要、引用数等信息
