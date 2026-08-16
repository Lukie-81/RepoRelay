[CmdletBinding()]
param(
    [string]$RuntimeRoot = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'DevSpaceChatGPT'),
    [ValidateRange(1, 500)][int]$RecentEvents = 40
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'DevSpaceChatGPT.Common.ps1')
$sourceRoot = Assert-CanonicalSource
$metadata = Read-RuntimeMetadata $RuntimeRoot
if (-not $metadata) { throw "Runtime metadata is missing under $RuntimeRoot." }

$devspaceLive = $metadata.PSObject.Properties.Name -contains 'devspace' -and
    $null -ne $metadata.devspace -and
    (Test-RecordedProcessIdentity -Record $metadata.devspace -Kind devspace)
$devspacePid = if ($metadata.PSObject.Properties.Name -contains 'devspace' -and $metadata.devspace) { [string]$metadata.devspace.pid } else { 'none' }
$listeners = if ($devspaceLive) { @(Get-ListeningEndpoints -ProcessId ([int]$metadata.devspace.pid) -Port ([int]$metadata.port)) } else { @() }

$eventRows = @()
if ($devspaceLive -and (Test-Path -LiteralPath ([string]$metadata.devspace.stdoutLog) -PathType Leaf)) {
    foreach ($line in @(Get-Content -LiteralPath ([string]$metadata.devspace.stdoutLog) -Tail $RecentEvents)) {
        try {
            $event = $line | ConvertFrom-Json -ErrorAction Stop
            $eventRows += [pscustomobject]@{
                Time = if ($event.PSObject.Properties.Name -contains 'ts') { [string]$event.ts } else { '' }
                Event = if ($event.PSObject.Properties.Name -contains 'event') { [string]$event.event } else { '' }
                Method = if ($event.PSObject.Properties.Name -contains 'method') { [string]$event.method } else { '' }
                Path = if ($event.PSObject.Properties.Name -contains 'path') { [string]$event.path } else { '' }
                Status = if ($event.PSObject.Properties.Name -contains 'status') { [string]$event.status } else { '' }
                Tool = if ($event.PSObject.Properties.Name -contains 'tool') { [string]$event.tool } else { '' }
            }
        } catch {
            # Ignore non-JSON startup lines; never echo raw log content.
        }
    }
}

$tunnel = $null
if ($metadata.PSObject.Properties.Name -contains 'tunnel' -and $metadata.tunnel) {
    $tunnelLive = Test-RecordedProcessIdentity -Record $metadata.tunnel -Kind tunnel
    if ($tunnelLive) {
        try {
            $summary = Assert-TunnelOperational -ProcessId ([int]$metadata.tunnel.pid) -HealthUrl ([string]$metadata.tunnel.healthUrl) -TimeoutSeconds 10
            $status = (Invoke-WebRequest -UseBasicParsing -Uri "$($metadata.tunnel.healthUrl)/api/status" -TimeoutSec 5).Content | ConvertFrom-Json
            $mainChannel = @($status.channels | Where-Object { $_.name -eq 'main' }) | Select-Object -First 1
            $tunnel = [pscustomobject]@{
                Pid = [int]$metadata.tunnel.pid
                Health = $summary.HealthStatus
                Ready = $summary.ReadyStatus
                Probe = [string]$mainChannel.probe_status
                ControlPlane = $summary.ControlPlaneStatus
                StartedAt = [string]$status.started_at
                UptimeSeconds = [long]$status.uptime_seconds
                Target = [string]$status.mcp_server_url
                RawHttpLogging = [bool]$status.raw_http_logging_enabled
            }
        } catch {
            $tunnel = [pscustomobject]@{
                Pid = [int]$metadata.tunnel.pid
                Health = 'error'
                Ready = 'error'
                Probe = 'unknown'
                ControlPlane = 'error'
                Error = $_.Exception.Message
            }
        }
    } else {
        $tunnel = [pscustomobject]@{ Pid = [int]$metadata.tunnel.pid; Health = 'not-live'; Ready = 'not-live'; Probe = 'unknown' }
    }
}

Write-Output "Canonical source: $sourceRoot"
Write-Output "Runtime status: $($metadata.status)"
Write-Output "Workspace: $($metadata.workspaceRoot)"
Write-Output "DevSpace live: $devspaceLive (PID $devspacePid)"
Write-Output "Listeners: $(@($listeners | ForEach-Object { "$($_.Address):$($_.Port)" }) -join ', ')"
if ($tunnel) { Write-Output ("Tunnel: " + ($tunnel | ConvertTo-Json -Compress)) }
Write-Output 'Recent sanitized DevSpace events:'
if ($eventRows.Count -eq 0) { Write-Output '  none' } else { $eventRows | Format-Table -AutoSize | Out-String | Write-Output }
