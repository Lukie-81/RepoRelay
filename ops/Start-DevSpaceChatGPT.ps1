[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$WorkspaceRoot,
    [ValidateRange(1, 65535)][int]$Port = 7676,
    [string]$TunnelRoot = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'DevSpaceChatGPT\tunnel-client'),
    [string]$RuntimeRoot = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'DevSpaceChatGPT'),
    [string]$BridgeSecretFile = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'DevSpaceChatGPT\tunnel-client\secrets\devspace-bridge-secret.txt'),
    [string]$ControlPlaneApiKeyFile = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'DevSpaceChatGPT\tunnel-client\secrets\control-plane-api-key.txt'),
    [switch]$SkipTunnel
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'DevSpaceChatGPT.Common.ps1')

$sourceRoot = Assert-CanonicalSource
$workspace = Assert-SafeWorkspaceRoot $WorkspaceRoot
Assert-HandoffLayout $workspace
$paths = Get-RuntimePaths $RuntimeRoot
New-Item -ItemType Directory -Path $paths.Root -Force | Out-Null

$existing = Read-RuntimeMetadata $paths.Root

$bridgeSecretItem = Get-Item -LiteralPath $BridgeSecretFile -Force -ErrorAction Stop
if ($bridgeSecretItem.PSIsContainer) { throw "Bridge secret reference is not a file: $BridgeSecretFile" }
$bridgeSecretPath = [IO.Path]::GetFullPath($bridgeSecretItem.FullName)
$secretLength = ((Get-Content -LiteralPath $bridgeSecretPath -Raw -ErrorAction Stop).Trim()).Length
if ($secretLength -lt 32) { throw 'Bridge secret material is missing or too short.' }

$tunnelExecutable = $null
$profileDirectory = $null
$profilePath = $null
$compatibleTunnel = $null
$controlPlaneKey = $null
if (-not $SkipTunnel) {
    if ($Port -ne 7676) { throw 'The existing Secure MCP Tunnel profile targets port 7676. Use -SkipTunnel for isolated validation ports.' }
    $tunnelExecutable = Get-TunnelExecutable $TunnelRoot
    $profileDirectory = Get-TunnelProfileDirectory $TunnelRoot
    $profilePath = Join-Path $profileDirectory "$script:DevSpaceTunnelProfile.yaml"
    if (-not (Test-Path -LiteralPath $profilePath -PathType Leaf)) { throw "Tunnel profile is missing: $profilePath" }

    $bridgeReferences = @(
        Get-Content -LiteralPath $profilePath |
            Where-Object { $_ -match 'X-DevSpace-Bridge-Secret' } |
            ForEach-Object {
                $match = [regex]::Match($_, '(?i)file:([^"''\s]+)')
                if ($match.Success) { [IO.Path]::GetFullPath($match.Groups[1].Value) }
            }
    )
    if ($bridgeReferences.Count -ne 2 -or @($bridgeReferences | Where-Object { -not (Test-SamePath $_ $bridgeSecretPath) }).Count -ne 0) {
        throw 'Tunnel runtime and discovery bridge-secret references do not both match the selected bridge secret file.'
    }

    $compatibleTunnel = Find-CompatibleTunnelProcess -TunnelExecutable $tunnelExecutable -ProfileDirectory $profileDirectory
    if (-not $compatibleTunnel) {
        $controlPlaneKey = [Environment]::GetEnvironmentVariable('CONTROL_PLANE_API_KEY', 'Process')
        if ([string]::IsNullOrWhiteSpace($controlPlaneKey) -and $ControlPlaneApiKeyFile) {
            $keyItem = Get-Item -LiteralPath $ControlPlaneApiKeyFile -Force -ErrorAction Stop
            if ($keyItem.PSIsContainer) { throw "Control-plane API key reference is not a file: $ControlPlaneApiKeyFile" }
            $controlPlaneKey = (Get-Content -LiteralPath $keyItem.FullName -Raw -ErrorAction Stop).Trim()
        }
        if ([string]::IsNullOrWhiteSpace($controlPlaneKey)) {
            throw 'No compatible tunnel is running and CONTROL_PLANE_API_KEY is absent. Set it in this PowerShell process or pass -ControlPlaneApiKeyFile.'
        }
    }
}

if ($existing -and $existing.status -eq 'running' -and (Test-RecordedProcessIdentity -Record $existing.devspace -Kind devspace)) {
    if (-not (Test-SamePath ([string]$existing.sourceRoot) $sourceRoot) -or
        -not (Test-SamePath ([string]$existing.devspace.cwd) $sourceRoot) -or
        -not (Test-SamePath ([string]$existing.workspaceRoot) $workspace) -or
        [int]$existing.port -ne $Port) {
        throw "A different RepoRelay configuration is already running as PID $($existing.devspace.pid). Use Restart-DevSpaceChatGPT.ps1 to change it."
    }
    if (-not (Test-SamePath ([string]$existing.bridgeSecretFile) $bridgeSecretPath)) {
        throw 'The running DevSpace bridge-secret reference differs from the requested reference. Use Restart-DevSpaceChatGPT.ps1.'
    }
    if (-not $SkipTunnel -and -not $existing.tunnel) {
        throw 'The matching DevSpace process is running without recorded tunnel metadata. Use Restart-DevSpaceChatGPT.ps1.'
    }
    & (Join-Path $PSScriptRoot 'Test-DevSpaceChatGPT.ps1') -WorkspaceRoot $workspace -RuntimeRoot $paths.Root
    Write-Output 'The requested RepoRelay stack was already running; no processes were changed.'
    return
}

$listeners = @(Get-ListeningEndpoints -ProcessId $null -Port $Port)
if ($listeners.Count -gt 0) {
    throw "Port $Port is already owned by PID(s) $(@($listeners.ProcessId | Sort-Object -Unique) -join ', '). Refusing to start a conflicting instance."
}

$runId = '{0}-{1}' -f ([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')), $PID
$runPaths = Get-RuntimePaths (Join-Path $paths.Root (Join-Path 'runs' $runId))
New-Item -ItemType Directory -Path $runPaths.Root -Force | Out-Null
if (Test-Path -LiteralPath $paths.Metadata -PathType Leaf) {
    $historyRoot = Join-Path $paths.Root 'history'
    New-Item -ItemType Directory -Path $historyRoot -Force | Out-Null
    Copy-Item -LiteralPath $paths.Metadata -Destination (Join-Path $historyRoot "runtime-$runId.json") -ErrorAction Stop
}

$starting = [ordered]@{
    schemaVersion = 1
    status = 'starting'
    runId = $runId
    startedAtUtc = [DateTime]::UtcNow.ToString('o')
    sourceRoot = $sourceRoot
    workspaceRoot = $workspace
    port = $Port
    skipTunnel = [bool]$SkipTunnel
}
$starting | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $paths.Starting -Encoding UTF8

$nodeProcess = $null
$tunnelProcess = $null
$startedTunnel = $false
try {
    $bridgeSecret = (Get-Content -LiteralPath $bridgeSecretPath -Raw -ErrorAction Stop).Trim()
    $devspaceEnvironment = @{
        HOST = '127.0.0.1'
        PORT = [string]$Port
        NODE_ENV = 'production'
        DEVSPACE_PUBLIC_BASE_URL = "http://127.0.0.1:$Port"
        DEVSPACE_ALLOWED_HOSTS = '127.0.0.1'
        DEVSPACE_ALLOWED_ROOTS = $workspace
        DEVSPACE_TOOL_MODE = 'chatgpt-review'
        DEVSPACE_HANDOFF_WRITES = '1'
        DEVSPACE_CHATGPT_BRIDGE_AUTH = '1'
        DEVSPACE_CHATGPT_BRIDGE_SECRET = $bridgeSecret
        DEVSPACE_CHATGPT_NO_AUTH = '0'
        DEVSPACE_TRUST_PROXY = '0'
        DEVSPACE_WIDGETS = 'off'
        DEVSPACE_ARTIFACTS = '0'
        DEVSPACE_SKILLS = '0'
        DEVSPACE_SUBAGENTS = '0'
        DEVSPACE_LOG_SHELL_COMMANDS = '0'
        DEVSPACE_LOG_LEVEL = 'info'
        DEVSPACE_LOG_FORMAT = 'json'
        DEVSPACE_LOG_REQUESTS = '1'
        DEVSPACE_LOG_ASSETS = '0'
        DEVSPACE_LOG_TOOL_CALLS = '1'
        NODE_OPTIONS = ''
        DEVSPACE_STATE_DIR = (Join-Path $runPaths.Root 'state')
        DEVSPACE_CONFIG_DIR = (Join-Path $runPaths.Root 'config')
    }
    $savedEnvironment = Set-TemporaryEnvironment $devspaceEnvironment
    try {
        $nodeExecutable = Get-NodeExecutable
        $serverEntrypoint = Join-Path $sourceRoot 'dist\server.js'
        $nodeProcess = Start-Process -FilePath $nodeExecutable -ArgumentList @($serverEntrypoint) -WorkingDirectory $sourceRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $runPaths.DevSpaceStdout -RedirectStandardError $runPaths.DevSpaceStderr
    } finally {
        Restore-TemporaryEnvironment $savedEnvironment
        $bridgeSecret = $null
    }

    Wait-HttpStatus -Uri "http://127.0.0.1:$Port/healthz" -ExpectedStatus 200 -TimeoutSeconds 20 | Out-Null
    Assert-LoopbackListener -ProcessId $nodeProcess.Id -Port $Port
    Test-UnauthenticatedMcpRejected -Port $Port
    $tools = @(Test-AuthenticatedMcpSurface -Port $Port -BridgeSecretFile $bridgeSecretPath)

    $tunnelRecord = $null
    if (-not $SkipTunnel) {
        if ($compatibleTunnel) {
            $tunnelProcess = Get-Process -Id ([int]$compatibleTunnel.ProcessId) -ErrorAction Stop
        } else {
            $savedTunnelEnvironment = Set-TemporaryEnvironment @{ CONTROL_PLANE_API_KEY = $controlPlaneKey }
            try {
                $doctor = Start-Process -FilePath $tunnelExecutable -ArgumentList @('doctor', '--profile', $script:DevSpaceTunnelProfile, '--profile-dir', $profileDirectory, '--explain') -WorkingDirectory $sourceRoot -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput $runPaths.TunnelDoctorStdout -RedirectStandardError $runPaths.TunnelDoctorStderr
                if ($doctor.ExitCode -ne 0) {
                    $doctorOutput = Read-TextFileShared $runPaths.TunnelDoctorStdout
                    $expectedBridgeModeResult = $doctor.ExitCode -eq 2 -and
                        $doctorOutput -match '(?m)^FAILED_CHECKS oauth_metadata\s*$' -and
                        $doctorOutput -match '(?m)^CHECK profile_load\s+PASS\b' -and
                        $doctorOutput -match '(?m)^CHECK control_plane_api_key\s+PASS\b' -and
                        $doctorOutput -match '(?m)^CHECK mcp_server_reachable\s+PASS\s+HTTP 401\b'
                    if (-not $expectedBridgeModeResult) {
                        throw "Tunnel configuration doctor failed. See $($runPaths.TunnelDoctorStdout) and $($runPaths.TunnelDoctorStderr)."
                    }
                }
                $tunnelArgs = @(
                    'run', '--profile', $script:DevSpaceTunnelProfile, '--profile-dir', $profileDirectory,
                    '--health.listen-addr', '127.0.0.1:0', '--health.url-file', $runPaths.TunnelHealthUrl,
                    '--pid.file', $runPaths.TunnelPid, '--log.file', $runPaths.TunnelLog
                )
                $tunnelProcess = Start-Process -FilePath $tunnelExecutable -ArgumentList $tunnelArgs -WorkingDirectory $sourceRoot -WindowStyle Hidden -PassThru
                $startedTunnel = $true
            } finally {
                Restore-TemporaryEnvironment $savedTunnelEnvironment
                $controlPlaneKey = $null
            }
        }

        $healthUrl = $null
        if ($startedTunnel) {
            $deadline = [DateTime]::UtcNow.AddSeconds(30)
            do {
                if (Test-Path -LiteralPath $runPaths.TunnelHealthUrl -PathType Leaf) {
                    $healthUrl = (Get-Content -LiteralPath $runPaths.TunnelHealthUrl -Raw).Trim()
                    break
                }
                Start-Sleep -Milliseconds 250
            } while ([DateTime]::UtcNow -lt $deadline)
            if (-not $healthUrl) { throw 'Tunnel did not publish its loopback health URL.' }
        } else {
            $healthUrl = Get-TunnelHealthUrl -ProcessId $tunnelProcess.Id
        }
        Assert-TunnelOperational -ProcessId $tunnelProcess.Id -HealthUrl $healthUrl -TimeoutSeconds 30 | Out-Null
        $tunnelRecord = [ordered]@{
            pid = $tunnelProcess.Id
            startTimeUtc = (Get-ProcessStartTimeUtc $tunnelProcess.Id)
            executable = $tunnelExecutable
            profile = $script:DevSpaceTunnelProfile
            profileDirectory = $profileDirectory
            healthUrl = $healthUrl
            adoptedExistingProcess = [bool](-not $startedTunnel)
        }
    }

    $metadata = [ordered]@{
        schemaVersion = 1
        status = 'running'
        runId = $runId
        startedAtUtc = [DateTime]::UtcNow.ToString('o')
        sourceRoot = $sourceRoot
        workspaceRoot = $workspace
        port = $Port
        toolNames = $tools
        bridgeSecretFile = $bridgeSecretPath
        devspace = [ordered]@{
            pid = $nodeProcess.Id
            startTimeUtc = (Get-ProcessStartTimeUtc $nodeProcess.Id)
            executable = $nodeExecutable
            entrypoint = $serverEntrypoint
            command = $serverEntrypoint
            cwd = $sourceRoot
            stdoutLog = $runPaths.DevSpaceStdout
            stderrLog = $runPaths.DevSpaceStderr
        }
        tunnel = $tunnelRecord
    }
    $metadata | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $paths.Metadata -Encoding UTF8
    $starting.status = 'complete'
    $starting.completedAtUtc = [DateTime]::UtcNow.ToString('o')
    $starting | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $paths.Starting -Encoding UTF8

    Write-Output "RepoRelay is healthy on 127.0.0.1:$Port."
    Write-Output "Approved workspace: $workspace"
    Write-Output "Canonical source/CWD: $sourceRoot"
    Write-Output "Tools: $($tools -join ', ')"
    if ($tunnelRecord) { Write-Output "Tunnel ready: $($tunnelRecord.healthUrl)" }
} catch {
    $failure = [ordered]@{
        schemaVersion = 1
        status = 'failed'
        runId = $runId
        failedAtUtc = [DateTime]::UtcNow.ToString('o')
        sourceRoot = $sourceRoot
        workspaceRoot = $workspace
        port = $Port
        message = $_.Exception.Message
    }
    $failure | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $runPaths.Root 'failure.json') -Encoding UTF8
    $starting.status = 'failed'
    $starting.completedAtUtc = [DateTime]::UtcNow.ToString('o')
    $starting['message'] = $_.Exception.Message
    $starting | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $paths.Starting -Encoding UTF8
    $failure | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $paths.Metadata -Encoding UTF8
    if ($startedTunnel -and $tunnelProcess -and -not $tunnelProcess.HasExited) {
        $record = [pscustomobject]@{ pid = $tunnelProcess.Id; startTimeUtc = (Get-ProcessStartTimeUtc $tunnelProcess.Id); executable = $tunnelExecutable }
        Stop-RecordedProcess -Record $record -Kind tunnel
    }
    if ($nodeProcess -and -not $nodeProcess.HasExited) {
        $record = [pscustomobject]@{ pid = $nodeProcess.Id; startTimeUtc = (Get-ProcessStartTimeUtc $nodeProcess.Id); executable = (Get-NodeExecutable) }
        Stop-RecordedProcess -Record $record -Kind devspace
    }
    throw
}
