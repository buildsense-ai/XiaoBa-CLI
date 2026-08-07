<# Manage-WorkerImages.ps1

Worker 私有镜像生命周期管理（与 New-CatsCoWorkerImage.ps1 配套）：

  -List   : 列出全部 catsco-worker-* 私有镜像（imageID/name/version/commit/createdTime）
  -Latest : 输出最新 bake 的 worker 镜像 imageID（供部署/控制面取最新镜像）
  -Prune  : 保留最新 N 个（默认 6），删除更旧的（带 bake label 的 catsco-worker-*），
            删除需连续空读确认，失败 fail-closed 聚合报告

凭据：复用 ctyun-cli（环境变量 CTYUN_AK/CTYUN_SK 或 ~/.ctyun-cli.yaml），与 bake 一致。
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$RegionID,

    [string]$ProjectID = "0",

    [ValidateSet("List", "Latest", "Prune")]
    [string]$Action = "List",

    [ValidateRange(1, 50)]
    [int]$Keep = 6
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Invoke-Ctyun {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)

    $raw = & timeout '--signal=TERM' '--kill-after=15s' '90s' ctyun-cli @Arguments '--output' 'json' 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "ctyun-cli failed with exit code $LASTEXITCODE`n$($raw -join "`n")"
    }
    $response = $raw | ConvertFrom-Json
    if ([string]$response.statusCode -ne "800") {
        throw (
            "Tianyi Cloud API failed: $([string]$response.errorCode) " +
            "$([string]$response.message) $([string]$response.description)"
        )
    }
    return $response
}

function Get-ImageItems {
    param($Response)
    return @($Response.returnObj.images)
}

function Get-LabelValue {
    param($Labels, [string]$Key)
    $match = @($Labels | Where-Object { [string]$_.labelKey -eq $Key }) | Select-Object -First 1
    if (-not $match) { return "" }
    return [string]$match.labelValue
}

# --- 分页拉取全部私有镜像 ---
$all = [Collections.Generic.List[object]]::new()
$page = 1
do {
    $resp = Invoke-Ctyun @(
        "ims", "ListImage",
        "--regionID", $RegionID,
        "--projectID", $ProjectID,
        "--imageVisibilityCode", "0",
        "--pageNo", "$page",
        "--pageSize", "200"
    )
    $items = @(Get-ImageItems $resp)
    if ($items.Count -gt 0) { $items | ForEach-Object { $all.Add($_) } }
    $totalPage = [int]($resp.returnObj.totalPage)
    $page++
} while ($page -le $totalPage)

# --- 过滤本 bake 通道的 worker 镜像：名称前缀 + bake label ---
$workerImages = @(
    $all | Where-Object {
        [string]$_.imageName -like "catsco-worker-*" -and
        (Get-LabelValue -Labels $_.labels -Key "bake") -ne ""
    }
)

# --- 最新在前（createdTime 降序，id 兜底） ---
$sorted = @(
    $workerImages | Sort-Object `
        @{ Expression = { [long]$_.createdTime }; Descending = $true }, `
        @{ Expression = { [string]$_.imageID }; Descending = $true }
)

if ($Action -eq "List") {
    $rows = foreach ($img in $sorted) {
        [pscustomobject]@{
            imageID     = [string]$img.imageID
            name        = [string]$img.imageName
            version     = Get-LabelValue -Labels $img.labels -Key "version"
            commit      = Get-LabelValue -Labels $img.labels -Key "commit"
            createdTime = [long]$img.createdTime
            status      = [string]$img.imageStatus
        }
    }
    $rows | ConvertTo-Json
    exit 0
}

if ($Action -eq "Latest") {
    if ($sorted.Count -eq 0) {
        throw "No worker images found in region $RegionID"
    }
    Write-Output ([string]$sorted[0].imageID)
    exit 0
}

# --- Prune ---
if ($sorted.Count -le $Keep) {
    Write-Host "No worker image cleanup needed ($($sorted.Count) image(s), keep $Keep)"
    exit 0
}

$toDelete = @($sorted | Select-Object -Skip $Keep)
Write-Host "Pruning $($toDelete.Count) old worker image(s), keeping latest $Keep"
$failures = [Collections.Generic.List[string]]::new()
foreach ($img in $toDelete) {
    $imageID = [string]$img.imageID
    $imageName = [string]$img.imageName
    try {
        Write-Host "Deleting old worker image $imageID ($imageName)"
        Invoke-Ctyun @(
            "ims", "DeleteImage",
            "--regionID", $RegionID,
            "--imageID", $imageID
        ) | Out-Null

        # 删除确认：连续空读（ListImage 全量过滤，不用 GetImageDetail——
        # 实测 GetImageDetail 对私有镜像偶发 NotFound 而 ListImage 可靠）
        $deleteDeadline = (Get-Date).AddMinutes(3)
        $confirmed = $false
        while ((Get-Date) -lt $deleteDeadline) {
            $checkResp = Invoke-Ctyun @(
                "ims", "ListImage",
                "--regionID", $RegionID,
                "--projectID", $ProjectID,
                "--imageVisibilityCode", "0",
                "--pageNo", "1",
                "--pageSize", "200"
            )
            $still = @(
                @(Get-ImageItems $checkResp) |
                    Where-Object { [string]$_.imageID -eq $imageID }
            )
            if (@($still).Count -eq 0) {
                $confirmed = $true
                break
            }
            Start-Sleep -Seconds 10
        }
        if (-not $confirmed) {
            throw "Could not confirm deletion of $imageID"
        }
    } catch {
        $failures.Add("image $imageID ($imageName): $($_.Exception.Message)")
    }
}

if ($failures.Count -gt 0) {
    throw "Worker image cleanup failed:`n$($failures -join "`n")"
}
Write-Host "Worker image cleanup complete"
