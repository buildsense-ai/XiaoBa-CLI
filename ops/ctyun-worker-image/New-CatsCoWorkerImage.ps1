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
    [string]$ArtifactUrl = "",
    [string]$ArtifactSha256 = "",
    [string]$BootDiskType = "SATA",
    [ValidateRange(40, 2048)]
    [int]$BootDiskSize = 40,
    [ValidateRange(1, 300)]
    [int]$BuilderBandwidth = 5,
    [ValidateRange(10, 120)]
    [int]$TimeoutMinutes = 50,
    [switch]$KeepBuilderOnFailure
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$script:BuilderID = ""
$script:BuilderName = ""
$script:BuilderResourceID = ""
$script:BuilderIP = ""
$script:KeyPairName = ""
$script:TemporaryRoot = ""
$script:Completed = $false

function Invoke-External {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Command,
        [Parameter(Mandatory = $true)]
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

function Assert-TemporaryBuilder {
    param([Parameter(Mandatory = $true)]$Instance)

    if (-not $Instance) {
        throw "Temporary builder instance was not found"
    }
    if ($Instance.instanceID -ne $script:BuilderID) {
        throw "Refusing to operate on an instance outside this bake"
    }
    if (-not [string]$Instance.instanceName -or -not $Instance.instanceName.StartsWith("catsco-img-")) {
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
        $instance = Get-Instance -InstanceID $script:BuilderID
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
            -o StrictHostKeyChecking=accept-new `
            -o "UserKnownHostsFile=$KnownHosts" `
            "root@$IP" "cloud-init status --wait >/dev/null 2>&1; printf ready" 2>$null
        if ($LASTEXITCODE -eq 0) {
            return
        }
        Start-Sleep -Seconds 8
    }
    throw "Timed out waiting for SSH on temporary builder"
}

function Remove-TemporaryResources {
    param([switch]$Failure)

    if ($Failure -and $KeepBuilderOnFailure) {
        Write-Warning "Keeping temporary builder for diagnosis: $script:BuilderID ($script:BuilderIP)"
        return
    }

    if ($script:BuilderID) {
        try {
            $instance = Get-Instance -InstanceID $script:BuilderID
            if ($instance) {
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
                $deleteDeadline = (Get-Date).AddMinutes(8)
                while ((Get-Date) -lt $deleteDeadline) {
                    Start-Sleep -Seconds 8
                    try {
                        $remaining = Get-Instance -InstanceID $script:BuilderID
                        if (-not $remaining) {
                            break
                        }
                        Assert-TemporaryBuilder $remaining
                    } catch {
                        if ($_.Exception.Message -match "not found|does not exist|不存在") {
                            break
                        }
                        throw
                    }
                }
            }
        } catch {
            Write-Warning "Could not delete temporary builder: $($_.Exception.Message)"
        }
    }

    if ($script:KeyPairName) {
        try {
            Write-Host "Deleting temporary key pair $script:KeyPairName"
            Invoke-Ctyun @(
                "ecs", "DeleteEcsKeypair",
                "--regionID", $RegionID,
                "--keyPairName", $script:KeyPairName
            ) | Out-Null
        } catch {
            Write-Warning "Could not delete temporary key pair: $($_.Exception.Message)"
        }
    }
}

foreach ($command in @("ctyun-cli", "git", "ssh", "scp", "ssh-keygen")) {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
        throw "Missing required command: $command"
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
if ($ArtifactUrl) {
    if ($ArtifactUrl -notmatch "^https://") {
        throw "ArtifactUrl must use HTTPS"
    }
    if ($ArtifactSha256 -notmatch "^[0-9a-fA-F]{64}$") {
        throw "ArtifactSha256 is required with ArtifactUrl"
    }
} elseif ($ArtifactSha256) {
    throw "ArtifactSha256 cannot be used without ArtifactUrl"
}

$plan = [ordered]@{
    mode = $Mode
    sourceRef = $SourceRef
    version = $version
    commit = $commit
    imageName = $ImageName
    builderPrefix = "catsco-img-"
    regionID = $RegionID
    azName = $AzName
    baseImageID = $BaseImageID
    flavorID = $FlavorID
    vpcID = $VpcID
    subnetID = $SubnetID
    securityGroupID = $SecurityGroupID
    bootDisk = "$BootDiskType $BootDiskSize GiB"
    artifactSource = $(if ($ArtifactUrl) { $ArtifactUrl } else { "local git archive built on temporary ECS" })
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
$sourceArchive = Join-Path $script:TemporaryRoot "catsco-source.tar"
$privateKey = Join-Path $script:TemporaryRoot "builder-rsa"
$publicKeyPath = "$privateKey.pub"
$knownHosts = Join-Path $script:TemporaryRoot "known_hosts"
$remoteBuildScript = Join-Path $script:TemporaryRoot "build-image.sh"

try {
    if (-not $ArtifactUrl) {
        Invoke-External -Command "git" -Arguments @(
            "-C", $repoRoot,
            "archive",
            "--format=tar",
            "--output=$sourceArchive",
            $commit
        )
    }

    Invoke-External -Command "ssh-keygen" -Arguments @(
        "-q", "-t", "rsa", "-b", "3072",
        "-N", "",
        "-C", "catsco-image-builder-$shortCommit",
        "-f", $privateKey
    )
    $publicKey = (Get-Content $publicKeyPath -Raw).Trim()
    $script:KeyPairName = "catsco-img-key-$shortCommit-$((Get-Date).ToString('HHmmss'))"
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
    $keyPair = @($keyPairResponse.returnObj.results) | Select-Object -First 1
    if (-not $keyPair.keyPairID) {
        throw "Imported key pair could not be resolved"
    }

    $script:BuilderName = "catsco-img-$shortCommit-$((Get-Date).ToString('HHmmss'))"
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

    $deadline = (Get-Date).AddMinutes($TimeoutMinutes)
    while ((Get-Date) -lt $deadline -and -not $script:BuilderID) {
        $lookup = Invoke-Ctyun @(
            "ecs", "ListEcsInstances",
            "--regionID", $RegionID,
            "--resourceID", $script:BuilderResourceID,
            "--pageNo", "1",
            "--pageSize", "10"
        )
        $candidate = @($lookup.returnObj.results) | Select-Object -First 1
        if ($candidate) {
            if (-not ([string]$candidate.instanceName).StartsWith("catsco-img-")) {
                throw "Resource lookup returned a non-builder instance"
            }
            $script:BuilderID = [string]$candidate.instanceID
            break
        }
        Start-Sleep -Seconds 8
    }
    if (-not $script:BuilderID) {
        throw "Timed out resolving the temporary builder instance"
    }

    $builder = Wait-ForInstance -States @("running", "active") -RequireIP
    $script:BuilderIP = [string]$builder.floatingIP
    Wait-ForSsh -IP $script:BuilderIP -PrivateKey $privateKey -KnownHosts $knownHosts

    $artifactName = "catsco-worker-$releaseId-linux-x64.tar.gz"
    if ($ArtifactUrl) {
        $artifactPreparation = @"
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl nodejs npm
curl --fail --location --retry 6 --retry-all-errors \
  --connect-timeout 10 --max-time 900 \
  '$ArtifactUrl' -o "`$ARTIFACT"
SHA256='$ArtifactSha256'
"@
    } else {
        $artifactPreparation = @"
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends build-essential ca-certificates nodejs npm python3
npm config set registry https://registry.npmmirror.com

rm -rf /tmp/catsco-source
mkdir -p /tmp/catsco-source
tar -xf /tmp/catsco-source.tar -C /tmp/catsco-source
cd /tmp/catsco-source
npm ci --ignore-scripts --prefer-offline --no-audit --fund=false
npm run build
node scripts/build-linux-worker-artifact.mjs --archive-source --output "`$ARTIFACT" --version "`$VERSION" --commit "`$COMMIT"
SHA256="`$(awk '{print `$1}' "`$ARTIFACT.sha256")"
"@
    }
    $remoteScriptContent = @"
#!/usr/bin/env bash
set -Eeuo pipefail
VERSION='$version'
COMMIT='$commit'
ARTIFACT='/tmp/$artifactName'

$artifactPreparation
bash /tmp/prepare-image.sh \
  --artifact "`$ARTIFACT" \
  --sha256 "`$SHA256" \
  --version "`$VERSION" \
  --commit "`$COMMIT"
rm -rf /tmp/catsco-source /tmp/catsco-source.tar "`$ARTIFACT" "`$ARTIFACT.sha256"
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
        "-o", "StrictHostKeyChecking=accept-new",
        "-o", "UserKnownHostsFile=$knownHosts"
    )
    $filesToCopy = @("$PSScriptRoot/prepare-image.sh", $remoteBuildScript)
    if (-not $ArtifactUrl) {
        $filesToCopy = @($sourceArchive) + $filesToCopy
    }
    Invoke-External -Command "scp" -Arguments ($sshOptions + $filesToCopy + @(
        "root@$($script:BuilderIP):/tmp/"
    ))
    Invoke-External -Command "ssh" -Arguments ($sshOptions + @(
        "root@$($script:BuilderIP)",
        "chmod 700 /tmp/build-image.sh /tmp/prepare-image.sh && bash /tmp/build-image.sh"
    ))

    $builder = Get-Instance -InstanceID $script:BuilderID
    Assert-TemporaryBuilder $builder
    Invoke-Ctyun @(
        "ecs", "StopEcsInstance",
        "--regionID", $RegionID,
        "--instanceID", $script:BuilderID,
        "--force", "false"
    ) | Out-Null
    Wait-ForInstance -States @("stopped", "shutoff") | Out-Null

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
    $imageID = [string]$image.imageID
    if (-not $imageID) {
        throw "CreateImage did not return an image ID"
    }

    $deadline = (Get-Date).AddMinutes($TimeoutMinutes)
    while ((Get-Date) -lt $deadline) {
        $detail = Invoke-Ctyun @(
            "ims", "GetImageDetail",
            "--regionID", $RegionID,
            "--imageID", $imageID,
            "--errorFree", "false"
        )
        $currentImage = @($detail.returnObj.images) | Select-Object -First 1
        $status = ([string]$currentImage.imageStatus).ToLowerInvariant()
        Write-Host "image state=$status progress=$($currentImage.taskProgress)"
        if ($status -eq "active") {
            $script:Completed = $true
            [ordered]@{
                result = "created"
                imageID = $imageID
                imageName = $ImageName
                version = $version
                commit = $commit
                regionID = $RegionID
            } | ConvertTo-Json
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
    Write-Error $_
    throw
} finally {
    Remove-TemporaryResources -Failure:(-not $script:Completed)
    if ($script:TemporaryRoot -and (Test-Path $script:TemporaryRoot)) {
        Remove-Item -LiteralPath $script:TemporaryRoot -Recurse -Force
    }
}
