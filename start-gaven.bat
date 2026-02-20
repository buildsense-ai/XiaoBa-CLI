@echo off
REM Gaven 测试 Bot - 显式覆盖飞书和 Bridge 配置
set FEISHU_APP_ID=cli_a8bc3f621434500d
set FEISHU_APP_SECRET=93utVuDgh1nAscywp4nWMezfAiTebhjP
set FEISHU_BOT_OPEN_ID=
set FEISHU_BOT_ALIASES=Gaven,gaven
set BOT_BRIDGE_PORT=9301
set BOT_BRIDGE_NAME=Gaven
set BOT_PEERS=Gordan:http://localhost:9300
npx tsx src/index.ts feishu
