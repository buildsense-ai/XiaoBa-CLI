# XiaoBa 工具使用示例

本文档展示如何使用 XiaoBa 的学术写作工具。

## 示例 1: 搜索相关文献

**场景**: 你正在写一篇关于"深度学习在自然语言处理中的应用"的论文，需要搜索相关文献。

**对话示例**:

```
用户: 帮我搜索关于深度学习在NLP中应用的最新论文

XiaoBa: 我来帮你搜索相关文献。
[调用 search_papers 工具]
{
  "query": "deep learning natural language processing",
  "source": "arxiv",
  "limit": 10,
  "year_from": 2022
}

找到了10篇相关论文：
1. "Attention Is All You Need" - Vaswani et al. (2017)
   引用数: 50000+
   摘要: 提出了Transformer架构...

2. "BERT: Pre-training of Deep Bidirectional Transformers" - Devlin et al. (2018)
   引用数: 30000+
   摘要: 提出了BERT预训练模型...

[更多论文...]
```

---

## 示例 2: 获取论文详细内容

**场景**: 你找到了一篇重要论文，需要获取其详细内容。

**对话示例**:

```
用户: 帮我获取这篇论文的详细信息: https://arxiv.org/abs/1706.03762

XiaoBa: 我来获取这篇论文的详细信息。
[调用 fetch_paper 工具]
{
  "url": "https://arxiv.org/abs/1706.03762",
  "type": "metadata"
}

论文信息：
- 标题: Attention Is All You Need
- 作者: Ashish Vaswani, Noam Shazeer, et al.
- 年份: 2017
- 期刊: NeurIPS 2017
- 摘要: The dominant sequence transduction models...
- PDF链接: https://arxiv.org/pdf/1706.03762.pdf
```

---

## 示例 3: 生成引用格式

**场景**: 你需要为论文生成标准的引用格式。

**对话示例**:

```
用户: 帮我生成这篇论文的APA格式引用

XiaoBa: 我来生成APA格式的引用。
[调用 citation_tool 工具]
{
  "action": "format",
  "bibtex": "@article{vaswani2017attention, title={Attention is all you need}, author={Vaswani, Ashish and Shazeer, Noam and...}, year={2017}}",
  "style": "apa"
}

APA格式引用：
Vaswani, A., Shazeer, N., Parmar, N., Uszkoreit, J., Jones, L., Gomez, A. N., ... & Polosukhin, I. (2017). Attention is all you need. In Advances in neural information processing systems (pp. 5998-6008).
```

---

## 示例 4: 分析论文质量

**场景**: 你完成了论文初稿，需要检查质量。

**对话示例**:

```
用户: 帮我分析一下我的论文质量

XiaoBa: 我来分析你的论文质量。
[调用 analysis_tool 工具]
{
  "file_path": "my_paper.md",
  "metrics": ["readability", "academic_tone", "structure", "citations"]
}

分析结果：

1. 可读性 (Readability): 75/100
   - Flesch Reading Ease: 45 (大学水平)
   - 建议: 部分句子过长，建议拆分

2. 学术性 (Academic Tone): 82/100
   - 正式用语使用率: 85%
   - 建议: 避免使用"很多"等模糊表达

3. 结构完整性 (Structure): 90/100
   - 包含所有必要章节
   - 建议: 讨论部分可以更详细

4. 引用规范 (Citations): 70/100
   - 引用数量: 25
   - 建议: 引言部分需要更多文献支撑

总体得分: 79/100
```

---

## 示例 5: 转换文档格式

**场景**: 你需要将Markdown格式的论文转换为Word格式以便投稿。

**对话示例**:

```
用户: 帮我把论文转换成Word格式

XiaoBa: 我来将论文转换为Word格式。
[调用 convert_tool 工具]
{
  "input_file": "my_paper.md",
  "output_format": "docx",
  "template": "ieee"
}

转换完成：
- 输出文件: my_paper.docx
- 格式: DOCX
- 大小: 245 KB
- 模板: IEEE标准模板
```

---

## 完整工作流程示例

**场景**: 从零开始完成一篇论文

```
用户: 我想写一篇关于"Transformer在机器翻译中的应用"的论文

XiaoBa: 好的，我来帮你完成这篇论文。让我们按照标准流程进行：

【阶段1: 文献调研】
1. 搜索相关文献...
   [调用 search_papers 多次，覆盖不同关键词]

2. 获取重点论文详情...
   [调用 fetch_paper 获取关键论文]

3. 整理文献综述...

【阶段2: 大纲设计】
根据文献调研，我建议以下大纲：
1. 引言
   1.1 机器翻译背景
   1.2 Transformer的提出
   1.3 研究目标
2. 相关工作
   2.1 传统机器翻译方法
   2.2 神经机器翻译
   2.3 Transformer架构
3. 方法
   ...

你觉得这个大纲如何？

【阶段3: 内容撰写】
[根据大纲逐章节撰写]

【阶段4: 质量检查】
[调用 analysis_tool 检查质量]

【阶段5: 格式规范】
[调用 convert_tool 转换格式]

论文完成！
```
