@echo off
REM Gordan 测试 Bot
set FEISHU_APP_ID=cli_a89b35667d71101c
set FEISHU_APP_SECRET=thxnzjZBGzLFPKRYzILbCcGVZ2snFGen
set FEISHU_BOT_OPEN_ID=
set FEISHU_BOT_ALIASES=Gordan,gordan
set BOT_BRIDGE_PORT=9300
set BOT_BRIDGE_NAME=Gordan
set BOT_PEERS=Gaven:http://localhost:9301
npx tsx src/index.ts feishu
