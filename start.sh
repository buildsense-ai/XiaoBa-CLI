#!/bin/bash
cd "$(dirname "$0")"
echo "正在启动 XiaoBa Dashboard..."
npx tsx src/index.ts dashboard &
DASHBOARD_PID=$!
sleep 2

# 打开浏览器
if command -v open &>/dev/null; then
  open "http://localhost:3800"
elif command -v xdg-open &>/dev/null; then
  xdg-open "http://localhost:3800"
else
  echo "请打开浏览器访问 http://localhost:3800"
fi

# 等待dashboard进程
wait $DASHBOARD_PID
