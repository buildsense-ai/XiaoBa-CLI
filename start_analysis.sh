#!/bin/bash

echo "=== Remote Sensing 论文深度解读工具 ==="
echo "论文文件: pdfs/remotesensing-17-01783-v2.pdf"
echo ""

# 检查环境变量
if [ -z "$MINERU_TOKEN" ] || [ "$MINERU_TOKEN" = "your_token_here" ]; then
    echo "❌ 错误: MINERU_TOKEN 未正确配置"
    echo "请编辑 .env 文件，设置有效的 MINERU_TOKEN"
    echo ""
    echo "备用方案:"
    echo "1. 手动阅读PDF并记录笔记"
    echo "2. 使用 docs/remote_sensing_paper_analysis.md 作为解读框架"
    echo "3. 按 docs/paper_reading_guide.md 的模板创建解读文档"
    exit 1
fi

echo "✅ 环境检查通过"
echo ""

# 创建目录结构
echo "创建目录结构..."
mkdir -p docs/analysis/remotesensing_17_01783

echo ""
echo "可用文档:"
echo "1. docs/remote_sensing_paper_analysis.md - 深度解读框架"
echo "2. docs/paper_reading_guide.md - 详细解读指南"
echo ""
echo "下一步:"
echo "1. 使用 paper_parser 解析PDF:"
echo "   paper_parser pdfs/remotesensing-17-01783-v2.pdf"
echo ""
echo "2. 按指南创建解读文档"
echo "3. 使用提供的模板记录分析结果"