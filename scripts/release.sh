#!/bin/bash

# 自动发布脚本
set -e

echo "🚀 开始构建和发布..."

# 检查是否有未提交的更改
if [[ -n $(git status -s) ]]; then
  echo "❌ 有未提交的更改，请先提交"
  exit 1
fi

# 获取当前版本
VERSION=$(node -p "require('./package.json').version")
echo "📦 当前版本: $VERSION"

# 构建
echo "🔨 开始构建..."
npm run build

# 打包
echo "📦 开始打包..."
npm run electron:build

# 发布到 GitHub Release
echo "🚀 发布到 GitHub..."
npx electron-builder --publish always

echo "✅ 发布完成！版本 $VERSION"
