@echo off
echo Starting Gordan (port 9300)...
start "Gordan" cmd /k "set DOTENV_CONFIG_PATH=.env.gordan && npx tsx src/index.ts feishu"

timeout /t 3 /nobreak >nul

echo Starting Gaven (port 9301)...
start "Gaven" cmd /k "set DOTENV_CONFIG_PATH=.env.gaven && npx tsx src/index.ts feishu"

echo Both bots started. Check the new terminal windows.
