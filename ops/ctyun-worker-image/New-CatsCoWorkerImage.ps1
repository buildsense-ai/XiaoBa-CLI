[CmdletBinding()]
param(
    [ValidateSet("Plan", "Create")]
    [string]$Mode = "Plan",

    [Parameter(Mandatory = $true)]
    [string]$RegionID,

    [Parameter(Mandatory = $true)]
    [string]$AzName,

    [Parameter(Mandatory = $true)]
    [string]$BaseImageID,

    [Parameter(Mandatory = $true)]
    [string]$FlavorID,

    [Parameter(Mandatory = $true)]
    [string]$VpcID,

    [Parameter(Mandatory = $true)]
    [string]$SubnetID,

    [Parameter(Mandatory = $true)]
    [string]$SecurityGroupID,

    [string]$ProjectID = "0",
    [string]$SourceRef = "HEAD",
    [string]$ImageName = "",
    [string]$ArtifactPath = "",
    [string]$ArtifactSha256 = "",
    [string]$BuildNumber = "",
    [string]$BuildAttempt = "1",
    [string]$BootDiskType = "SATA",
    [ValidateRange(40, 2048)]
    [int]$BootDiskSize = 40,
    [ValidateRange(1, 300)]
    [int]$BuilderBandwidth = 5,
    [ValidateRange(10, 120)]
    [int]$TimeoutMinutes = 50,
    [ValidateRange(10, 90)]
    [int]$RemoteBuildTimeoutMinutes = 45,
    [ValidateRange(10, 60)]
    [int]$ArtifactTransferTimeoutMinutes = 30
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$script:BuilderID = ""
$script:BuilderName = ""
$script:BuilderResourceID = ""
$script:BuilderIP = ""
$script:BuilderCreateAttempted = $false
$script:KeyPairName = ""
$script:KeyPairCreateAttempted = $false
$script:TemporaryRoot = ""
$script:ImageID = ""
$script:ImageCreateAttempted = $false
$script:ImageActive = $false
$script:Completed = $false

function Invoke-External {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Command,
        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [AllowEmptyString()]
        [string[]]$Arguments,
        [switch]$Capture
    )

    if ($Capture) {
        $output = & $Command @Arguments 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "$Command failed with exit code $LASTEXITCODE`n$($output -join "`n")"
        }
        return ($output -join "`n")
    }

    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Command failed with exit code $LASTEXITCODE"
    }
}

function Invoke-Ctyun {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)

    $raw = Invoke-External -Command "ctyun-cli" -Arguments ($Arguments + @("--output", "json")) -Capture
    try {
        $response = $raw | ConvertFrom-Json
    } catch {
        throw "ctyun-cli returned non-JSON output: $raw"
    }
    if ($response.statusCode -ne 800) {
        throw "Tianyi Cloud API failed: $($response.errorCode) $($response.message) $($response.description)"
    }
    return $response
}

function Test-NotFoundError {
    param([Parameter(Mandatory = $true)][string]$Message)

    return $Message -match "(?i)not found|notfound|does not exist|不存在|未找到"
}

function Get-Instance {
    param([Parameter(Mandatory = $true)][string]$InstanceID)

    $response = Invoke-Ctyun @(
        "ecs", "ListEcsInstances",
        "--regionID", $RegionID,
        "--instanceIDList", $InstanceID,
        "--pageNo", "1",
        "--pageSize", "10"
    )
    return @($response.returnObj.results) | Select-Object -First 1
}

function Find-BuilderInstance {
    $queries = [Collections.Generic.List[object]]::new()
    if ($script:BuilderResourceID) {
        $queries.Add(@(
            "ecs", "ListEcsInstances",
            "--regionID", $RegionID,
            "--resourceID", $script:BuilderResourceID,
            "--pageNo", "1",
            "--pageSize", "10"
        ))
    }
    if ($script:BuilderName) {
        $queries.Add(@(
            "ecs", "ListEcsInstances",
            "--regionID", $RegionID,
            "--instanceName", $script:BuilderName,
            "--pageNo", "1",
            "--pageSize", "10"
        ))
    }

    foreach ($query in $queries) {
        $response = Invoke-Ctyun $query
        foreach ($candidate in @($response.returnObj.results)) {
            if (
                [string]$candidate.instanceName -eq $script:BuilderName -and
                (
                    -not $script:BuilderResourceID -or
                    [string]$candidate.resourceID -eq $script:BuilderResourceID
                )
            ) {
                $script:BuilderID = [string]$candidate.instanceID
                return $candidate
            }
        }
    }
    return $null
}

function Resolve-BuilderInstance {
    param([ValidateRange(0, 7200)][int]$WaitSeconds = 0)

    $deadline = (Get-Date).AddSeconds($WaitSeconds)
    do {
        if ($script:BuilderID) {
            try {
                $instance = Get-Instance -InstanceID $script:BuilderID
                if ($instance) {
                    return $instance
                }
            } catch {
                if (-not (Test-NotFoundError $_.Exception.Message)) {
                    throw
                }
            }
        }

        $resolved = Find-BuilderInstance
        if ($resolved) {
            return $resolved
        }
        if ((Get-Date) -ge $deadline) {
            break
        }
        Start-Sleep -Seconds 8
    } while ($true)

    return $null
}

function Assert-TemporaryBuilder {
    param([Parameter(Mandatory = $true)]$Instance)

    if (-not $Instance) {
        throw "Temporary builder instance was not found"
    }
    if (-not $script:BuilderID -or [string]$Instance.instanceID -ne $script:BuilderID) {
        throw "Refusing to operate on an instance outside this bake"
    }
    if (
        -not $script:BuilderName.StartsWith("catsco-img-") -or
        [string]$Instance.instanceName -ne $script:BuilderName
    ) {
        throw "Refusing to operate on non-builder instance '$($Instance.instanceName)'"
    }
}

function Wait-ForInstance {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$States,
        [switch]$RequireIP
    )

    $deadline = (Get-Date).AddMinutes($TimeoutMinutes)
    while ((Get-Date) -lt $deadline) {
        $instance = Resolve-BuilderInstance
        Assert-TemporaryBuilder $instance
        $state = ([string]$instance.instanceStatus).ToLowerInvariant()
        $ip = [string]$instance.floatingIP
        Write-Host "builder state=$state ip=$ip"
        if ($States -contains $state -and (-not $RequireIP -or $ip)) {
            return $instance
        }
        Start-Sleep -Seconds 8
    }
    throw "Timed out waiting for builder state: $($States -join ', ')"
}

function Wait-ForSsh {
    param(
        [Parameter(Mandatory = $true)][string]$IP,
        [Parameter(Mandatory = $true)][string]$PrivateKey,
        [Parameter(Mandatory = $true)][string]$KnownHosts
    )

    $deadline = (Get-Date).AddMinutes(12)
    while ((Get-Date) -lt $deadline) {
        & ssh `
            -i $PrivateKey `
            -o BatchMode=yes `
            -o ConnectTimeout=6 `
            -o ServerAliveInterval=15 `
            -o ServerAliveCountMax=3 `
            -o StrictHostKeyChecking=accept-new `
            -o "UserKnownHostsFile=$KnownHosts" `
            "root@$IP" "timeout --signal=TERM --kill-after=15s 90s cloud-init status --wait >/dev/null 2>&1; printf ready" 2>$null
        if ($LASTEXITCODE -eq 0) {
            return
        }
        Start-Sleep -Seconds 8
    }
    throw "Timed out waiting for SSH on temporary builder"
}

function Get-Image {
    param([Parameter(Mandatory = $true)][string]$ImageID)

    try {
        $detail = Invoke-Ctyun @(
            "ims", "GetImageDetail",
            "--regionID", $RegionID,
            "--imageID", $ImageID,
            "--errorFree", "false"
        )
        return @($detail.returnObj.images) | Select-Object -First 1
    } catch {
        if (Test-NotFoundError $_.Exception.Message) {
            return $null
        }
        throw
    }
}

function Find-ImageByName {
    $response = Invoke-Ctyun @(
        "ims", "ListImage",
        "--regionID", $RegionID,
        "--imageVisibilityCode", "0",
        "--imageName", $ImageName,
        "--pageNo", "1",
        "--pageSize", "10"
    )
    return @($response.returnObj.images) |
        Where-Object { [string]$_.imageName -eq $ImageName } |
        Select-Object -First 1
}

function Remove-FailedImage {
    if ($script:ImageActive -or (-not $script:ImageCreateAttempted -and -not $script:ImageID)) {
        return
    }

    if (-not $script:ImageID) {
        $resolveDeadline = (Get-Date).AddMinutes(3)
        while ((Get-Date) -lt $resolveDeadline -and -not $script:ImageID) {
            $candidate = Find-ImageByName
            if ($candidate) {
                $script:ImageID = [string]$candidate.imageID
                break
            }
            Start-Sleep -Seconds 10
        }
        if (-not $script:ImageID) {
            Write-Host "No incomplete image record appeared for $ImageName"
            return
        }
    }

    $deadline = (Get-Date).AddMinutes(12)
    $deletableStates = @(
        "active", "deactivated", "deactivating", "deleting",
        "error", "killed", "reactivating"
    )
    while ((Get-Date) -lt $deadline) {
        $image = Get-Image -ImageID $script:ImageID
        if (-not $image) {
            return
        }
        $status = ([string]$image.imageStatus).ToLowerInvariant()
        Write-Host "failed image cleanup state=$status"
        if ($status -eq "deleted") {
            return
        }
        if ($status -in $deletableStates) {
            if ($status -ne "deleting") {
                Write-Host "Deleting incomplete image $script:ImageID"
                Invoke-Ctyun @(
                    "ims", "DeleteImage",
                    "--regionID", $RegionID,
                    "--imageID", $script:ImageID
                ) | Out-Null
            }
            break
        }
        Start-Sleep -Seconds 15
    }

    $deleteDeadline = (Get-Date).AddMinutes(8)
    while ((Get-Date) -lt $deleteDeadline) {
        $remaining = Get-Image -ImageID $script:ImageID
        if (-not $remaining -or ([string]$remaining.imageStatus).ToLowerInvariant() -eq "deleted") {
            return
        }
        Start-Sleep -Seconds 10
    }
    throw "Could not confirm deletion of incomplete image $script:ImageID"
}

function Remove-Builder {
    if (-not $script:BuilderCreateAttempted -and -not $script:BuilderID) {
        return
    }

    $instance = Resolve-BuilderInstance -WaitSeconds 480
    if (-not $instance) {
        throw "Could not prove cleanup of builder name=$script:BuilderName resourceID=$script:BuilderResourceID"
    }
    Assert-TemporaryBuilder $instance
    Write-Host "Deleting temporary builder $script:BuilderID"
    Invoke-Ctyun @(
        "ecs", "DeleteEcsInstance",
        "--regionID", $RegionID,
        "--instanceID", $script:BuilderID,
        "--clientToken", ([guid]::NewGuid().ToString()),
        "--deleteEip", "true",
        "--deleteVolume", "true"
    ) | Out-Null

    $deadline = (Get-Date).AddMinutes(8)
    while ((Get-Date) -lt $deadline) {
        $remaining = Resolve-BuilderInstance
        if (-not $remaining) {
            return
        }
        Assert-TemporaryBuilder $remaining
        Start-Sleep -Seconds 8
    }
    throw "Could not confirm deletion of temporary builder $script:BuilderID"
}

function Remove-KeyPair {
    if (-not $script:KeyPairName -or -not $script:KeyPairCreateAttempted) {
        return
    }

    Write-Host "Deleting temporary key pair $script:KeyPairName"
    Invoke-Ctyun @(
        "ecs", "DeleteEcsKeypair",
        "--regionID", $RegionID,
        "--keyPairName", $script:KeyPairName
    ) | Out-Null

    $deadline = (Get-Date).AddMinutes(2)
    while ((Get-Date) -lt $deadline) {
        $details = Invoke-Ctyun @(
            "ecs", "GetEcsKeypairDetails",
            "--regionID", $RegionID,
            "--projectID", $ProjectID,
            "--keyPairName", $script:KeyPairName,
            "--pageNo", "1",
            "--pageSize", "10"
        )
        $remaining = @(
            @($details.returnObj.results) |
                Where-Object { [string]$_.keyPairName -eq $script:KeyPairName }
        )
        if ($remaining.Count -eq 0) {
            return
        }
        Start-Sleep -Seconds 5
    }
    throw "Could not confirm deletion of temporary key pair $script:KeyPairName"
}

function Remove-TemporaryResources {
    param([switch]$Failure)

    $errors = [Collections.Generic.List[string]]::new()
    if ($Failure) {
        try {
            Remove-FailedImage
        } catch {
            $errors.Add(
                "image cleanup (name=$ImageName imageID=$script:ImageID): $($_.Exception.Message)"
            )
        }
    }
    try {
        Remove-Builder
    } catch {
        $errors.Add(
            "builder cleanup (name=$script:BuilderName instanceID=$script:BuilderID resourceID=$script:BuilderResourceID): $($_.Exception.Message)"
        )
    }
    try {
        Remove-KeyPair
    } catch {
        $errors.Add(
            "key pair cleanup (name=$script:KeyPairName): $($_.Exception.Message)"
        )
    }

    if ($errors.Count -gt 0) {
        throw "Temporary cloud resource cleanup failed:`n$($errors -join "`n")"
    }
}

if (-not (Get-Command "git" -ErrorAction SilentlyContinue)) {
    throw "Missing required command: git"
}
if ($Mode -eq "Create") {
    foreach ($command in @("ctyun-cli", "ssh", "scp", "ssh-keygen", "timeout")) {
        if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
            throw "Missing required command: $command"
        }
    }
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
$commit = (Invoke-External -Command "git" -Arguments @("-C", $repoRoot, "rev-parse", "$SourceRef^{commit}") -Capture).Trim()
if ($commit -notmatch "^[0-9a-f]{40}$") {
    throw "Could not resolve a full commit for $SourceRef"
}

$packageAtRef = Invoke-External -Command "git" -Arguments @("-C", $repoRoot, "show", "$commit`:package.json") -Capture
$version = ($packageAtRef | ConvertFrom-Json).version
if ($version -notmatch "^\d+\.\d+\.\d+([-.][0-9A-Za-z.-]+)?$") {
    throw "Invalid package version at $commit"
}

$shortCommit = $commit.Substring(0, 8)
$releaseId = "$version-$shortCommit"
if (-not $ImageName) {
    $ImageName = "catsco-worker-$($version.Replace('.', '-'))-$shortCommit"
}
if ($ImageName.Length -gt 32 -or $ImageName -notmatch "^[A-Za-z][A-Za-z0-9-]*[A-Za-z0-9]$") {
    throw "Image name must satisfy Tianyi Cloud's 2-32 character name rules: $ImageName"
}

if ($BuildNumber) {
    [long]$buildSequence = 0
    [int]$attemptSequence = 0
    if (
        -not [long]::TryParse($BuildNumber, [ref]$buildSequence) -or
        $buildSequence -lt 1 -or
        -not [int]::TryParse($BuildAttempt, [ref]$attemptSequence) -or
        $attemptSequence -lt 1
    ) {
        throw "BuildNumber and BuildAttempt must be positive integers"
    }
    $builderSuffix = "$($buildSequence.ToString('D6'))-$($attemptSequence.ToString('D2'))"
} else {
    $builderSuffix = "$(Get-Date -AsUTC -Format 'yyMMddHHmmss')"
}
$script:BuilderName = "catsco-img-$builderSuffix"
$script:KeyPairName = "catsco-img-key-$builderSuffix"

$resolvedArtifactPath = ""
if ($ArtifactPath) {
    $resolvedArtifactPath = (Resolve-Path $ArtifactPath).Path
    if ($ArtifactSha256 -notmatch "^[0-9a-fA-F]{64}$") {
        throw "ArtifactSha256 is required with ArtifactPath"
    }
    $actualArtifactSha256 = (Get-FileHash -Algorithm SHA256 $resolvedArtifactPath).Hash.ToLowerInvariant()
    if ($actualArtifactSha256 -ne $ArtifactSha256.ToLowerInvariant()) {
        throw "Local worker artifact checksum mismatch"
    }
} elseif ($Mode -eq "Create") {
    throw "ArtifactPath and ArtifactSha256 are required in Create mode"
} elseif ($ArtifactSha256) {
    throw "ArtifactSha256 cannot be used without ArtifactPath"
}

$plan = [ordered]@{
    mode = $Mode
    sourceRef = $SourceRef
    version = $version
    commit = $commit
    imageName = $ImageName
    builderName = $script:BuilderName
    regionID = $RegionID
    azName = $AzName
    baseImageID = $BaseImageID
    flavorID = $FlavorID
    vpcID = $VpcID
    subnetID = $SubnetID
    securityGroupID = $SecurityGroupID
    bootDisk = "$BootDiskType $BootDiskSize GiB"
    artifactSource = $(if ($resolvedArtifactPath) { "local source-free CI artifact" } else { "not supplied in plan mode" })
    mutatesExistingWorkers = $false
}
$plan | ConvertTo-Json

if ($Mode -eq "Plan") {
    exit 0
}

$existing = Invoke-Ctyun @(
    "ims", "ListImage",
    "--regionID", $RegionID,
    "--imageVisibilityCode", "0",
    "--imageName", $ImageName,
    "--pageNo", "1",
    "--pageSize", "10"
)
if (@($existing.returnObj.images).Count -gt 0) {
    throw "Private image already exists: $ImageName"
}

$script:TemporaryRoot = Join-Path ([IO.Path]::GetTempPath()) "catsco-image-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $script:TemporaryRoot | Out-Null
$privateKey = Join-Path $script:TemporaryRoot "builder-rsa"
$publicKeyPath = "$privateKey.pub"
$knownHosts = Join-Path $script:TemporaryRoot "known_hosts"
$remoteBuildScript = Join-Path $script:TemporaryRoot "build-image.sh"
$primaryFailure = $null
$cleanupFailure = $null
$result = $null

try {
    Invoke-External -Command "ssh-keygen" -Arguments @(
        "-q", "-t", "rsa", "-b", "3072",
        "-N", "",
        "-C", "catsco-image-builder-$shortCommit",
        "-f", $privateKey
    )
    $publicKey = (Get-Content $publicKeyPath -Raw).Trim()
    $existingKeyPairResponse = Invoke-Ctyun @(
        "ecs", "GetEcsKeypairDetails",
        "--regionID", $RegionID,
        "--projectID", $ProjectID,
        "--keyPairName", $script:KeyPairName,
        "--pageNo", "1",
        "--pageSize", "10"
    )
    $existingKeyPairs = @(
        @($existingKeyPairResponse.returnObj.results) |
            Where-Object { [string]$_.keyPairName -eq $script:KeyPairName }
    )
    if ($existingKeyPairs.Count -gt 0) {
        throw "Temporary key pair name is already in use: $script:KeyPairName"
    }

    $script:KeyPairCreateAttempted = $true
    Invoke-Ctyun @(
        "ecs", "ImportEcsKeypair",
        "--regionID", $RegionID,
        "--projectID", $ProjectID,
        "--keyPairName", $script:KeyPairName,
        "--keyPairDescription", "Temporary CatsCo image builder",
        "--publicKey", $publicKey
    ) | Out-Null

    $keyPairResponse = Invoke-Ctyun @(
        "ecs", "GetEcsKeypairDetails",
        "--regionID", $RegionID,
        "--projectID", $ProjectID,
        "--keyPairName", $script:KeyPairName,
        "--pageNo", "1",
        "--pageSize", "10"
    )
    $keyPair = @($keyPairResponse.returnObj.results) |
        Where-Object { [string]$_.keyPairName -eq $script:KeyPairName } |
        Select-Object -First 1
    if (-not $keyPair.keyPairID) {
        throw "Imported key pair could not be resolved"
    }

    $existingBuilderResponse = Invoke-Ctyun @(
        "ecs", "ListEcsInstances",
        "--regionID", $RegionID,
        "--instanceName", $script:BuilderName,
        "--pageNo", "1",
        "--pageSize", "10"
    )
    $existingBuilders = @(
        @($existingBuilderResponse.returnObj.results) |
            Where-Object { [string]$_.instanceName -eq $script:BuilderName }
    )
    if ($existingBuilders.Count -gt 0) {
        throw "Temporary builder name is already in use: $script:BuilderName"
    }

    $script:BuilderCreateAttempted = $true
    $createResponse = Invoke-Ctyun @(
        "ecs", "CreateEcsInstance",
        "--regionID", $RegionID,
        "--projectID", $ProjectID,
        "--clientToken", ([guid]::NewGuid().ToString()),
        "--azName", $AzName,
        "--displayName", $script:BuilderName,
        "--instanceName", $script:BuilderName,
        "--instanceDescription", "Temporary CatsCo image builder for $releaseId",
        "--flavorID", $FlavorID,
        "--imageID", $BaseImageID,
        "--imageType", "1",
        "--bootDiskType", $BootDiskType,
        "--bootDiskSize", "$BootDiskSize",
        "--vpcID", $VpcID,
        "--networkCardList", "[{`"isMaster`":true,`"subnetID`":`"$SubnetID`"}]",
        "--secGroupList", "[`"$SecurityGroupID`"]",
        "--keyPairID", $keyPair.keyPairID,
        "--onDemand", "true",
        "--extIP", "1",
        "--bandwidth", "$BuilderBandwidth",
        "--ipVersion", "ipv4",
        "--lineType", "standalone",
        "--demandBillingType", "upflowc",
        "--monitorService", "false",
        "--securityProduct", "false",
        "--trustInstance", "false",
        "--labelList", "[{`"labelKey`":`"purpose`",`"labelValue`":`"catsco-image-builder`"},{`"labelKey`":`"commit`",`"labelValue`":`"$shortCommit`"}]"
    )
    $script:BuilderResourceID = [string]$createResponse.returnObj.masterResourceID
    if (-not $script:BuilderResourceID) {
        throw "CreateEcsInstance did not return masterResourceID"
    }

    $builder = Resolve-BuilderInstance -WaitSeconds ($TimeoutMinutes * 60)
    if (-not $builder) {
        throw "Timed out resolving the temporary builder instance"
    }
    Assert-TemporaryBuilder $builder

    $builder = Wait-ForInstance -States @("running", "active") -RequireIP
    $script:BuilderIP = [string]$builder.floatingIP
    Wait-ForSsh -IP $script:BuilderIP -PrivateKey $privateKey -KnownHosts $knownHosts

    $artifactName = "catsco-worker-$releaseId-linux-x64.tar.gz"
    $remoteScriptContent = @"
#!/usr/bin/env bash
set -Eeuo pipefail
ARTIFACT='/tmp/$artifactName'
bash /tmp/prepare-image.sh \
  --artifact "`$ARTIFACT" \
  --sha256 '$ArtifactSha256' \
  --version '$version' \
  --commit '$commit'
rm -f "`$ARTIFACT"
bash /tmp/prepare-image.sh --finalize
"@
    [IO.File]::WriteAllText(
        $remoteBuildScript,
        $remoteScriptContent,
        [Text.UTF8Encoding]::new($false)
    )

    $sshOptions = @(
        "-i", $privateKey,
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=10",
        "-o", "ServerAliveInterval=15",
        "-o", "ServerAliveCountMax=3",
        "-o", "StrictHostKeyChecking=accept-new",
        "-o", "UserKnownHostsFile=$knownHosts"
    )
    Invoke-External -Command "timeout" -Arguments (@(
        "--signal=TERM",
        "--kill-after=30s",
        "$($ArtifactTransferTimeoutMinutes)m",
        "scp"
    ) + $sshOptions + @(
        $resolvedArtifactPath,
        "root@$($script:BuilderIP):/tmp/$artifactName"
    ))
    Invoke-External -Command "timeout" -Arguments (@(
        "--signal=TERM",
        "--kill-after=30s",
        "5m",
        "scp"
    ) + $sshOptions + @(
        "$PSScriptRoot/prepare-image.sh",
        $remoteBuildScript,
        "root@$($script:BuilderIP):/tmp/"
    ))
    Invoke-External -Command "timeout" -Arguments (@(
        "--signal=TERM",
        "--kill-after=150s",
        "$($RemoteBuildTimeoutMinutes + 3)m",
        "ssh"
    ) + $sshOptions + @(
        "root@$($script:BuilderIP)",
        "chmod 700 /tmp/build-image.sh /tmp/prepare-image.sh && timeout --signal=TERM --kill-after=120s $($RemoteBuildTimeoutMinutes)m bash /tmp/build-image.sh"
    ))

    $builder = Resolve-BuilderInstance
    Assert-TemporaryBuilder $builder
    Invoke-Ctyun @(
        "ecs", "StopEcsInstance",
        "--regionID", $RegionID,
        "--instanceID", $script:BuilderID,
        "--force", "false"
    ) | Out-Null
    Wait-ForInstance -States @("stopped", "shutoff") | Out-Null

    $script:ImageCreateAttempted = $true
    $imageResponse = Invoke-Ctyun @(
        "ims", "CreateImage",
        "--regionID", $RegionID,
        "--projectID", $ProjectID,
        "--instanceID", $script:BuilderID,
        "--imageName", $ImageName,
        "--description", "CatsCo worker $version commit $commit",
        "--enableImageIntegrityCheck", "true",
        "--labels", "[{`"labelKey`":`"product`",`"labelValue`":`"catsco-worker`"},{`"labelKey`":`"version`",`"labelValue`":`"$version`"},{`"labelKey`":`"commit`",`"labelValue`":`"$commit`"}]"
    )
    $image = @($imageResponse.returnObj.images) | Select-Object -First 1
    $script:ImageID = [string]$image.imageID
    if (-not $script:ImageID) {
        throw "CreateImage did not return an image ID"
    }

    $deadline = (Get-Date).AddMinutes($TimeoutMinutes)
    while ((Get-Date) -lt $deadline) {
        $currentImage = Get-Image -ImageID $script:ImageID
        if (-not $currentImage) {
            throw "Private image disappeared during creation"
        }
        $status = ([string]$currentImage.imageStatus).ToLowerInvariant()
        Write-Host "image state=$status progress=$($currentImage.taskProgress)"
        if ($status -eq "active") {
            $script:ImageActive = $true
            $script:Completed = $true
            $result = [ordered]@{
                result = "created"
                imageID = $script:ImageID
                imageName = $ImageName
                version = $version
                commit = $commit
                builderName = $script:BuilderName
                regionID = $RegionID
            }
            break
        }
        if ($status -in @("error", "killed", "deleted")) {
            throw "Image creation entered terminal failure state: $status"
        }
        Start-Sleep -Seconds 15
    }
    if (-not $script:Completed) {
        throw "Timed out waiting for private image creation"
    }
} catch {
    $primaryFailure = $_.Exception.Message
} finally {
    try {
        Remove-TemporaryResources -Failure:(-not $script:Completed)
    } catch {
        $cleanupFailure = $_.Exception.Message
    }
    if ($script:TemporaryRoot -and (Test-Path $script:TemporaryRoot)) {
        try {
            Remove-Item -LiteralPath $script:TemporaryRoot -Recurse -Force
        } catch {
            if ($cleanupFailure) {
                $cleanupFailure += "`nlocal cleanup: $($_.Exception.Message)"
            } else {
                $cleanupFailure = "local cleanup: $($_.Exception.Message)"
            }
        }
    }
}

if ($primaryFailure -or $cleanupFailure) {
    $failures = [Collections.Generic.List[string]]::new()
    if ($primaryFailure) {
        $failures.Add("bake failure: $primaryFailure")
    }
    if ($cleanupFailure) {
        $failures.Add("cleanup failure: $cleanupFailure")
    }
    throw ($failures -join "`n")
}

$result | ConvertTo-Json
