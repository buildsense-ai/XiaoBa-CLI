#!/bin/bash
set -e

echo "=== Message-Based Mode 完整测试流程 ==="
echo ""

# 1. 编译
echo "步骤 1: 编译项目..."
npm run build
echo "✅ 编译完成"
echo ""

# 2. 备份 .env
echo "步骤 2: 备份 .env..."
cp .env .env.backup
echo "✅ 已备份到 .env.backup"
echo ""

# 3. 添加 message mode 配置
echo "步骤 3: 设置 message mode..."
if grep -q "GAUZ_MESSAGE_MODE" .env; then
  sed -i.tmp 's/GAUZ_MESSAGE_MODE=.*/GAUZ_MESSAGE_MODE=message/' .env
  rm .env.tmp
else
  echo "" >> .env
  echo "# Message Mode" >> .env
  echo "GAUZ_MESSAGE_MODE=message" >> .env
fi
echo "✅ 已设置 GAUZ_MESSAGE_MODE=message"
echo ""

# 4. 显示测试说明
echo "步骤 4: 准备测试..."
echo ""
echo "现在可以启动 bot 测试："
echo "  npm run xiaoba:catscompany"
echo ""
echo "测试场景："
echo "  1. 简单问答: '你好'"
echo "  2. 需要推理: '帮我分析 package.json'"
echo "  3. 多步骤: '读取 README.md 并总结'"
echo ""
echo "观察点："
echo "  - AI 是否调用 thinking 工具"
echo "  - 最终回复是否自动发送"
echo "  - Log 中的工具调用顺序"
echo ""
echo "测试完成后，恢复配置："
echo "  mv .env.backup .env"
echo ""
