#!/bin/bash
set -e

echo "=== Message-Based Mode 自动化测试 ==="
echo ""

# 编译
echo "步骤 1: 编译项目..."
npm run build
echo "✅ 编译完成"
echo ""

# 设置环境变量
echo "步骤 2: 设置 message mode..."
export GAUZ_MESSAGE_MODE=message
echo "✅ GAUZ_MESSAGE_MODE=message"
echo ""

# 启动 bot（后台）
echo "步骤 3: 启动 CatsCompany bot..."
echo "请在聊天界面测试以下场景："
echo ""
echo "测试 1: 简单问答"
echo "  输入: 你好"
echo "  期望: 直接回复，不调用 thinking"
echo ""
echo "测试 2: 需要推理"
echo "  输入: 帮我分析 package.json 的依赖"
echo "  期望: thinking → read → thinking → 回复"
echo ""
echo "测试 3: 多步骤"
echo "  输入: 读取 README.md 并总结"
echo "  期望: thinking → read → thinking → 回复"
echo ""
echo "启动 bot:"
npm run xiaoba:catscompany
