$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$nodeExe = if ($nodeCommand) {
  $nodeCommand.Source
} else {
  Join-Path $projectRoot 'build-resources\runtime\node\node.exe'
}
$electronExe = Join-Path $projectRoot 'node_modules\electron\dist\electron.exe'
$cloneUserData = Join-Path $projectRoot 'data\electron-clone-user-data'
$port = 3801

function Test-LocalPort {
  param([int]$Port)
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $async = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
    if (-not $async.AsyncWaitHandle.WaitOne(250)) { return $false }
    $client.EndConnect($async)
    return $true
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

if (-not (Test-Path $nodeExe)) {
  throw "Node runtime not found: $nodeExe"
}

if (-not (Test-Path $electronExe)) {
  throw "Electron runtime not found: $electronExe"
}

New-Item -ItemType Directory -Force -Path $cloneUserData | Out-Null

if (-not (Test-LocalPort -Port $port)) {
  Start-Process -FilePath $nodeExe `
    -ArgumentList @('dist/index.js', 'dashboard', '--port', "$port") `
    -WorkingDirectory $projectRoot `
    -WindowStyle Hidden

  $deadline = (Get-Date).AddSeconds(12)
  while (-not (Test-LocalPort -Port $port)) {
    if ((Get-Date) -gt $deadline) {
      throw "Clone dashboard did not start on port $port"
    }
    Start-Sleep -Milliseconds 300
  }
}

$env:DASHBOARD_PORT = "$port"
$env:XIAOBA_DASHBOARD_EXTERNAL = '1'
$env:XIAOBA_USER_DATA_DIR = $cloneUserData

Start-Process -FilePath $electronExe `
  -ArgumentList @('.') `
  -WorkingDirectory $projectRoot
