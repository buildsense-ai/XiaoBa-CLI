# ============================================
#  XiaoBa 一键安装脚本 (Windows PowerShell)
#  用法: 右键以管理员身份运行，或在 PowerShell 中执行:
#  irm https://raw.githubusercontent.com/buildsense-ai/XiaoBa-CLI/main/install.ps1 | iex
# ============================================

$ErrorActionPreference = "Stop"
$RepoUrl = "https://github.com/buildsense-ai/XiaoBa-CLI.git"
$InstallDir = "$env:USERPROFILE\xiaoba"
$DashboardPort = 3800

function Write-Banner {
    Write-Host ""
    Write-Host "  ██╗  ██╗██╗ █████╗  ██████╗ ██████╗  █████╗" -ForegroundColor Cyan
    Write-Host "  ╚██╗██╔╝██║██╔══██╗██╔═══██╗██╔══██╗██╔══██╗" -ForegroundColor Cyan
    Write-Host "   ╚███╔╝ ██║███████║██║   ██║██████╔╝███████║" -ForegroundColor Cyan
    Write-Host "   ██╔██╗ ██║██╔══██║██║   ██║██╔══██╗██╔══██║" -ForegroundColor Cyan
    Write-Host "  ██╔╝ ██╗██║██║  ██║╚██████╔╝██████╔╝██║  ██║" -ForegroundColor Cyan
    Write-Host "  ╚═╝  ╚═╝╚═╝╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚═╝  ╚═╝" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  一键安装程序 (Windows)" -ForegroundColor White
    Write-Host ""
}

function Log($msg) { Write-Host "[✓] $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "[!] $msg" -ForegroundColor Yellow }
function Err($msg) { Write-Host "[✗] $msg" -ForegroundColor Red; exit 1 }

function Test-Command($cmd) {
    try { Get-Command $cmd -ErrorAction Stop | Out-Null; return $true }
    catch { return $false }
}

# ---- 检查 Git ----
function Check-Git {
    if (Test-Command "git") {
        Log "Git 已安装: $(git --version)"
    } else {
        Warn "未检测到 Git，正在下载安装..."
        $gitInstaller = "$env:TEMP\git-installer.exe"
        Invoke-WebRequest -Uri "https://github.com/git-for-windows/git/releases/download/v2.43.0.windows.1/Git-2.43.0-64-bit.exe" -OutFile $gitInstaller
        Start-Process -FilePath $gitInstaller -Args "/VERYSILENT /NORESTART" -Wait
        $env:PATH = "$env:PATH;C:\Program Files\Git\bin"
        Log "Git 安装完成"
    }
}

# ---- 检查 Node.js ----
function Check-Node {
    if (Test-Command "node") {
        $ver = (node -v) -replace 'v','' -split '\.' | Select-Object -First 1
        if ([int]$ver -ge 18) {
            Log "Node.js 已安装: $(node -v)"
            return
        }
        Warn "Node.js 版本过低 ($(node -v))，需要 >= 18"
    } else {
        Warn "未检测到 Node.js"
    }

    Write-Host "正在下载 Node.js 20..."
    $nodeInstaller = "$env:TEMP\node-installer.msi"
    Invoke-WebRequest -Uri "https://nodejs.org/dist/v20.11.0/node-v20.11.0-x64.msi" -OutFile $nodeInstaller
    Start-Process msiexec.exe -Args "/i `"$nodeInstaller`" /quiet /norestart" -Wait
    $env:PATH = "$env:PATH;C:\Program Files\nodejs"
    Log "Node.js 安装完成: $(node -v)"
}

# ---- 克隆/更新仓库 ----
function Setup-Repo {
    if (Test-Path "$InstallDir\.git") {
        Log "检测到已有安装，正在更新..."
        Set-Location $InstallDir
        git pull --ff-only 2>$null
        if ($LASTEXITCODE -ne 0) { Warn "更新失败，使用现有版本继续" }
    } else {
        Log "正在下载 XiaoBa..."
        git clone $RepoUrl $InstallDir
        Set-Location $InstallDir
    }
}

# ---- 安装依赖 ----
function Install-Deps {
    Log "正在安装依赖..."
    npm install --no-audit --no-fund 2>$null
    Log "依赖安装完成"
}

# ---- 构建 ----
function Build-Project {
    Log "正在构建..."
    npm run build 2>$null
    Log "构建完成"
}

# ---- 初始化配置 ----
function Init-Config {
    if (-not (Test-Path "$InstallDir\.env")) {
        Copy-Item "$InstallDir\.env.example" "$InstallDir\.env"
        Log "已创建 .env 配置文件（请在 Dashboard 中配置 API Key）"
    } else {
        Log ".env 配置文件已存在"
    }
}

# ---- 创建启动脚本 ----
function Create-Launcher {
    $launcher = "$InstallDir\start.bat"
    @"
@echo off
cd /d "%~dp0"
echo 正在启动 XiaoBa Dashboard...
start http://localhost:$DashboardPort
npx tsx src/index.ts dashboard
"@ | Out-File -FilePath $launcher -Encoding ASCII
    Log "启动脚本已创建: $launcher"

    # 创建桌面快捷方式
    try {
        $desktop = [Environment]::GetFolderPath("Desktop")
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut("$desktop\XiaoBa Dashboard.lnk")
        $shortcut.TargetPath = $launcher
        $shortcut.WorkingDirectory = $InstallDir
        $shortcut.IconLocation = "shell32.dll,21"
        $shortcut.Save()
        Log "桌面快捷方式已创建"
    } catch {
        Warn "桌面快捷方式创建失败（不影响使用）"
    }
}

# ---- 主流程 ----
Write-Banner
Check-Git
Check-Node
Write-Host ""
Setup-Repo
Install-Deps
Build-Project
Init-Config
Create-Launcher

Write-Host ""
Write-Host "════════════════════════════════════════" -ForegroundColor Green
Write-Host "  XiaoBa 安装完成！" -ForegroundColor Green
Write-Host "════════════════════════════════════════" -ForegroundColor Green
Write-Host ""
Write-Host "  安装目录: $InstallDir"
Write-Host "  启动方式: 双击桌面 'XiaoBa Dashboard' 快捷方式"
Write-Host "  或运行:   $InstallDir\start.bat"
Write-Host "  Dashboard: http://localhost:$DashboardPort"
Write-Host ""

$reply = Read-Host "是否现在启动 Dashboard？[Y/n]"
if ($reply -ne "n" -and $reply -ne "N") {
    Set-Location $InstallDir
    & "$InstallDir\start.bat"
}
