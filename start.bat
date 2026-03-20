@echo off
cd /d "%~dp0"
echo 正在启动 XiaoBa Dashboard...
start http://localhost:3800
npx tsx src/index.ts dashboard
