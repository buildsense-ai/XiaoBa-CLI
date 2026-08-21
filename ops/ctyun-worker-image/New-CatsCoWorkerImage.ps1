[CmdletBinding()]
param(
    [ValidateSet("Plan", "Create", "Cleanup")]
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

    [Alias("ProjectID")]
    [string]$BuilderProjectID = "0",
    [string]$ImageProjectID = "0",
    [string]$SourceRef = "HEAD",
    [string]$ImageName = "",
    [string]$ArtifactPath = "",
    [string]$ArtifactSha256 = "",
    [string]$ArtifactUrl = "",
    [string]$PrepareScriptUrl = "",
    [string]$PrepareScriptSha256 = "",
    [string]$BootstrapStatusPutUrl = "",
    [string]$BootstrapStatusGetUrl = "",
    [string]$BuildNumber = "",
    [string]$BuildAttempt = "1",
    [string]$BuildIdentity = "",
    [string]$BootDiskType = "SATA",
    [ValidateRange(40, 2048)]
    [int]$BootDiskSize = 40,
    [ValidateRange(10, 120)]
    [int]$TimeoutMinutes = 50,
    [ValidateRange(60, 300)]
    [int]$BakeTimeoutMinutes = 240,
    [ValidateRange(10, 90)]
    [int]$CleanupTimeoutMinutes = 45,
    [ValidateRange(1, 120)]
    [int]$ImageDeleteConfirmMinutes = 8,
    [ValidateRange(0, 120)]
    [int]$ImageDeleteConfirmSeconds = 0,
    [ValidateRange(15, 300)]
    [int]$ApiTimeoutSeconds = 90,
    [ValidateRange(5, 300)]
    [int]$LateResourceWaitSeconds = 120,
    [ValidateRange(0, 60)]
    [int]$PollIntervalSeconds = 0,
    [ValidateRange(5, 300)]
    [int]$ProgressIntervalSeconds = 30,
    [ValidateRange(1, 30)]
    [int]$BootstrapStartTimeoutMinutes = 5,
    [ValidateRange(60, 1800)]
    [int]$BootstrapStaleSeconds = 180,
    [switch]$BaseImageHardened,
    [switch]$WaitForLateResources
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$script:BuilderID = ""
$script:BuilderName = ""
$script:BuilderResourceID = ""
$script:BuilderCreateAttempted = $false
$script:KeyPairName = ""
$script:KeyPairID = ""
$script:KeyPairCreateAttempted = $false
$script:TemporaryRoot = ""
$script:ImageID = ""
$script:ImageCreateAttempted = $false
$script:ImageActive = $false
$script:PreserveBuilderForImageRecovery = $false
$script:Completed = $false
$script:BakeID = ""
$script:ImageWorkName = ""
$script:BakeDescription = ""
$script:OperationDeadline = $null
$script:CleanupDeadline = $null
$script:InCleanup = $false
$script:StartedAt = Get-Date
$script:LastProgressAt = $script:StartedAt
$script:BootstrapMonitorStartedAt = $null
$script:LastBootstrapPayload = ""
$script:LastBootstrapUpdateAt = $null
$script:LastBootstrapPhase = ""

function Write-BakeProgress {
    param(
        [Parameter(Mandatory = $true)][string]$Phase,
        [string]$Detail = "",
        [switch]$Force
    )

    $now = Get-Date
    if (-not $Force -and (($now - $script:LastProgressAt).TotalSeconds -lt $ProgressIntervalSeconds)) {
        return
    }
    $script:LastProgressAt = $now
    $elapsed = [int][Math]::Floor(($now - $script:StartedAt).TotalSeconds)
    $deadline = Get-ActiveDeadline
    $remaining = if ($deadline) {
        [Math]::Max(0, [int][Math]::Floor(($deadline - $now).TotalSeconds))
    } else {
        -1
    }
    $suffix = if ([string]::IsNullOrWhiteSpace($Detail)) { "" } else { " $Detail" }
    Write-Host ("{0} bake-progress phase={1} elapsed_s={2} remaining_s={3}{4}" -f `
        $now.ToUniversalTime().ToString("o"), $Phase, $elapsed, $remaining, $suffix)
}

function Wait-PollInterval {
    param([Parameter(Mandatory = $true)][int]$DefaultSeconds)

    $seconds = if ($PollIntervalSeconds -gt 0) {
        [Math]::Max(1, [Math]::Min($DefaultSeconds, $PollIntervalSeconds))
    } else {
        $DefaultSeconds
    }
    Start-Sleep -Seconds $seconds
}

function Test-BootstrapStatus {
    if ([string]::IsNullOrWhiteSpace($BootstrapStatusGetUrl)) {
        return
    }

    $now = Get-Date
    if (-not $script:BootstrapMonitorStartedAt) {
        $script:BootstrapMonitorStartedAt = $now
    }

    $payload = ""
    try {
        $response = Invoke-WebRequest `
            -Uri $BootstrapStatusGetUrl `
            -Method Get `
            -TimeoutSec 15 `
            -Headers @{ "Cache-Control" = "no-cache" }
        $payload = [string]$response.Content
    } catch {
        # A status object does not exist until cloud-init starts. Network and
        # 404 failures are handled by the bounded missing/stale checks below.
    }

    if (-not [string]::IsNullOrWhiteSpace($payload)) {
        if ($payload -ne $script:LastBootstrapPayload) {
            $script:LastBootstrapPayload = $payload
            $script:LastBootstrapUpdateAt = $now
        }
        try {
            $status = $payload | ConvertFrom-Json
        } catch {
            throw "Builder bootstrap returned malformed status telemetry"
        }
        $state = ([string]$status.state).ToLowerInvariant()
        $phase = [string]$status.phase
        if ($state -notin @("running", "succeeded", "failed") -or [string]::IsNullOrWhiteSpace($phase)) {
            throw "Builder bootstrap returned invalid status telemetry"
        }
        $age = [Math]::Max(0, [int](($now - $script:LastBootstrapUpdateAt).TotalSeconds))
        if ($phase -ne $script:LastBootstrapPhase -or $state -ne "running") {
            Write-BakeProgress -Phase "builder-bootstrap" -Detail ("state={0} phase={1} heartbeat_age_s={2}" -f $state, $phase, $age) -Force
            $script:LastBootstrapPhase = $phase
        }
        if ($state -eq "failed") {
            $exitCode = [string]$status.exit_code
            $line = [string]$status.line
            throw "Builder bootstrap failed: phase=$phase exit_code=$exitCode line=$line"
        }
        if ($age -gt $BootstrapStaleSeconds) {
            throw "Builder bootstrap heartbeat is stale: phase=$phase age_seconds=$age"
        }
        return
    }

    if ($script:LastBootstrapUpdateAt) {
        $staleSeconds = [int](($now - $script:LastBootstrapUpdateAt).TotalSeconds)
        if ($staleSeconds -gt $BootstrapStaleSeconds) {
            throw "Builder bootstrap status is unreachable or stale: phase=$script:LastBootstrapPhase age_seconds=$staleSeconds"
        }
        return
    }

    $missingSeconds = [int](($now - $script:BootstrapMonitorStartedAt).TotalSeconds)
    if ($missingSeconds -gt ($BootstrapStartTimeoutMinutes * 60)) {
        throw "Builder bootstrap did not publish initial status within $BootstrapStartTimeoutMinutes minutes"
    }
}

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

function Get-PropertyValue {
    param(
        [AllowNull()]
        [object]$InputObject,
        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    if ($null -eq $InputObject) {
        return $null
    }
    $property = $InputObject.PSObject.Properties[$Name]
    if (-not $property) {
        return $null
    }
    return $property.Value
}

function Get-ResponseItems {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Response,
        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    $returnObject = Get-PropertyValue -InputObject $Response -Name "returnObj"
    return @(
        Get-PropertyValue -InputObject $returnObject -Name $Name
    )
}

function Invoke-Ctyun {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)

    $operation = if ($Arguments.Count -ge 2) {
        "$($Arguments[0])/$($Arguments[1])"
    } else {
        ($Arguments -join "/")
    }
    Write-BakeProgress -Phase "api-start" -Detail "operation=$operation" -Force
    $apiStartedAt = Get-Date
    $timeoutSeconds = Get-BoundedTimeoutSeconds `
        -RequestedSeconds $ApiTimeoutSeconds `
        -Phase "Tianyi Cloud API call"
    $raw = Invoke-External -Command "timeout" -Arguments (@(
        "--signal=TERM",
        "--kill-after=15s",
        "$($timeoutSeconds)s",
        "ctyun-cli"
    ) + $Arguments + @("--output", "json")) -Capture
    try {
        $response = $raw | ConvertFrom-Json
    } catch {
        throw "ctyun-cli returned non-JSON output: $raw"
    }
    $statusCode = Get-PropertyValue -InputObject $response -Name "statusCode"
    if ($statusCode -ne 800) {
        $errorCode = Get-PropertyValue -InputObject $response -Name "errorCode"
        $message = Get-PropertyValue -InputObject $response -Name "message"
        $description = Get-PropertyValue -InputObject $response -Name "description"
        throw "Tianyi Cloud API failed: $errorCode $message $description"
    }
    Write-BakeProgress -Phase "api-ok" -Detail ("operation={0} duration_ms={1}" -f `
        $operation, [int][Math]::Round(((Get-Date) - $apiStartedAt).TotalMilliseconds)) -Force
    return $response
}

function Get-ActiveDeadline {
    if ($script:InCleanup) {
        return $script:CleanupDeadline
    }
    return $script:OperationDeadline
}

function Get-BoundedTimeoutSeconds {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateRange(1, 86400)]
        [int]$RequestedSeconds,
        [Parameter(Mandatory = $true)]
        [string]$Phase
    )

    $deadline = Get-ActiveDeadline
    if (-not $deadline) {
        return $RequestedSeconds
    }
    $remaining = [int][Math]::Floor(($deadline - (Get-Date)).TotalSeconds)
    if ($remaining -lt 1) {
        throw "$Phase cannot start because the current bake deadline has expired"
    }
    return [Math]::Max(1, [Math]::Min($RequestedSeconds, $remaining))
}

function Get-BoundedDeadline {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateRange(0, 86400)]
        [int]$RequestedSeconds,
        [Parameter(Mandatory = $true)]
        [string]$Phase
    )

    if ($RequestedSeconds -eq 0) {
        return Get-Date
    }

    $deadline = (Get-Date).AddSeconds($RequestedSeconds)
    $activeDeadline = Get-ActiveDeadline
    if ($activeDeadline -and $activeDeadline -lt $deadline) {
        $deadline = $activeDeadline
    }
    if ($deadline -le (Get-Date)) {
        throw "$Phase cannot start because the current bake deadline has expired"
    }
    return $deadline
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
    return @(Get-ResponseItems -Response $response -Name "results") |
        Select-Object -First 1
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
        foreach ($candidate in @(Get-ResponseItems -Response $response -Name "results")) {
            # A just-created instance is returned by the provider with a valid
            # name and resourceID but an EMPTY instanceID for a few seconds
            # (eventual consistency). Claiming it would record an empty
            # BuilderID and immediately fail Assert-TemporaryBuilder with
            # 'outside this bake', so only accept candidates whose immutable
            # instanceID is already populated; Resolve-BuilderInstance retries
            # until it appears.
            if (
                [string]$candidate.instanceID -and
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

    $deadline = Get-BoundedDeadline `
        -RequestedSeconds $WaitSeconds `
        -Phase "temporary builder resolution"
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
            # Once the provider returned an authoritative instance ID, never
            # fall back to a possibly reused instance name. A missing result can
            # still be an eventually-consistent read, so retry the same ID when
            # the caller requested a discovery window.
            if ((Get-Date) -ge $deadline) {
                break
            }
            $sleepSeconds = [Math]::Max(
                1,
                [Math]::Min(8, [int][Math]::Ceiling(($deadline - (Get-Date)).TotalSeconds))
            )
            Wait-PollInterval -DefaultSeconds $sleepSeconds
            continue
        }

        $resolved = Find-BuilderInstance
        if ($resolved) {
            return $resolved
        }
        if ((Get-Date) -ge $deadline) {
            break
        }
        Wait-PollInterval -DefaultSeconds 8
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
        [switch]$RequireIP,
        [switch]$MonitorBootstrap
    )

    $deadline = Get-BoundedDeadline `
        -RequestedSeconds ($TimeoutMinutes * 60) `
        -Phase "temporary builder state wait"
    while ((Get-Date) -lt $deadline) {
        $instance = Resolve-BuilderInstance
        Assert-TemporaryBuilder $instance
        $state = ([string]$instance.instanceStatus).ToLowerInvariant()
        $ip = [string]$instance.floatingIP
        Write-BakeProgress -Phase "builder-wait" -Detail ("state={0} ip_present={1}" -f $state, (-not [string]::IsNullOrWhiteSpace($ip))) -Force
        if ($States -contains $state -and (-not $RequireIP -or $ip)) {
            return $instance
        }
        if ($MonitorBootstrap) {
            Test-BootstrapStatus
        }
        Wait-PollInterval -DefaultSeconds 8
    }
    throw "Timed out waiting for builder state: $($States -join ', ')"
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
        return @(Get-ResponseItems -Response $detail -Name "images") |
            Select-Object -First 1
    } catch {
        if (Test-NotFoundError $_.Exception.Message) {
            return $null
        }
        throw
    }
}

function Find-ImageByName {
    param([Parameter(Mandatory = $true)][string]$Name)

    $response = Invoke-Ctyun @(
        "ims", "ListImage",
        "--regionID", $RegionID,
        "--imageVisibilityCode", "0",
        "--imageName", $Name,
        "--projectID", $ImageProjectID,
        "--pageNo", "1",
        "--pageSize", "200"
    )
    return @(Get-ResponseItems -Response $response -Name "images") |
        Where-Object { [string]$_.imageName -eq $Name } |
        Select-Object -First 1
}

function Wait-ForPublishedImageIdentity {
    param(
        [Parameter(Mandatory = $true)][string]$PublishedImageID,
        [Parameter(Mandatory = $true)][string]$PublishedImageName,
        [Parameter(Mandatory = $true)][string]$PublishedDescription
    )

    $publishDeadline = Get-BoundedDeadline `
        -RequestedSeconds (2 * 60) `
        -Phase "published image identity verification"
    do {
        $candidate = Get-Image -ImageID $PublishedImageID
        if (
            $candidate -and
            ([string]$candidate.imageStatus).ToLowerInvariant() -eq "active" -and
            [string]$candidate.imageName -eq $PublishedImageName -and
            [string]$candidate.description -eq $PublishedDescription
        ) {
            return $candidate
        }
        Wait-PollInterval -DefaultSeconds 5
    } while ((Get-Date) -lt $publishDeadline)

    throw "Could not verify the published private image identity"
}

function Remove-FailedImage {
    if ($script:ImageActive -or (-not $script:ImageCreateAttempted -and -not $script:ImageID)) {
        return
    }

    # Keep the source builder as ownership evidence until the image is gone.
    $script:PreserveBuilderForImageRecovery = $true
    if (-not $script:ImageID) {
        $resolveDeadline = Get-BoundedDeadline `
            -RequestedSeconds (3 * 60) `
            -Phase "incomplete image resolution"
        while ((Get-Date) -lt $resolveDeadline -and -not $script:ImageID) {
            $candidate = Find-ImageByName -Name $script:ImageWorkName
            if ($candidate) {
                if (
                    -not $script:BuilderID -or
                    [string]$candidate.sourceServerID -ne $script:BuilderID
                ) {
                    $script:PreserveBuilderForImageRecovery = $false
                    throw (
                        "Refusing to delete image '$($candidate.imageID)' because " +
                        "sourceServerID '$($candidate.sourceServerID)' does not match " +
                        "this bake's builder '$script:BuilderID'"
                    )
                }
                $script:ImageID = [string]$candidate.imageID
                break
            }
            Wait-PollInterval -DefaultSeconds 10
        }
        if (-not $script:ImageID) {
            throw "Could not prove absence of incomplete image $script:ImageWorkName"
        }
    }

    $ownedImage = Get-Image -ImageID $script:ImageID
    if (-not $ownedImage) {
        $script:PreserveBuilderForImageRecovery = $false
        return
    }
    if (
        [string]$ownedImage.imageName -ne $script:ImageWorkName -or
        -not $script:BuilderID -or
        [string]$ownedImage.sourceServerID -ne $script:BuilderID -or
        [string]$ownedImage.description -ne $script:BakeDescription
    ) {
        $script:PreserveBuilderForImageRecovery = $false
        throw (
            "Refusing to delete image '$script:ImageID' because its name, " +
            "sourceServerID, or bake description does not belong to this bake"
        )
    }

    $deadline = Get-BoundedDeadline `
        -RequestedSeconds (12 * 60) `
        -Phase "incomplete image deletable-state wait"
    $deletableStates = @(
        "active", "deactivated", "deactivating", "deleting",
        "error", "killed", "reactivating"
    )
    while ((Get-Date) -lt $deadline) {
        $image = Get-Image -ImageID $script:ImageID
        if (-not $image) {
            $script:PreserveBuilderForImageRecovery = $false
            return
        }
        $status = ([string]$image.imageStatus).ToLowerInvariant()
        Write-Host "failed image cleanup state=$status"
        if ($status -eq "deleted") {
            $script:PreserveBuilderForImageRecovery = $false
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
        Wait-PollInterval -DefaultSeconds 15
    }

    $confirmSeconds = if ($ImageDeleteConfirmSeconds -gt 0) {
        $ImageDeleteConfirmSeconds
    } else {
        $ImageDeleteConfirmMinutes * 60
    }
    $deleteDeadline = Get-BoundedDeadline `
        -RequestedSeconds $confirmSeconds `
        -Phase "incomplete image deletion confirmation"
    while ((Get-Date) -lt $deleteDeadline) {
        $remaining = Get-Image -ImageID $script:ImageID
        if (-not $remaining -or ([string]$remaining.imageStatus).ToLowerInvariant() -eq "deleted") {
            $script:PreserveBuilderForImageRecovery = $false
            return
        }
        Wait-PollInterval -DefaultSeconds 10
    }
    throw "Could not confirm deletion of incomplete image $script:ImageID"
}

function Remove-Builder {
    param([switch]$WaitForLate)

    if (-not $script:BuilderID -and -not $script:BuilderResourceID) {
        Write-Warning "Skipping builder cleanup because no immutable builder identity was recorded"
        return
    }

    $resolveWaitSeconds = if ($WaitForLate) { $LateResourceWaitSeconds } else { 0 }
    $instance = Resolve-BuilderInstance -WaitSeconds $resolveWaitSeconds
    if (-not $instance -and -not $WaitForLate) {
        # A single empty read can be an eventually-consistent response. Require
        # several consecutive empty reads before concluding the builder is gone,
        # otherwise a billed ECS could be left behind after the image is ready.
        $emptyReads = 1
        while ($emptyReads -lt 3) {
            Wait-PollInterval -DefaultSeconds 5
            $instance = Resolve-BuilderInstance
            if ($instance) { break }
            $emptyReads++
        }
    }
    if (-not $instance) {
        Write-Host "No temporary builder record remains for $script:BuilderName"
        return
    }
    Assert-TemporaryBuilder $instance
    Write-Host "Deleting temporary builder $script:BuilderID"
    try {
        Invoke-Ctyun @(
            "ecs", "DeleteEcsInstance",
            "--regionID", $RegionID,
            "--instanceID", $script:BuilderID,
            "--clientToken", ([guid]::NewGuid().ToString()),
            "--deleteEip", "true",
            "--deleteVolume", "true"
        ) | Out-Null
    } catch {
        # Multi-AZ resource pools (e.g. cn-huanan2) reject releasing associated
        # resources at delete time (Ecs.Region.NotSupport). In those pools the
        # EIP is released automatically when the instance is unsubscribed, so
        # retry the plain delete instead of leaking the billed ECS.
        if ($_.Exception.Message -notmatch "NotSupport") {
            throw
        }
        Invoke-Ctyun @(
            "ecs", "DeleteEcsInstance",
            "--regionID", $RegionID,
            "--instanceID", $script:BuilderID,
            "--clientToken", ([guid]::NewGuid().ToString())
        ) | Out-Null
    }

    $deadline = Get-BoundedDeadline `
        -RequestedSeconds (8 * 60) `
        -Phase "temporary builder deletion confirmation"
    $confirmEmptyReads = 0
    while ((Get-Date) -lt $deadline) {
        $remaining = Resolve-BuilderInstance
        if (-not $remaining) {
            $confirmEmptyReads++
            if ($confirmEmptyReads -ge 2) {
                return
            }
        } else {
            $confirmEmptyReads = 0
            Assert-TemporaryBuilder $remaining
        }
        Wait-PollInterval -DefaultSeconds 8
    }
    throw "Could not confirm deletion of temporary builder $script:BuilderID"
}

function Remove-KeyPair {
    param([switch]$WaitForLate)

    if (-not $script:KeyPairName -or -not $script:KeyPairCreateAttempted) {
        Write-Warning "Skipping key pair cleanup because this bake did not create a temporary key pair"
        return
    }
    if (-not $script:KeyPairName.StartsWith("catsco-img-key-")) {
        Write-Warning "Skipping key pair cleanup because '$script:KeyPairName' is not a temporary bake key pair"
        return
    }

    $keyDiscoverySeconds = if ($WaitForLate) { $LateResourceWaitSeconds } else { 0 }
    $keyDiscoveryDeadline = Get-BoundedDeadline `
        -RequestedSeconds $keyDiscoverySeconds `
        -Phase "temporary key pair discovery"
    $existing = @()
    $emptyReads = 0
    do {
        $details = Invoke-Ctyun @(
            "ecs", "GetEcsKeypairDetails",
            "--regionID", $RegionID,
            "--projectID", $BuilderProjectID,
            "--keyPairName", $script:KeyPairName,
            "--pageNo", "1",
            "--pageSize", "10"
        )
        $existing = @(
            @(Get-ResponseItems -Response $details -Name "results") |
                Where-Object { [string]$_.keyPairName -eq $script:KeyPairName }
        )
        if ($existing.Count -gt 0) {
            break
        }
        $emptyReads++
        if (-not $WaitForLate -and $emptyReads -ge 3) {
            break
        }
        if ($WaitForLate -and (Get-Date) -ge $keyDiscoveryDeadline) {
            break
        }
        Wait-PollInterval -DefaultSeconds 5
    } while ($true)
    if ($existing.Count -eq 0) {
        Write-Host "No temporary key pair record remains for $script:KeyPairName"
        return
    }
    if ($script:KeyPairID) {
        $ownedKeyPairs = @(
            $existing | Where-Object {
                [string](Get-PropertyValue -InputObject $_ -Name "keyPairID") -eq $script:KeyPairID
            }
        )
        if ($ownedKeyPairs.Count -ne 1 -or $existing.Count -ne 1) {
            throw "Refusing to delete key pair because name and immutable ID do not uniquely match this bake"
        }
    } else {
        # The immutable ID was never resolved (e.g. create succeeded but the
        # follow-up query failed). Fall back to the unique temporary name so a
        # failed bake does not leave a billed key pair behind.
        if ($existing.Count -ne 1) {
            throw "Refusing to delete key pair because the temporary name does not uniquely match this bake"
        }
    }

    Write-Host "Deleting temporary key pair $script:KeyPairName ($script:KeyPairID)"
    Invoke-Ctyun @(
        "ecs", "DeleteEcsKeypair",
        "--regionID", $RegionID,
        "--keyPairName", $script:KeyPairName
    ) | Out-Null

    $deadline = Get-BoundedDeadline `
        -RequestedSeconds (2 * 60) `
        -Phase "temporary key pair deletion confirmation"
    $confirmEmptyReads = 0
    while ((Get-Date) -lt $deadline) {
        $details = Invoke-Ctyun @(
            "ecs", "GetEcsKeypairDetails",
            "--regionID", $RegionID,
            "--projectID", $BuilderProjectID,
            "--keyPairName", $script:KeyPairName,
            "--pageNo", "1",
            "--pageSize", "10"
        )
        $remaining = @(
            @(Get-ResponseItems -Response $details -Name "results") |
                Where-Object { [string]$_.keyPairName -eq $script:KeyPairName }
        )
        if ($remaining.Count -eq 0) {
            $confirmEmptyReads++
            if ($confirmEmptyReads -ge 2) {
                return
            }
        } else {
            $confirmEmptyReads = 0
        }
        Wait-PollInterval -DefaultSeconds 5
    }
    throw "Could not confirm deletion of temporary key pair $script:KeyPairName"
}

function Remove-TemporaryResources {
    param(
        [switch]$Failure,
        [switch]$WaitForLate
    )

    $errors = [Collections.Generic.List[string]]::new()
    if ($Failure) {
        try {
            Remove-FailedImage
        } catch {
            $errors.Add(
                "image cleanup (name=$script:ImageWorkName imageID=$script:ImageID): $($_.Exception.Message)"
            )
        }
    }
    if ($script:PreserveBuilderForImageRecovery) {
        $errors.Add(
            "builder cleanup deferred because the source builder is still required to prove incomplete image ownership"
        )
    } else {
        try {
            Remove-Builder -WaitForLate:$WaitForLate
        } catch {
            $errors.Add(
                "builder cleanup (name=$script:BuilderName instanceID=$script:BuilderID resourceID=$script:BuilderResourceID): $($_.Exception.Message)"
            )
        }
    }
    try {
        Remove-KeyPair -WaitForLate:$WaitForLate
    } catch {
        $errors.Add(
            "key pair cleanup (name=$script:KeyPairName): $($_.Exception.Message)"
        )
    }

    if ($errors.Count -gt 0) {
        throw "Temporary cloud resource cleanup failed:`n$($errors -join "`n")"
    }
}

function Complete-PendingPublishedImage {
    param(
        [Parameter(Mandatory = $true)]$PendingImage,
        [Parameter(Mandatory = $true)][string]$PendingBakeID,
        [Parameter(Mandatory = $true)][string]$FinalDescription
    )

    if (
        $PendingBakeID -notmatch "^(?:\d{6,}-\d{2,}|\d{12}-[0-9a-f]{8})$" -or
        -not $PendingImage.sourceServerID
    ) {
        throw "Published image has invalid pending cleanup ownership metadata"
    }

    $script:BuilderName = "catsco-img-$PendingBakeID"
    $script:KeyPairName = "catsco-img-key-$PendingBakeID"
    $script:BuilderID = [string]$PendingImage.sourceServerID
    $script:BuilderResourceID = ""
    $script:BuilderCreateAttempted = $true
    $script:KeyPairID = ""
    # The pending image's bake marker and the key pair's unique temporary name
    # both carry this bake ID, so the key pair is proven to belong to this bake
    # and can be cleaned up by its unique name during recovery (Remove-KeyPair
    # only deletes when the temporary name uniquely matches).
    $script:KeyPairCreateAttempted = $true
    $script:InCleanup = $true
    $script:CleanupDeadline = (Get-Date).AddMinutes($CleanupTimeoutMinutes)

    Remove-TemporaryResources -WaitForLate
    Invoke-Ctyun @(
        "ims", "UpdateImage",
        "--regionID", $RegionID,
        "--imageID", ([string]$PendingImage.imageID),
        "--imageName", $ImageName,
        "--description", $FinalDescription
    ) | Out-Null
    return Wait-ForPublishedImageIdentity `
        -PublishedImageID ([string]$PendingImage.imageID) `
        -PublishedImageName $ImageName `
        -PublishedDescription $FinalDescription
}

function Invoke-ExactBakeCleanup {
    $script:InCleanup = $true
    $script:CleanupDeadline = (Get-Date).AddMinutes($CleanupTimeoutMinutes)

    $discoverySeconds = if ($WaitForLateResources) { $LateResourceWaitSeconds } else { 0 }
    $discoveryDeadline = Get-BoundedDeadline `
        -RequestedSeconds $discoverySeconds `
        -Phase "exact bake resource discovery"

    # Aggregate first: a discovery API error must not skip the other resources.
    $errors = [Collections.Generic.List[string]]::new()
    $reconciled = [Collections.Generic.List[string]]::new()

    # --- Builder discovery (independent try/catch + consecutive-empty reads).
    # Its immutable instance ID is the ownership proof the image deletion
    # depends on (sourceServerID match); the builder itself is deleted LAST so
    # it stays as evidence while the image is being removed — the same ordering
    # as the in-process finally path. ---
    $candidateBuilder = $null
    try {
        $candidateBuilder = Resolve-BuilderInstance -WaitSeconds $discoverySeconds
        if (-not $candidateBuilder -and -not $WaitForLateResources) {
            $emptyReads = 1
            while ($emptyReads -lt 3) {
                Wait-PollInterval -DefaultSeconds 5
                $candidateBuilder = Resolve-BuilderInstance
                if ($candidateBuilder) { break }
                $emptyReads++
            }
        }
    } catch {
        $errors.Add("builder discovery: $($_.Exception.Message)")
    }
    if ($candidateBuilder) {
        $script:BuilderID = [string]$candidateBuilder.instanceID
        $script:BuilderName = [string]$candidateBuilder.instanceName
    }

    # --- Image discovery (independent try/catch + consecutive-empty reads). ---
    $candidateImage = $null
    try {
        $imageEmptyReads = 0
        do {
            $candidateImage = Find-ImageByName -Name $script:ImageWorkName
            if ($candidateImage) { break }
            $imageEmptyReads++
            if (-not $WaitForLateResources -and $imageEmptyReads -ge 3) { break }
            if ($WaitForLateResources -and (Get-Date) -ge $discoveryDeadline) { break }
            Wait-PollInterval -DefaultSeconds 10
        } while ($true)
    } catch {
        $errors.Add("image discovery: $($_.Exception.Message)")
    }

    # Reconcile resources that can be uniquely proven to belong to this bake;
    # anything that cannot be proven stays fail-closed and is reported. A
    # process hard-killed at any creation boundary (key-only, builder-only,
    # image-only, published-pending) is recovered here instead of only being
    # discovered.

    # --- Image first: deletable only when sourceServerID matches the resolved
    # builder (same ownership proof as the in-process finally path). Without a
    # builder the image's source identity cannot be proven, so it stays
    # fail-closed. ---
    if ($candidateImage) {
        $script:ImageCreateAttempted = $true
        $script:ImageID = ""
        $script:ImageActive = $false
        try {
            Remove-FailedImage
            $reconciled.Add("image=$script:ImageWorkName")
        } catch {
            $errors.Add("image cleanup (name=$script:ImageWorkName): $($_.Exception.Message)")
        }
    }

    # --- Builder: deleted only after the image is confirmed gone. If image
    # deletion failed or could not be confirmed, Remove-FailedImage keeps
    # PreserveBuilderForImageRecovery set, and the builder must be retained as
    # the sourceServerID ownership evidence for the next reconciliation
    # (same gating as the in-process finally path). ---
    if ($candidateBuilder) {
        if ($script:PreserveBuilderForImageRecovery) {
            $errors.Add(
                "builder cleanup deferred because the source builder is still " +
                "required to prove incomplete image ownership"
            )
        } else {
            try {
                Remove-Builder -WaitForLate:$WaitForLateResources
                $reconciled.Add("builder=$script:BuilderID")
            } catch {
                $errors.Add("builder cleanup (name=$script:BuilderName): $($_.Exception.Message)")
            }
        }
    }

    # --- Key pair: the unique temporary name (derived from the deterministic
    # bake token) is the ownership proof; delete only when it uniquely matches.
    # The lookup is inside the try so API errors/deadlines join the aggregate
    # instead of aborting it. ---
    if ($script:KeyPairName) {
        try {
            $candidateKeyPair = @()
            $keyEmptyReads = 0
            do {
                $keyDetails = Invoke-Ctyun @(
                    "ecs", "GetEcsKeypairDetails",
                    "--regionID", $RegionID,
                    "--projectID", $BuilderProjectID,
                    "--keyPairName", $script:KeyPairName,
                    "--pageNo", "1",
                    "--pageSize", "10"
                )
                $candidateKeyPair = @(
                    @(Get-ResponseItems -Response $keyDetails -Name "results") |
                        Where-Object { [string]$_.keyPairName -eq $script:KeyPairName }
                )
                if ($candidateKeyPair.Count -gt 0) { break }
                $keyEmptyReads++
                if (-not $WaitForLateResources -and $keyEmptyReads -ge 3) { break }
                if ($WaitForLateResources -and (Get-Date) -ge $discoveryDeadline) { break }
                Wait-PollInterval -DefaultSeconds 5
            } while ($true)
            if ($candidateKeyPair.Count -eq 1) {
                $script:KeyPairCreateAttempted = $true
                Remove-KeyPair -WaitForLate:$WaitForLateResources
                $reconciled.Add("keyPair=$script:KeyPairName")
            } elseif ($candidateKeyPair.Count -gt 1) {
                $errors.Add("key pair name '$script:KeyPairName' is not unique; refusing to delete")
            }
        } catch {
            $errors.Add("key pair cleanup (name=$script:KeyPairName): $($_.Exception.Message)")
        }
    }

    if ($errors.Count -gt 0) {
        $summary = "Temporary cloud resource cleanup failed during reconciliation"
        if ($reconciled.Count -gt 0) {
            $summary += " (reconciled: $($reconciled -join ', '))"
        }
        throw ($summary + "`n" + ($errors -join "`n"))
    }

    if ($reconciled.Count -gt 0) {
        Write-Host "Reconciled bake resources: $($reconciled -join ', ')"
        return [ordered]@{
            result = "reconciled"
            bakeID = $script:BakeID
            reconciled = $reconciled
            regionID = $RegionID
        }
    }

    Write-Host "No provably owned historical resources found for bake $script:BakeID"
    return [ordered]@{
        result = "nothing-to-clean"
        bakeID = $script:BakeID
        temporaryImageName = $script:ImageWorkName
        builderName = $script:BuilderName
        keyPairName = $script:KeyPairName
        regionID = $RegionID
    }
}

if (-not (Get-Command "git" -ErrorAction SilentlyContinue)) {
    throw "Missing required command: git"
}
if ($Mode -in @("Create", "Cleanup")) {
    foreach ($command in @("ctyun-cli", "ssh-keygen", "timeout")) {
        if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
            throw "Missing required command: $command"
        }
    }
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
$commit = (Invoke-External -Command "git" -Arguments @(
    "-C", $repoRoot, "rev-list", "--max-count=1", $SourceRef
) -Capture).Trim()
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
    if (-not $BuildIdentity) {
        $BuildIdentity = $BuildNumber
    }
    $bakeTokenBytes = [Text.Encoding]::UTF8.GetBytes(
        "$BuildIdentity/$BuildAttempt/$commit"
    )
    $bakeTokenHash = [Security.Cryptography.SHA256]::HashData($bakeTokenBytes)
    $bakeToken = [Convert]::ToHexString($bakeTokenHash).Substring(0, 8).ToLowerInvariant()
} else {
    $localToken = [guid]::NewGuid().ToString("N").Substring(0, 8)
    $builderSuffix = "$(Get-Date -AsUTC -Format 'yyMMddHHmmss')-$localToken"
    $bakeToken = $localToken
}
$script:BakeID = $builderSuffix
$script:BuilderName = "catsco-img-$builderSuffix"
$script:KeyPairName = "catsco-img-key-$builderSuffix"
$script:ImageWorkName = "catsco-bake-$shortCommit-$bakeToken"
$releaseIdentity = "CatsCo worker $version commit $commit"
$releaseDescription = "$releaseIdentity ready"
$bakeDescription = "$releaseIdentity bake $script:BakeID"
$script:BakeDescription = $bakeDescription
if ($releaseDescription.Length -gt 128 -or $bakeDescription.Length -gt 128) {
    throw "Generated image description exceeds Tianyi Cloud's 128-character limit"
}
if (
    $script:ImageWorkName.Length -gt 32 -or
    $script:ImageWorkName -notmatch "^[A-Za-z][A-Za-z0-9-]*[A-Za-z0-9]$"
) {
    throw "Generated temporary image name is invalid: $script:ImageWorkName"
}

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
if ($Mode -eq "Create") {
    $artifactUri = $null
    if (
        -not [Uri]::TryCreate($ArtifactUrl, [UriKind]::Absolute, [ref]$artifactUri) -or
        $artifactUri.Scheme -ne "https"
    ) {
        throw "ArtifactUrl must be an absolute HTTPS URL in Create mode"
    }
    $prepareScriptUri = $null
    if (
        -not [Uri]::TryCreate($PrepareScriptUrl, [UriKind]::Absolute, [ref]$prepareScriptUri) -or
        $prepareScriptUri.Scheme -ne "https"
    ) {
        throw "PrepareScriptUrl must be an absolute HTTPS URL in Create mode"
    }
    if ($PrepareScriptSha256 -notmatch "^[0-9a-fA-F]{64}$") {
        throw "PrepareScriptSha256 must be a SHA-256 hex digest in Create mode"
    }
    if ([string]::IsNullOrWhiteSpace($BootstrapStatusPutUrl) -ne [string]::IsNullOrWhiteSpace($BootstrapStatusGetUrl)) {
        throw "BootstrapStatusPutUrl and BootstrapStatusGetUrl must be supplied together"
    }
    foreach ($statusUrl in @($BootstrapStatusPutUrl, $BootstrapStatusGetUrl)) {
        if (-not [string]::IsNullOrWhiteSpace($statusUrl)) {
            $statusUri = $null
            if (-not [Uri]::TryCreate($statusUrl, [UriKind]::Absolute, [ref]$statusUri) -or $statusUri.Scheme -ne "https") {
                throw "Bootstrap status URLs must be absolute HTTPS URLs in Create mode"
            }
        }
    }
}

$plan = [ordered]@{
    mode = $Mode
    sourceRef = $SourceRef
    version = $version
    commit = $commit
    imageName = $ImageName
    temporaryImageName = $script:ImageWorkName
    bakeID = $script:BakeID
    builderName = $script:BuilderName
    builderProjectID = $BuilderProjectID
    imageProjectID = $ImageProjectID
    regionID = $RegionID
    azName = $AzName
    baseImageID = $BaseImageID
    flavorID = $FlavorID
    vpcID = $VpcID
    subnetID = $SubnetID
    securityGroupID = $SecurityGroupID
    bootDisk = "$BootDiskType $BootDiskSize GiB"
    artifactSource = $(if ($resolvedArtifactPath) { "local source-free CI artifact" } else { "not supplied in plan mode" })
    builderNetwork = "private subnet with cloud-init artifact pull"
    mutatesExistingWorkers = $false
}
$plan | ConvertTo-Json

if ($Mode -eq "Plan") {
    exit 0
}

$script:OperationDeadline = (Get-Date).AddMinutes($BakeTimeoutMinutes)
if ($Mode -eq "Cleanup") {
    Invoke-ExactBakeCleanup | ConvertTo-Json
    exit 0
}

$existingImage = Find-ImageByName -Name $ImageName
if ($existingImage) {
    $existingStatus = ([string]$existingImage.imageStatus).ToLowerInvariant()
    $existingDescription = [string]$existingImage.description
    $pendingPrefix = "$releaseIdentity bake "
    if ($existingStatus -eq "active" -and $existingDescription -eq $releaseDescription) {
        [ordered]@{
            result = "reused"
            imageID = [string]$existingImage.imageID
            imageName = $ImageName
            version = $version
            commit = $commit
            builderName = $null
            regionID = $RegionID
        } | ConvertTo-Json
        exit 0
    }
    if (
        $existingStatus -eq "active" -and
        $existingDescription.StartsWith($pendingPrefix)
    ) {
        $pendingBakeID = $existingDescription.Substring($pendingPrefix.Length)
        $existingImage = Complete-PendingPublishedImage `
            -PendingImage $existingImage `
            -PendingBakeID $pendingBakeID `
            -FinalDescription $releaseDescription
        [ordered]@{
            result = "recovered"
            imageID = [string]$existingImage.imageID
            imageName = $ImageName
            version = $version
            commit = $commit
            builderName = $null
            regionID = $RegionID
        } | ConvertTo-Json
        exit 0
    }
    throw (
        "Private image name is already occupied by a different or incomplete image: " +
        "$ImageName status=$existingStatus imageID=$($existingImage.imageID)"
    )
}

$script:TemporaryRoot = Join-Path ([IO.Path]::GetTempPath()) "catsco-image-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $script:TemporaryRoot | Out-Null
$privateKey = Join-Path $script:TemporaryRoot "builder-rsa"
$publicKeyPath = "$privateKey.pub"
$primaryFailure = $null
$cleanupFailure = $null
$result = $null

try {
    Write-BakeProgress -Phase "prepare" -Detail "creating temporary key pair and builder" -Force
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
        "--projectID", $BuilderProjectID,
        "--keyPairName", $script:KeyPairName,
        "--pageNo", "1",
        "--pageSize", "10"
    )
    $existingKeyPairs = @(
        @(Get-ResponseItems -Response $existingKeyPairResponse -Name "results") |
            Where-Object { [string]$_.keyPairName -eq $script:KeyPairName }
    )
    if ($existingKeyPairs.Count -gt 0) {
        throw "Temporary key pair name is already in use: $script:KeyPairName"
    }

    Invoke-Ctyun @(
        "ecs", "ImportEcsKeypair",
        "--regionID", $RegionID,
        "--projectID", $BuilderProjectID,
        "--keyPairName", $script:KeyPairName,
        "--keyPairDescription", "Temporary CatsCo image builder",
        "--publicKey", $publicKey
    ) | Out-Null
    # Mark the key pair as created right after a successful import so a failure
    # in the follow-up identity resolution (KeyPairID empty) still allows
    # name-based cleanup instead of leaking the cloud key pair.
    $script:KeyPairCreateAttempted = $true

    $keyPairResponse = Invoke-Ctyun @(
        "ecs", "GetEcsKeypairDetails",
        "--regionID", $RegionID,
        "--projectID", $BuilderProjectID,
        "--keyPairName", $script:KeyPairName,
        "--pageNo", "1",
        "--pageSize", "10"
    )
    $keyPair = @(Get-ResponseItems -Response $keyPairResponse -Name "results") |
        Where-Object { [string]$_.keyPairName -eq $script:KeyPairName } |
        Select-Object -First 1
    $script:KeyPairID = [string](
        Get-PropertyValue -InputObject $keyPair -Name "keyPairID"
    )
    if (-not $script:KeyPairID) {
        throw "Imported key pair could not be resolved"
    }
    Write-BakeProgress -Phase "keypair-imported" -Detail "key_pair_id=$script:KeyPairID" -Force

    $existingBuilderResponse = Invoke-Ctyun @(
        "ecs", "ListEcsInstances",
        "--regionID", $RegionID,
        "--instanceName", $script:BuilderName,
        "--pageNo", "1",
        "--pageSize", "10"
    )
    $existingBuilders = @(
        @(Get-ResponseItems -Response $existingBuilderResponse -Name "results") |
            Where-Object { [string]$_.instanceName -eq $script:BuilderName }
    )
    if ($existingBuilders.Count -gt 0) {
        throw "Temporary builder name is already in use: $script:BuilderName"
    }

    $artifactUrlBase64 = [Convert]::ToBase64String(
        [Text.Encoding]::UTF8.GetBytes($ArtifactUrl)
    )
    $prepareScriptUrlBase64 = [Convert]::ToBase64String(
        [Text.Encoding]::UTF8.GetBytes($PrepareScriptUrl)
    )
    $statusPutUrlBase64 = [Convert]::ToBase64String(
        [Text.Encoding]::UTF8.GetBytes($BootstrapStatusPutUrl)
    )
    $baseImageHardenedValue = $BaseImageHardened.IsPresent.ToString().ToLowerInvariant()
    $artifactName = "catsco-worker-$releaseId-linux-x64.tar.gz"
    $bootstrapScript = @"
#!/usr/bin/env bash
set -Eeuo pipefail
export CATSCO_BASE_IMAGE_HARDENED='$baseImageHardenedValue'
exec > >(tee -a /var/log/catsco-image-build.log) 2>&1
artifact_url="`$(printf '%s' '$artifactUrlBase64' | base64 -d)"
prepare_script_url="`$(printf '%s' '$prepareScriptUrlBase64' | base64 -d)"
status_put_url="`$(printf '%s' '$statusPutUrlBase64' | base64 -d)"
status_file=/run/catsco-image-bootstrap-phase
heartbeat_pid=''
publish_status() {
  local state="`$1" phase_name="`$2" exit_code="`${3:-0}" line="`${4:-0}"
  [[ -n "`$status_put_url" ]] || return 0
  printf '{"state":"%s","phase":"%s","exit_code":%s,"line":%s,"epoch":%s}\n' \
    "`$state" "`$phase_name" "`$exit_code" "`$line" "`$(date +%s)" >/run/catsco-image-bootstrap-status.json
  curl --fail --silent --request PUT --connect-timeout 10 --max-time 20 \
    --retry 2 --retry-all-errors --data-binary @/run/catsco-image-bootstrap-status.json \
    "`$status_put_url" >/dev/null 2>&1 || true
}
phase() {
  printf '%s\n' "`$1" | tee "`$status_file"
  publish_status running "`$1"
}
heartbeat() {
  while true; do
    current_phase="`$(cat "`$status_file" 2>/dev/null || printf bootstrap-start)"
    publish_status running "`$current_phase"
    sleep 30
  done
}
finish() {
  rc=`$?
  trap - EXIT
  if [[ -n "`$heartbeat_pid" ]]; then
    kill "`$heartbeat_pid" >/dev/null 2>&1 || true
    wait "`$heartbeat_pid" 2>/dev/null || true
  fi
  if [[ `$rc -ne 0 ]]; then
    current_phase="`$(cat "`$status_file" 2>/dev/null || printf bootstrap-start)"
    publish_status failed "`$current_phase" "`$rc" "`${BASH_LINENO[0]:-0}"
  fi
  exit "`$rc"
}
trap finish EXIT
curl_common=(--fail --silent --show-error --location --ipv4 \
  --connect-timeout 20 --max-time 900 --retry 8 --retry-all-errors \
  --retry-delay 5 --retry-max-time 1800)
phase bootstrap-start
heartbeat &
heartbeat_pid=`$!
phase download-prepare-script
curl "`${curl_common[@]}" \
  "`$prepare_script_url" --output /tmp/prepare-image.sh
printf '%s  %s\n' '$($PrepareScriptSha256.ToLowerInvariant())' /tmp/prepare-image.sh | sha256sum --check --strict
chmod 700 /tmp/prepare-image.sh
phase download-worker-artifact
curl "`${curl_common[@]}" \
  "`$artifact_url" --output '/tmp/$artifactName'
phase prepare-worker-artifact
CATSCO_IMAGE_PHASE_FILE="`$status_file" \
bash /tmp/prepare-image.sh \
  --artifact '/tmp/$artifactName' \
  --sha256 '$ArtifactSha256' \
  --version '$version' \
  --commit '$commit'
rm -f '/tmp/$artifactName'
phase finalize-worker-image
CATSCO_IMAGE_PHASE_FILE="`$status_file" bash /tmp/prepare-image.sh --finalize
sync
phase shutdown
publish_status succeeded shutdown
shutdown -h now
"@
    # Tianyi's cloud-init images are more reliable when userData is an
    # explicit cloud-config document. Keep the actual bootstrap as a decoded
    # file and invoke it through runcmd so a valid shell shebang is not left
    # to provider-specific userData handling.
    $bootstrapBase64 = [Convert]::ToBase64String(
        [Text.Encoding]::UTF8.GetBytes($bootstrapScript)
    )
    $cloudConfig = @"
#cloud-config
output:
  all: '| tee -a /var/log/catsco-image-cloud-init-output.log'
bootcmd:
  - [ /bin/sh, -c, "date -Is > /run/catsco-image-bootstrap-started" ]
write_files:
  - path: /usr/local/sbin/catsco-image-bootstrap.sh
    encoding: b64
    permissions: '0700'
    content: $bootstrapBase64
runcmd:
  - [ /bin/bash, /usr/local/sbin/catsco-image-bootstrap.sh ]
"@
    $userData = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($cloudConfig))
    if ($userData.Length -gt 16384) {
        throw "Generated builder userData exceeds Tianyi Cloud's 16384-character limit"
    }

    $createResponse = Invoke-Ctyun @(
        "ecs", "CreateEcsInstance",
        "--regionID", $RegionID,
        "--projectID", $BuilderProjectID,
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
        "--keyPairID", $script:KeyPairID,
        "--userData", $userData,
        "--onDemand", "true",
        "--extIP", "0",
        "--monitorService", "false",
        "--securityProduct", "false",
        "--trustInstance", "false",
        "--labelList", "[{`"labelKey`":`"purpose`",`"labelValue`":`"catsco-image-builder`"},{`"labelKey`":`"commit`",`"labelValue`":`"$shortCommit`"}]"
    )
    $createReturnObject = Get-PropertyValue `
        -InputObject $createResponse `
        -Name "returnObj"
    $script:BuilderResourceID = [string](
        Get-PropertyValue -InputObject $createReturnObject -Name "masterResourceID"
    )
    if (-not $script:BuilderResourceID) {
        throw "CreateEcsInstance did not return masterResourceID"
    }
    $script:BuilderCreateAttempted = $true
    Write-BakeProgress -Phase "builder-created" -Detail "builder_name=$script:BuilderName resource_id=$script:BuilderResourceID" -Force

    $builder = Resolve-BuilderInstance -WaitSeconds ($TimeoutMinutes * 60)
    if (-not $builder) {
        throw "Timed out resolving the temporary builder instance"
    }
    Assert-TemporaryBuilder $builder
    Write-BakeProgress -Phase "builder-resolved" -Detail "builder_id=$script:BuilderID" -Force

    # cloud-init powers off only after artifact verification, preparation and
    # finalization all succeed. Failed or stale bootstrap telemetry aborts this
    # wait early and enters the existing compensating cleanup path.
    Wait-ForInstance -States @("stopped", "shutoff") -MonitorBootstrap | Out-Null
    Write-BakeProgress -Phase "builder-stopped" -Detail "cloud-init completed; starting image capture" -Force

    $script:ImageCreateAttempted = $true
    $imageResponse = Invoke-Ctyun @(
        "ims", "CreateImage",
        "--regionID", $RegionID,
        "--projectID", $ImageProjectID,
        "--instanceID", $script:BuilderID,
        "--imageName", $script:ImageWorkName,
        "--description", $bakeDescription,
        "--enableImageIntegrityCheck", "true",
        "--labels", "[{`"labelKey`":`"product`",`"labelValue`":`"catsco-worker`"},{`"labelKey`":`"version`",`"labelValue`":`"$version`"},{`"labelKey`":`"commit`",`"labelValue`":`"$commit`"},{`"labelKey`":`"bake`",`"labelValue`":`"$script:BakeID`"}]"
    )
    $image = @(Get-ResponseItems -Response $imageResponse -Name "images") |
        Select-Object -First 1
    $script:ImageID = [string](
        Get-PropertyValue -InputObject $image -Name "imageID"
    )
    if (-not $script:ImageID) {
        throw "CreateImage did not return an image ID"
    }
    Write-BakeProgress -Phase "image-capture-started" -Detail "image_id=$script:ImageID" -Force

    $deadline = Get-BoundedDeadline `
        -RequestedSeconds ($TimeoutMinutes * 60) `
        -Phase "private image creation wait"
    while ((Get-Date) -lt $deadline) {
        $currentImage = Get-Image -ImageID $script:ImageID
        if (-not $currentImage) {
            throw "Private image disappeared during creation"
        }
        $status = ([string]$currentImage.imageStatus).ToLowerInvariant()
        Write-BakeProgress -Phase "image-capture" -Detail ("state={0} progress={1}" -f $status, $currentImage.taskProgress) -Force
        if ($status -eq "active") {
            if ([string]$currentImage.sourceServerID -ne $script:BuilderID) {
                throw (
                    "Created image sourceServerID '$($currentImage.sourceServerID)' " +
                    "does not match builder '$script:BuilderID'"
                )
            }
            Invoke-Ctyun @(
                "ims", "UpdateImage",
                "--regionID", $RegionID,
                "--imageID", $script:ImageID,
                "--imageName", $ImageName,
                "--description", $bakeDescription
            ) | Out-Null
            $publishedImage = Wait-ForPublishedImageIdentity `
                -PublishedImageID $script:ImageID `
                -PublishedImageName $ImageName `
                -PublishedDescription $bakeDescription
            $script:ImageActive = $true
            $script:Completed = $true
            Write-BakeProgress -Phase "image-capture-active" -Detail "image_id=$script:ImageID" -Force
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
        Wait-PollInterval -DefaultSeconds 15
    }
    if (-not $script:Completed) {
        throw "Timed out waiting for private image creation"
    }
} catch {
    $primaryFailure = $_.Exception.Message
    Write-BakeProgress -Phase "failed" -Detail $primaryFailure -Force
} finally {
    $script:InCleanup = $true
    $script:CleanupDeadline = (Get-Date).AddMinutes($CleanupTimeoutMinutes)
    try {
        Write-BakeProgress -Phase "cleanup-start" -Detail "failure=$(-not $script:Completed)" -Force
        Remove-TemporaryResources `
            -Failure:(-not $script:Completed) `
            -WaitForLate:$WaitForLateResources
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

$script:InCleanup = $false
$script:OperationDeadline = (Get-Date).AddMinutes(5)
Invoke-Ctyun @(
    "ims", "UpdateImage",
    "--regionID", $RegionID,
    "--imageID", $script:ImageID,
    "--imageName", $ImageName,
    "--description", $releaseDescription
) | Out-Null
Wait-ForPublishedImageIdentity `
    -PublishedImageID $script:ImageID `
    -PublishedImageName $ImageName `
    -PublishedDescription $releaseDescription | Out-Null

$result | ConvertTo-Json
