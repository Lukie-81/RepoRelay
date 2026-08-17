Set-StrictMode -Version Latest

# Windows PowerShell can inherit case-duplicate PATH entries from a managed
# launcher. Start-Process materializes the environment as a case-insensitive
# dictionary and rejects those duplicates, so keep one equivalent PATH entry.
$pathNames = @([Environment]::GetEnvironmentVariables('Process').Keys | Where-Object { $_ -ieq 'Path' })
if ($pathNames.Count -gt 1) {
    $pathValue = [Environment]::GetEnvironmentVariable('Path', 'Process')
    [Environment]::SetEnvironmentVariable('PATH', $null, 'Process')
    [Environment]::SetEnvironmentVariable('Path', $pathValue, 'Process')
}

$script:RepoRelayExpectedSourceRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$script:RepoRelayDefaultRuntimeRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'RepoRelay'
$script:RepoRelayDefaultTunnelRoot = Join-Path $script:RepoRelayDefaultRuntimeRoot 'tunnel-client'
$script:RepoRelayTunnelProfile = 'reporelay-test'
$script:RepoRelayRequiredTools = @(
    'list_files',
    'open_workspace',
    'read_file',
    'search_files',
    'update_handoff_state',
    'write_next_task',
    'write_review'
)

function Test-SamePath {
    param([Parameter(Mandatory)][string]$Left, [Parameter(Mandatory)][string]$Right)
    return [string]::Equals($Left.TrimEnd('\'), $Right.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)
}

function Get-NodeExecutable {
    $command = Get-Command node.exe -ErrorAction Stop
    return [IO.Path]::GetFullPath($command.Source)
}

function Resolve-CanonicalDirectory {
    param([Parameter(Mandatory)][string]$Path)
    if ($Path -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+[\\/])') {
        throw "Workspace root must be an absolute path: $Path"
    }
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if (-not $item.PSIsContainer) { throw "Workspace root is not a directory: $Path" }
    $node = Get-NodeExecutable
    $canonical = (& $node -e "process.stdout.write(require('node:fs').realpathSync.native(process.argv[1]))" $item.FullName)
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($canonical)) {
        throw "Could not canonicalize workspace root: $Path"
    }
    return [IO.Path]::GetFullPath($canonical)
}

function Test-PathContains {
    param([Parameter(Mandatory)][string]$Parent, [Parameter(Mandatory)][string]$Candidate)
    if (Test-SamePath $Parent $Candidate) { return $true }
    $prefix = $Parent.TrimEnd('\') + '\'
    return $Candidate.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
}

function Assert-SafeWorkspaceRoot {
    param([Parameter(Mandatory)][string]$WorkspaceRoot)
    if ($WorkspaceRoot -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+[\\/])') {
        throw "Workspace root must be an absolute path: $WorkspaceRoot"
    }
    $absoluteInput = [IO.Path]::GetFullPath($WorkspaceRoot)
    $node = Get-NodeExecutable
    $operatorHome = [IO.Path]::GetFullPath((& $node -e "process.stdout.write(require('node:os').homedir())"))
    if (Test-PathContains -Parent $absoluteInput -Candidate $operatorHome) {
        throw "Refusing the user home directory or one of its ancestors as the approved workspace: $absoluteInput"
    }
    $canonical = Resolve-CanonicalDirectory $WorkspaceRoot
    $driveRoot = [IO.Path]::GetPathRoot($canonical)
    if (Test-SamePath $canonical $driveRoot) {
        throw "Refusing a drive root as the approved workspace: $canonical"
    }
    if (Test-PathContains -Parent $canonical -Candidate $operatorHome) {
        throw "Refusing the user home directory or one of its ancestors as the approved workspace: $canonical"
    }
    return $canonical
}

function Assert-HandoffLayout {
    param([Parameter(Mandatory)][string]$WorkspaceRoot)
    foreach ($relativePath in @(
        '.ai-handoff\NEXT_TASK.md',
        '.ai-handoff\REVIEW.md',
        '.ai-handoff\STATE.json',
        '.ai-handoff\RESULT.md'
    )) {
        $path = Join-Path $WorkspaceRoot $relativePath
        $item = Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
        if (-not $item -or $item.PSIsContainer) {
            throw "Required handoff file is missing or is not a regular file: $path"
        }
    }
}

function Assert-CanonicalSource {
    $sourceRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
    if (-not (Test-SamePath $sourceRoot $script:RepoRelayExpectedSourceRoot)) {
        throw "This operations script must run from its own source checkout: $script:RepoRelayExpectedSourceRoot"
    }
    foreach ($relativePath in @('package.json', 'dist\server.js')) {
        if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot $relativePath) -PathType Leaf)) {
            throw "Canonical production build is missing $relativePath. Run npm.cmd run build first."
        }
    }
    return $sourceRoot
}

function Get-RuntimePaths {
    param([Parameter(Mandatory)][string]$RuntimeRoot)
    $fullRoot = [IO.Path]::GetFullPath($RuntimeRoot)
    return [pscustomobject]@{
        Root = $fullRoot
        Metadata = Join-Path $fullRoot 'runtime.json'
        Starting = Join-Path $fullRoot 'starting.json'
        RepoRelayStdout = Join-Path $fullRoot 'reporelay.stdout.log'
        RepoRelayStderr = Join-Path $fullRoot 'reporelay.stderr.log'
        TunnelLog = Join-Path $fullRoot 'tunnel.log'
        TunnelDoctorStdout = Join-Path $fullRoot 'tunnel-doctor.stdout.log'
        TunnelDoctorStderr = Join-Path $fullRoot 'tunnel-doctor.stderr.log'
        TunnelHealthUrl = Join-Path $fullRoot 'tunnel-health.url'
        TunnelPid = Join-Path $fullRoot 'tunnel.pid'
    }
}

function Get-CimProcessById {
    param([Parameter(Mandatory)][int]$Id)
    return Get-CimInstance Win32_Process -Filter "ProcessId=$Id" -ErrorAction SilentlyContinue
}

function Get-ProcessStartTimeUtc {
    param([Parameter(Mandatory)][int]$Id)
    return (Get-Process -Id $Id -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')
}

function Get-ListeningEndpoints {
    param([Nullable[int]]$ProcessId, [Nullable[int]]$Port)
    try {
        $connections = Get-NetTCPConnection -State Listen -ErrorAction Stop
        if ($null -ne $ProcessId) { $connections = $connections | Where-Object { $_.OwningProcess -eq [int]$ProcessId } }
        if ($null -ne $Port) { $connections = $connections | Where-Object { $_.LocalPort -eq [int]$Port } }
        return @($connections | ForEach-Object {
            [pscustomobject]@{ Address = $_.LocalAddress; Port = [int]$_.LocalPort; ProcessId = [int]$_.OwningProcess }
        })
    } catch {
        $rows = @()
        foreach ($line in (& netstat.exe -ano -p tcp)) {
            if ($line -notmatch '^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$') { continue }
            $row = [pscustomobject]@{ Address = $Matches[1].Trim('[', ']'); Port = [int]$Matches[2]; ProcessId = [int]$Matches[3] }
            if ($null -ne $ProcessId -and $row.ProcessId -ne [int]$ProcessId) { continue }
            if ($null -ne $Port -and $row.Port -ne [int]$Port) { continue }
            $rows += $row
        }
        return @($rows)
    }
}

function Assert-LoopbackListener {
    param([Parameter(Mandatory)][int]$ProcessId, [Parameter(Mandatory)][int]$Port)
    $listeners = @(Get-ListeningEndpoints -ProcessId $ProcessId -Port $Port)
    if ($listeners.Count -ne 1) {
        throw "Expected exactly one listener for PID $ProcessId on port $Port; found $($listeners.Count)."
    }
    if ($listeners[0].Address -notin @('127.0.0.1', '::1')) {
        throw "Refusing non-loopback listener $($listeners[0].Address):$Port."
    }
}

function Wait-HttpStatus {
    param([Parameter(Mandatory)][string]$Uri, [Parameter(Mandatory)][int]$ExpectedStatus, [int]$TimeoutSeconds = 20)
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri $Uri -TimeoutSec 3
            if ([int]$response.StatusCode -eq $ExpectedStatus) { return $response }
        } catch {
            if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq $ExpectedStatus) { return $_.Exception.Response }
        }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Timed out waiting for HTTP $ExpectedStatus from $Uri"
}

function Test-UnauthenticatedMcpRejected {
    param([Parameter(Mandatory)][int]$Port)
    $body = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"reporelay-ops","version":"1.0.0"}}}'
    try {
        Invoke-WebRequest -UseBasicParsing -Method Post -Uri "http://127.0.0.1:$Port/mcp" -Headers @{ Accept = 'application/json, text/event-stream' } -ContentType 'application/json' -Body $body -TimeoutSec 5 | Out-Null
    } catch {
        if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 401) { return }
        throw
    }
    throw 'Unauthenticated MCP initialize unexpectedly succeeded.'
}

function ConvertFrom-McpResponse {
    param([Parameter(Mandatory)][string]$Content)
    $jsonLine = @($Content -split "`r?`n" | Where-Object { $_ -like 'data:*' } | Select-Object -Last 1)
    if ($jsonLine.Count -gt 0) { return ($jsonLine[0].Substring(5).Trim() | ConvertFrom-Json) }
    return ($Content | ConvertFrom-Json)
}

function Test-AuthenticatedMcpSurface {
    param([Parameter(Mandatory)][int]$Port, [Parameter(Mandatory)][string]$BridgeSecretFile)
    $secretItem = Get-Item -LiteralPath $BridgeSecretFile -Force -ErrorAction Stop
    if ($secretItem.PSIsContainer) { throw "Bridge secret reference is not a file: $BridgeSecretFile" }
    $secret = (Get-Content -LiteralPath $secretItem.FullName -Raw -ErrorAction Stop).Trim()
    if ($secret.Length -lt 32) { throw 'Bridge secret material is missing or too short.' }
    try {
        $uri = "http://127.0.0.1:$Port/mcp"
        $headers = @{ Accept = 'application/json, text/event-stream'; 'X-RepoRelay-Bridge-Secret' = $secret }
        $initialize = @{
            jsonrpc = '2.0'; id = 1; method = 'initialize'; params = @{
                protocolVersion = '2025-06-18'; capabilities = @{}; clientInfo = @{ name = 'reporelay-ops'; version = '1.0.0' }
            }
        } | ConvertTo-Json -Depth 8 -Compress
        $response = Invoke-WebRequest -UseBasicParsing -Method Post -Uri $uri -Headers $headers -ContentType 'application/json' -Body $initialize -TimeoutSec 10
        $sessionId = [string]$response.Headers['mcp-session-id']
        if ([string]::IsNullOrWhiteSpace($sessionId)) { throw 'MCP initialize did not return a session ID.' }
        $sessionHeaders = $headers.Clone()
        $sessionHeaders['Mcp-Session-Id'] = $sessionId
        $sessionHeaders['MCP-Protocol-Version'] = '2025-06-18'
        Invoke-WebRequest -UseBasicParsing -Method Post -Uri $uri -Headers $sessionHeaders -ContentType 'application/json' -Body '{"jsonrpc":"2.0","method":"notifications/initialized"}' -TimeoutSec 10 | Out-Null
        $toolsResponse = Invoke-WebRequest -UseBasicParsing -Method Post -Uri $uri -Headers $sessionHeaders -ContentType 'application/json' -Body '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' -TimeoutSec 10
        $payload = ConvertFrom-McpResponse ([string]$toolsResponse.Content)
        $actual = @($payload.result.tools | ForEach-Object { [string]$_.name } | Sort-Object)
        $expected = @($script:RepoRelayRequiredTools | Sort-Object)
        if (($actual -join "`n") -cne ($expected -join "`n")) { throw "Unexpected MCP tool surface: $($actual -join ', ')" }
        return $actual
    } finally {
        $secret = $null
    }
}

function Get-TunnelExecutable {
    param([Parameter(Mandatory)][string]$TunnelRoot)
    $path = Join-Path $TunnelRoot 'v0.0.10\extracted\tunnel-client.exe'
    return [IO.Path]::GetFullPath((Get-Item -LiteralPath $path -Force -ErrorAction Stop).FullName)
}

function Get-TunnelProfileDirectory {
    param([Parameter(Mandatory)][string]$TunnelRoot)
    return [IO.Path]::GetFullPath((Get-Item -LiteralPath (Join-Path $TunnelRoot 'profiles') -Force -ErrorAction Stop).FullName)
}

function Find-CompatibleTunnelProcess {
    param([Parameter(Mandatory)][string]$TunnelExecutable, [Parameter(Mandatory)][string]$ProfileDirectory)
    $compatibleProcesses = @()
    foreach ($process in @(Get-CimInstance Win32_Process -Filter "Name='tunnel-client.exe'" -ErrorAction SilentlyContinue)) {
        if (-not $process.ExecutablePath -or -not (Test-SamePath $process.ExecutablePath $TunnelExecutable)) { continue }
        $commandLine = [string]$process.CommandLine
        if ($commandLine -notmatch '(?i)\brun\b' -or $commandLine -notmatch "(?i)--profile\s+$([regex]::Escape($script:RepoRelayTunnelProfile))\b") { continue }
        if ($commandLine -notmatch "(?i)--profile-dir\s+`"?$([regex]::Escape($ProfileDirectory))`"?(?:\s|$)") { continue }
        $compatibleProcesses += $process
    }
    if ($compatibleProcesses.Count -gt 1) { throw 'Multiple compatible tunnel-client processes are running; refusing an ambiguous adoption.' }
    return $compatibleProcesses | Select-Object -First 1
}

function Get-TunnelHealthUrl {
    param([Parameter(Mandatory)][int]$ProcessId)
    $listeners = @(Get-ListeningEndpoints -ProcessId $ProcessId -Port $null)
    if ($listeners.Count -ne 1) { throw "Expected one tunnel administration listener for PID $ProcessId; found $($listeners.Count)." }
    if ($listeners[0].Address -notin @('127.0.0.1', '::1')) {
        throw "Tunnel administration listener is not loopback-only: $($listeners[0].Address):$($listeners[0].Port)"
    }
    $hostPart = if ($listeners[0].Address -eq '::1') { '[::1]' } else { '127.0.0.1' }
    return "http://${hostPart}:$($listeners[0].Port)"
}

function Read-RuntimeMetadata {
    param([Parameter(Mandatory)][string]$RuntimeRoot)
    $paths = Get-RuntimePaths $RuntimeRoot
    if (-not (Test-Path -LiteralPath $paths.Metadata -PathType Leaf)) { return $null }
    return Get-Content -LiteralPath $paths.Metadata -Raw | ConvertFrom-Json
}

function Test-RecordedProcessIdentity {
    param([Parameter(Mandatory)]$Record, [Parameter(Mandatory)][ValidateSet('reporelay', 'tunnel')][string]$Kind)
    $process = Get-CimProcessById ([int]$Record.pid)
    $liveProcess = Get-Process -Id ([int]$Record.pid) -ErrorAction SilentlyContinue
    if (-not $liveProcess) { return $false }
    $liveExecutable = [string]$liveProcess.Path
    if ([string]::IsNullOrWhiteSpace($liveExecutable) -or -not (Test-SamePath $liveExecutable ([string]$Record.executable))) { return $false }
    $actualStart = $liveProcess.StartTime.ToUniversalTime()
    $recordedStart = [DateTime]::Parse([string]$Record.startTimeUtc).ToUniversalTime()
    if ([Math]::Abs(($actualStart - $recordedStart).TotalSeconds) -gt 2) { return $false }
    if (-not $process) {
        # Restricted Windows sessions may deny CIM command-line access. PID,
        # executable path, start time, and the caller's loopback checks remain
        # available as a bounded fallback; use the stronger command-line proof
        # whenever CIM is available.
        return $true
    }
    if (-not $process.ExecutablePath -or -not (Test-SamePath $process.ExecutablePath ([string]$Record.executable))) { return $false }
    $commandLine = [string]$process.CommandLine
    if ($Kind -eq 'reporelay') {
        if ($Record.PSObject.Properties.Name -contains 'entrypoint' -and -not [string]::IsNullOrWhiteSpace([string]$Record.entrypoint)) {
            $entrypointPattern = [regex]::Escape([IO.Path]::GetFullPath([string]$Record.entrypoint))
            if ($commandLine -notmatch "(?i)(?:^|\s)`"?$entrypointPattern`"?(?:\s|$)") { return $false }
        } elseif ($commandLine -notmatch '(?i)dist[\\/]server\.js') {
            return $false
        }
    }
    if ($Kind -eq 'tunnel') {
        if ($commandLine -notmatch '(?i)\brun\b') { return $false }
        if ($Record.PSObject.Properties.Name -contains 'profileDirectory' -and -not [string]::IsNullOrWhiteSpace([string]$Record.profileDirectory)) {
            $profileDirectoryPattern = [regex]::Escape([string]$Record.profileDirectory)
            if ($commandLine -notmatch "(?i)--profile-dir\s+`"?$profileDirectoryPattern`"?(?:\s|$)") { return $false }
        }
    }
    return $true
}

function Assert-TunnelStatusPayload {
    param([Parameter(Mandatory)]$Status)
    if (-not @($Status.channels | Where-Object { $_.name -eq 'main' -and $_.probe_status -eq 'ok' })) {
        throw 'Tunnel status does not report probe_status ok.'
    }
    if (
        $Status.PSObject.Properties.Name -contains 'tunnel_metadata_error' -and
        -not [string]::IsNullOrWhiteSpace([string]$Status.tunnel_metadata_error)
    ) {
        throw "Tunnel control-plane authentication is not operational: $($Status.tunnel_metadata_error)"
    }
}

function Assert-TunnelPollMetrics {
    param([Parameter(Mandatory)][string]$Content)
    function Read-MetricValue {
        param([Parameter(Mandatory)][string]$Name, [switch]$AllowMissing)
        $match = [regex]::Match($Content, "(?m)^$([regex]::Escape($Name))(?:\{[^}]*\})?\s+([0-9.eE+-]+)\s*$")
        if (-not $match.Success) {
            if ($AllowMissing) { return 0.0 }
            throw "Tunnel metrics do not expose $Name."
        }
        return [double]::Parse($match.Groups[1].Value, [Globalization.CultureInfo]::InvariantCulture)
    }
    $cycles = Read-MetricValue -Name 'commands_poll_cycles_total'
    $errors = Read-MetricValue -Name 'commands_poll_errors_total' -AllowMissing
    $lastSuccessfulPoll = Read-MetricValue -Name 'commands_poll_last_successful_timestamp_seconds'
    if ($cycles -le 0) { throw 'Tunnel has not initiated a control-plane poll.' }
    if ($errors -gt 0 -and $lastSuccessfulPoll -le 0) { throw 'Tunnel control-plane polls are failing.' }
}

function Get-TunnelStatusSummary {
    param([Parameter(Mandatory)][string]$HealthUrl, [int]$TimeoutSeconds = 10)
    $health = Wait-HttpStatus -Uri "$HealthUrl/healthz" -ExpectedStatus 200 -TimeoutSeconds $TimeoutSeconds
    $ready = Wait-HttpStatus -Uri "$HealthUrl/readyz" -ExpectedStatus 200 -TimeoutSeconds $TimeoutSeconds
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $statusResponse = Invoke-WebRequest -UseBasicParsing -Uri "$HealthUrl/api/status" -TimeoutSec $TimeoutSeconds
        $status = [string]$statusResponse.Content | ConvertFrom-Json
        Assert-TunnelStatusPayload -Status $status
        $metricsResponse = Invoke-WebRequest -UseBasicParsing -Uri "$HealthUrl/metrics" -TimeoutSec $TimeoutSeconds
        try {
            Assert-TunnelPollMetrics -Content ([string]$metricsResponse.Content)
            break
        } catch {
            if ([DateTime]::UtcNow -ge $deadline) { throw }
            Start-Sleep -Milliseconds 250
        }
    } while ($true)
    return [pscustomobject]@{
        HealthStatus = [int]$health.StatusCode
        ReadyStatus = [int]$ready.StatusCode
        ProbeStatus = 'ok'
        ControlPlaneStatus = 'ok'
    }
}

function Assert-TunnelOperational {
    param([Parameter(Mandatory)][int]$ProcessId, [Parameter(Mandatory)][string]$HealthUrl, [int]$TimeoutSeconds = 10)
    $listeners = @(Get-ListeningEndpoints -ProcessId $ProcessId -Port $null)
    if ($listeners.Count -ne 1 -or $listeners[0].Address -notin @('127.0.0.1', '::1')) {
        throw 'Tunnel administration listener is not a single loopback-only endpoint.'
    }
    return Get-TunnelStatusSummary -HealthUrl $HealthUrl -TimeoutSeconds $TimeoutSeconds
}

function Stop-RecordedProcess {
    param([Parameter(Mandatory)]$Record, [Parameter(Mandatory)][ValidateSet('reporelay', 'tunnel')][string]$Kind)
    if (-not (Test-RecordedProcessIdentity -Record $Record -Kind $Kind)) {
        throw "Refusing to stop PID $($Record.pid): its live identity no longer matches recorded $Kind metadata."
    }
    Stop-Process -Id ([int]$Record.pid) -ErrorAction Stop
    try { Wait-Process -Id ([int]$Record.pid) -Timeout 10 -ErrorAction Stop } catch {
        if (Test-RecordedProcessIdentity -Record $Record -Kind $Kind) {
            Stop-Process -Id ([int]$Record.pid) -Force -ErrorAction Stop
            Wait-Process -Id ([int]$Record.pid) -Timeout 5 -ErrorAction SilentlyContinue
        }
    }
}

function Set-TemporaryEnvironment {
    param([Parameter(Mandatory)][hashtable]$Values)
    $saved = @{}
    foreach ($name in $Values.Keys) {
        $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
        [Environment]::SetEnvironmentVariable($name, [string]$Values[$name], 'Process')
    }
    return $saved
}

function Restore-TemporaryEnvironment {
    param([Parameter(Mandatory)][hashtable]$Saved)
    foreach ($name in $Saved.Keys) { [Environment]::SetEnvironmentVariable($name, $Saved[$name], 'Process') }
}

function Read-TextFileShared {
    param([Parameter(Mandatory)][string]$Path)
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
    try {
        $reader = New-Object IO.StreamReader($stream)
        try { return $reader.ReadToEnd() } finally { $reader.Dispose() }
    } finally {
        $stream.Dispose()
    }
}
