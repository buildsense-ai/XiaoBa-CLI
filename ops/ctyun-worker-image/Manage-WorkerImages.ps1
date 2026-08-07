<# Manage-WorkerImages.ps1

Worker 私有镜像生命周期管理（与 New-CatsCoWorkerImage.ps1 配套）：

  -List   : 列出全部 catsco-worker-* 私有镜像（imageID/name/version/commit/createdTime）
  -Latest : 输出最新 bake 的 worker 镜像 imageID（供部署/控制面取最新镜像）
  -Prune  : 保留最新 N 个（默认 6），删除更旧的（带 bake label 的 catsco-worker-*），
            删除需连续空读确认（按 --imageName 精确过滤，避免 >200 张时最旧镜像
            不在第 1 页导致的误判），确认超时可配（-ConfirmTimeoutMinutes），
            失败 fail-closed 聚合报告

  安全（Prune）：必须有 -ProtectedImageIDs（逗号分隔）声明生产 launch template
  等仍引用的镜像，自动清理才会执行；受保护镜像即使超过保留数也绝不删除。
  未配置保护列表但有需要删除的旧镜像时，Prune 拒绝执行（fail-closed）。

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
    [int]$Keep = 6,

    [ValidateRange(1, 30)]
    [int]$ConfirmTimeoutMinutes = 3,

    [string]$ProtectedImageIDs = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
# Do not turn stderr writes from a successful external command into a thrown
# ErrorRecord under $ErrorActionPreference = 'Stop'.
$PSNativeCommandUseErrorActionPreference = $false
# ProjectID 空值兜底：显式传入空串（例如 workflow 里 var 未配置）时回退默认
# "0"，保证与 bake 作用域（New-CatsCoWorkerImage.ps1 默认 ProjectID 0）一致。
if ([string]::IsNullOrEmpty($ProjectID)) { $ProjectID = "0" }

function Invoke-Ctyun {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)

    try {
        $raw = & timeout '--signal=TERM' '--kill-after=15s' '90s' ctyun-cli @Arguments '--output' 'json' 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "ctyun-cli failed with exit code $LASTEXITCODE`n$($raw -join "`n")"
        }
        # Join lines before parsing: ConvertFrom-Json on a multi-line JSON
        # array would otherwise parse line by line (same as bake's
        # Invoke-External -Capture).
        $response = ($raw -join "`n") | ConvertFrom-Json
        if ([string]$response.statusCode -ne "800") {
            throw (
                "Tianyi Cloud API failed: $([string]$response.errorCode) " +
                "$([string]$response.message) $([string]$response.description)"
            )
        }
        return $response
    } catch {
        throw "ctyun-cli call failed ($($Arguments -join ' ')): $($_.Exception.Message)"
    }
}

function Get-ImageItems {
    param($Response)
    return @($Response.returnObj.images)
}

# Defensive property access: returns "" when the object or property is absent,
# which keeps StrictMode from crashing on hand-made / unlabeled images.
function Get-Prop {
    param($Obj, [string]$Name)
    if ($null -eq $Obj) { return "" }
    $prop = $Obj.PSObject.Properties[$Name]
    if ($null -eq $prop) { return "" }
    return $prop.Value
}

function Get-PropLong {
    param($Obj, [string]$Name)
    $raw = Get-Prop -Obj $Obj -Name $Name
    if ($raw -is [string] -and $raw.Trim() -eq "") { return [long]0 }
    return [long]$raw
}

function Get-LabelValue {
    param($Labels, [string]$Key)
    $match = @($Labels | Where-Object { [string](Get-Prop -Obj $_ -Name "labelKey") -eq $Key }) | Select-Object -First 1
    if (-not $match) { return "" }
    return [string](Get-Prop -Obj $match -Name "labelValue")
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
        [string](Get-Prop -Obj $_ -Name "imageName") -like "catsco-worker-*" -and
        (Get-LabelValue -Labels (Get-Prop -Obj $_ -Name "labels") -Key "bake") -ne ""
    }
)

# --- 最新在前（createdTime 降序，id 兜底） ---
$sorted = @(
    $workerImages | Sort-Object `
        @{ Expression = { Get-PropLong -Obj $_ -Name "createdTime" }; Descending = $true }, `
        @{ Expression = { [string](Get-Prop -Obj $_ -Name "imageID") }; Descending = $true }
)

if ($Action -eq "List") {
    $rows = foreach ($img in $sorted) {
        [pscustomobject]@{
            imageID     = [string](Get-Prop -Obj $img -Name "imageID")
            name        = [string](Get-Prop -Obj $img -Name "imageName")
            version     = Get-LabelValue -Labels (Get-Prop -Obj $img -Name "labels") -Key "version"
            commit      = Get-LabelValue -Labels (Get-Prop -Obj $img -Name "labels") -Key "commit"
            createdTime = Get-PropLong -Obj $img -Name "createdTime"
            status      = [string](Get-Prop -Obj $img -Name "imageStatus")
        }
    }
    ConvertTo-Json -InputObject @($rows)
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

# 受保护镜像：生产 launch template / 回滚 / 分批发布仍引用的镜像，绝不删除。
# 有需要删除的旧镜像时必须显式声明保护列表（fail-closed），防止自动清理
# 误删生产仍在使用的镜像。
$protected = @(
    $ProtectedImageIDs -split ',' |
        ForEach-Object { $_.Trim() } |
        Where-Object { $_ -ne "" }
)
if ($protected.Count -eq 0) {
    throw (
        "Refusing to auto-prune: no protected image IDs configured. " +
        "Set -ProtectedImageIDs to the production launch-template image(s) " +
        "before enabling automatic cleanup."
    )
}

$toDelete = @(
    @($sorted | Select-Object -Skip $Keep) |
        Where-Object { $protected -notcontains [string]$_.imageID }
)
if ($toDelete.Count -eq 0) {
    Write-Host "All would-be-pruned images are protected; nothing to delete"
    exit 0
}
Write-Host "Pruning $($toDelete.Count) old worker image(s), keeping latest $Keep ($($protected.Count) protected)"
$failures = [Collections.Generic.List[string]]::new()
foreach ($img in $toDelete) {
    $imageID = [string](Get-Prop -Obj $img -Name "imageID")
    $imageName = [string](Get-Prop -Obj $img -Name "imageName")
    try {
        Write-Host "Deleting old worker image $imageID ($imageName)"
        Invoke-Ctyun @(
            "ims", "DeleteImage",
            "--regionID", $RegionID,
            "--imageID", $imageID
        ) | Out-Null

        # 删除确认：按 --imageName 精确过滤（不用 GetImageDetail——实测对私有
        # 镜像偶发 NotFound 而 ListImage 可靠）。按名称过滤而不是第 1 页全量，
        # 避免私有镜像总数 > 200 时最旧镜像不在第 1 页导致的误判"已删除"。
        $deleteDeadline = (Get-Date).AddMinutes($ConfirmTimeoutMinutes)
        $confirmed = $false
        while ((Get-Date) -lt $deleteDeadline) {
            $checkResp = Invoke-Ctyun @(
                "ims", "ListImage",
                "--regionID", $RegionID,
                "--projectID", $ProjectID,
                "--imageVisibilityCode", "0",
                "--imageName", $imageName,
                "--pageNo", "1",
                "--pageSize", "200"
            )
            $still = @(
                @(Get-ImageItems $checkResp) |
                    Where-Object { [string](Get-Prop -Obj $_ -Name "imageID") -eq $imageID }
            )
            if (@($still).Count -eq 0) {
                $confirmed = $true
                break
            }
            Start-Sleep -Seconds 10
        }
        if (-not $confirmed) {
            throw "Could not confirm deletion of $imageID within $ConfirmTimeoutMinutes minute(s)"
        }
    } catch {
        $failures.Add("image $imageID ($imageName): $($_.Exception.Message)")
    }
}

if ($failures.Count -gt 0) {
    throw "Worker image cleanup failed:`n$($failures -join "`n")"
}
Write-Host "Worker image cleanup complete"
