[CmdletBinding()]
param(
    [string]$WorkspaceRoot,
    [string]$RuntimeRoot = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'DevSpaceChatGPT')
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'DevSpaceChatGPT.Common.ps1')
$sourceRoot = Assert-CanonicalSource

$metadata = Read-RuntimeMetadata $RuntimeRoot
if (-not $metadata) { throw "Runtime metadata is missing under $RuntimeRoot." }
if ($metadata.status -ne 'running') { throw "Runtime metadata status is '$($metadata.status)', not 'running'." }
if (-not (Test-SamePath ([string]$metadata.sourceRoot) $sourceRoot)) { throw 'Runtime metadata does not name the canonical Tools source.' }
if (-not (Test-SamePath ([string]$metadata.devspace.cwd) $sourceRoot)) { throw 'Recorded DevSpace CWD is not the canonical Tools source.' }
if ($WorkspaceRoot) {
    $expectedWorkspace = Assert-SafeWorkspaceRoot $WorkspaceRoot
    if (-not (Test-SamePath ([string]$metadata.workspaceRoot) $expectedWorkspace)) {
        throw "Running workspace '$($metadata.workspaceRoot)' does not match '$expectedWorkspace'."
    }
}

if (-not (Test-RecordedProcessIdentity -Record $metadata.devspace -Kind devspace)) {
    throw 'Recorded DevSpace process identity is not live or no longer matches.'
}
$port = [int]$metadata.port
Assert-LoopbackListener -ProcessId ([int]$metadata.devspace.pid) -Port $port
Wait-HttpStatus -Uri "http://127.0.0.1:$port/healthz" -ExpectedStatus 200 -TimeoutSeconds 5 | Out-Null
Test-UnauthenticatedMcpRejected -Port $port
$tools = @(Test-AuthenticatedMcpSurface -Port $port -BridgeSecretFile ([string]$metadata.bridgeSecretFile))

$tunnelStatus = 'not configured for this run'
if ($metadata.tunnel) {
    if (-not (Test-RecordedProcessIdentity -Record $metadata.tunnel -Kind tunnel)) {
        throw 'Recorded tunnel process identity is not live or no longer matches.'
    }
    $healthUrl = [string]$metadata.tunnel.healthUrl
    $tunnelSummary = Assert-TunnelOperational -ProcessId ([int]$metadata.tunnel.pid) -HealthUrl $healthUrl -TimeoutSeconds 10
    $tunnelStatus = "healthy=$($tunnelSummary.HealthStatus), ready=$($tunnelSummary.ReadyStatus), probe=$($tunnelSummary.ProbeStatus), PID=$($metadata.tunnel.pid), admin=$healthUrl"
}

$secret = (Get-Content -LiteralPath ([string]$metadata.bridgeSecretFile) -Raw -ErrorAction Stop).Trim()
try {
    foreach ($logProperty in @('stdoutLog', 'stderrLog')) {
        $logPath = [string]$metadata.devspace.$logProperty
        if ((Test-Path -LiteralPath $logPath -PathType Leaf) -and (Read-TextFileShared $logPath).Contains($secret)) {
            throw 'A DevSpace runtime log contains the bridge secret.'
        }
    }
} finally {
    $secret = $null
}

Write-Output 'RepoRelay release checks passed.'
Write-Output "Source/CWD: $sourceRoot"
Write-Output "Workspace: $($metadata.workspaceRoot)"
Write-Output "Listener: 127.0.0.1:$port (PID $($metadata.devspace.pid))"
Write-Output "Tunnel: $tunnelStatus"
Write-Output "Tools: $($tools -join ', ')"
Write-Output 'READY FOR CHATGPT: yes'
