# XiaoBa PATH 设置脚本
# 将XiaoBa添加到用户PATH环境变量

$xiaoBaPath = $PSScriptRoot

# 获取当前用户的PATH环境变量
$currentPath = [Environment]::GetEnvironmentVariable("Path", "User")

# 检查是否已经添加
if ($currentPath -notlike "*$xiaoBaPath*") {
    # 添加到PATH
    $newPath = "$currentPath;$xiaoBaPath"
    [Environment]::SetEnvironmentVariable("Path", $newPath, "User")

    Write-Host "✓ XiaoBa已添加到PATH环境变量" -ForegroundColor Green
    Write-Host "请重新打开PowerShell窗口，然后就可以直接使用 'xiaoba' 命令了" -ForegroundColor Yellow
} else {
    Write-Host "✓ XiaoBa已经在PATH中" -ForegroundColor Green
}
