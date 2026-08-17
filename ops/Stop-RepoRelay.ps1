[CmdletBinding()]
param(
    [string]$RuntimeRoot = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'RepoRelay'),
    [switch]$KeepTunnel
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'RepoRelay.Common.ps1')
Assert-CanonicalSource | Out-Null

$paths = Get-RuntimePaths $RuntimeRoot
$metadata = Read-RuntimeMetadata $paths.Root
if (-not $metadata) {
    Write-Output 'RepoRelay is already stopped; no runtime metadata exists.'
    return
}

$stopped = @()
$hasRepoRelayRecord = $metadata.PSObject.Properties.Name -contains 'reporelay' -and $null -ne $metadata.reporelay
if ($hasRepoRelayRecord -and (Test-RecordedProcessIdentity -Record $metadata.reporelay -Kind reporelay)) {
    Stop-RecordedProcess -Record $metadata.reporelay -Kind reporelay
    $stopped += "RepoRelay PID $($metadata.reporelay.pid)"
} elseif ($hasRepoRelayRecord -and (Get-CimProcessById ([int]$metadata.reporelay.pid))) {
    Write-Warning "Recorded RepoRelay PID $($metadata.reporelay.pid) belongs to a different process and was not touched."
}

if (-not $KeepTunnel -and $metadata.tunnel -and (Test-RecordedProcessIdentity -Record $metadata.tunnel -Kind tunnel)) {
    Stop-RecordedProcess -Record $metadata.tunnel -Kind tunnel
    $stopped += "tunnel PID $($metadata.tunnel.pid)"
} elseif (-not $KeepTunnel -and $metadata.tunnel -and (Get-CimProcessById ([int]$metadata.tunnel.pid))) {
    Write-Warning "Recorded tunnel PID $($metadata.tunnel.pid) belongs to a different process and was not touched."
}

$metadata.status = if ($KeepTunnel -and $metadata.tunnel) { 'reporelay-stopped-tunnel-preserved' } else { 'stopped' }
$metadata | Add-Member -NotePropertyName stoppedAtUtc -NotePropertyValue ([DateTime]::UtcNow.ToString('o')) -Force
$metadata | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $paths.Metadata -Encoding UTF8

if ($stopped.Count -eq 0) {
    Write-Output 'Recorded processes were already stopped; metadata was updated.'
} else {
    Write-Output ("Stopped: " + ($stopped -join ', ') + '.')
}
if ($KeepTunnel -and $metadata.tunnel) { Write-Output "Tunnel PID $($metadata.tunnel.pid) was intentionally preserved." }
