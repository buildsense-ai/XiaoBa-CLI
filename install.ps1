# CatsCo Connector lightweight installer (Windows PowerShell)
$ErrorActionPreference = "Stop"
$RepoUrl = "https://github.com/buildsense-ai/XiaoBa-CLI.git"
$InstallDir = if ($env:CATSCO_INSTALL_DIR) { $env:CATSCO_INSTALL_DIR } else { "$env:USERPROFILE\catsco" }
$BuildDir = "$env:TEMP\catsco-connector-build"
$DashboardPort = 3800

function Log($message) { Write-Host "[✓] $message" -ForegroundColor Green }
function Warn($message) { Write-Host "[!] $message" -ForegroundColor Yellow }
function Fail($message) { Write-Host "[✗] $message" -ForegroundColor Red; exit 1 }
function Test-Command($command) { return [bool](Get-Command $command -ErrorAction SilentlyContinue) }

function Check-Git {
    if (Test-Command "git") { Log "Git 已安装: $(git --version)"; return }
    Fail "未检测到 Git，请安装 Git for Windows 后重试"
}

function Check-Node {
    if (Test-Command "node") {
        $major = [int]((node -p "process.versions.node.split('.')[0]"))
        if ($major -ge 18) { Log "Node.js 已安装: $(node -v)"; return }
    }
    Fail "需要 Node.js >= 18，请安装新版 Node.js 后重试"
}

function Build-Connector {
    if (Test-Path $BuildDir) { Remove-Item -Recurse -Force $BuildDir }
    Log "正在获取最新版 Connector 源码..."
    git clone --depth 1 --single-branch $RepoUrl $BuildDir
    Set-Location $BuildDir
    Log "正在准备临时构建环境..."
    npm ci --include=dev --no-audit --no-fund --prefer-offline --progress=false
    npm run build:connector
}

function Deploy-Connector {
    Log "正在部署轻量 Connector..."
    $backup = $null
    if (Test-Path "$InstallDir\.xiaoba") {
        $backup = "$env:TEMP\catsco-config-$([guid]::NewGuid())"
        Copy-Item -Recurse "$InstallDir\.xiaoba" $backup
    }
    if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir }
    New-Item -ItemType Directory -Force "$InstallDir\dist\connector", "$InstallDir\dist\connector-dashboard", "$InstallDir\dashboard" | Out-Null
    Copy-Item "$BuildDir\dist\connector\index.js" "$InstallDir\dist\connector\index.js"
    Copy-Item "$BuildDir\dist\connector-dashboard\server.js" "$InstallDir\dist\connector-dashboard\server.js"
    Copy-Item "$BuildDir\dashboard\connector.html", "$BuildDir\dashboard\connector.css", "$BuildDir\dashboard\connector.js", "$BuildDir\dashboard\cat-icon.png" "$InstallDir\dashboard\"
    Copy-Item "$BuildDir\connector-package.json" "$InstallDir\package.json"
    if ($backup) { Copy-Item -Recurse $backup "$InstallDir\.xiaoba"; Remove-Item -Recurse -Force $backup }
    else { New-Item -ItemType Directory -Force "$InstallDir\.xiaoba" | Out-Null }
    Remove-Item -Recurse -Force $BuildDir
}

function Create-Launcher {
    $launcher = "$InstallDir\start.bat"
@"
@echo off
cd /d "%~dp0"
echo 正在启动 CatsCo Connector...
set XIAOBA_CONNECTOR_PACKAGE=connector-lite
set XIAOBA_APP_ROOT=$InstallDir
set XIAOBA_USER_DATA_DIR=$InstallDir
set XIAOBA_DASHBOARD_PORT=$DashboardPort
start http://127.0.0.1:$DashboardPort
node dist\connector-dashboard\server.js
"@ | Out-File -FilePath $launcher -Encoding ascii
    try {
        $desktop = [Environment]::GetFolderPath("Desktop")
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut("$desktop\CatsCo Connector.lnk")
        $shortcut.TargetPath = $launcher
        $shortcut.WorkingDirectory = $InstallDir
        $shortcut.Save()
    } catch { Warn "桌面快捷方式创建失败，可直接运行 $launcher" }
}

Write-Host "`n  CatsCo Connector`n  轻量安装程序`n" -ForegroundColor Cyan
Check-Git
Check-Node
Build-Connector
Deploy-Connector
Create-Launcher
Log "安装完成；运行目录仅包含 Connector bundle 和页面"
Write-Host "  安装目录: $InstallDir"
Write-Host "  启动方式: $InstallDir\start.bat"
$reply = Read-Host "是否现在启动 Connector？[Y/n]"
if ($reply -notmatch '^[Nn]$') { & "$InstallDir\start.bat" }
