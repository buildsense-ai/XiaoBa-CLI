# XiaoBa Python Tools

学术论文写作工具集，提供文献搜索、引用管理、文本分析等功能。

## 安装依赖

```bash
pip install -r requirements.txt
```

## 工具列表

### 1. SearchTool - 文献搜索
搜索学术论文，支持 arXiv、Google Scholar、Semantic Scholar 等数据源。

### 2. FetchTool - 内容获取
获取论文全文、摘要、元数据等信息。

### 3. CitationTool - 引用管理
管理参考文献，生成引用格式（APA、MLA、IEEE等）。

### 4. AnalysisTool - 文本分析
分析论文质量，包括可读性、学术性、结构完整性等指标。

### 5. ConvertTool - 格式转换
转换文档格式（Markdown ↔ Word ↔ PDF ↔ LaTeX）。

### 6. OutlineTool - 大纲生成
根据主题和要求生成论文大纲。

### 7. TemplateTool - 模板管理
管理和应用论文模板（会议、期刊格式）。

## 工具接口

所有工具通过标准输入接收 JSON 参数，通过标准输出返回 JSON 结果。

### 输入格式
```json
{
  "action": "tool_action",
  "parameters": {
    "param1": "value1",
    "param2": "value2"
  }
}
```

### 输出格式
```json
{
  "success": true,
  "data": {},
  "error": null
}
```
