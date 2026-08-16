[CmdletBinding()]
param(
    [string]$RuntimeRoot = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'DevSpaceChatGPT'),
    [switch]$KeepTunnel
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'DevSpaceChatGPT.Common.ps1')
Assert-CanonicalSource | Out-Null

$paths = Get-RuntimePaths $RuntimeRoot
$metadata = Read-RuntimeMetadata $paths.Root
if (-not $metadata) {
    Write-Output 'RepoRelay is already stopped; no runtime metadata exists.'
    return
}

$stopped = @()
$hasDevSpaceRecord = $metadata.PSObject.Properties.Name -contains 'devspace' -and $null -ne $metadata.devspace
if ($hasDevSpaceRecord -and (Test-RecordedProcessIdentity -Record $metadata.devspace -Kind devspace)) {
    Stop-RecordedProcess -Record $metadata.devspace -Kind devspace
    $stopped += "DevSpace PID $($metadata.devspace.pid)"
} elseif ($hasDevSpaceRecord -and (Get-CimProcessById ([int]$metadata.devspace.pid))) {
    Write-Warning "Recorded DevSpace PID $($metadata.devspace.pid) belongs to a different process and was not touched."
}

if (-not $KeepTunnel -and $metadata.tunnel -and (Test-RecordedProcessIdentity -Record $metadata.tunnel -Kind tunnel)) {
    Stop-RecordedProcess -Record $metadata.tunnel -Kind tunnel
    $stopped += "tunnel PID $($metadata.tunnel.pid)"
} elseif (-not $KeepTunnel -and $metadata.tunnel -and (Get-CimProcessById ([int]$metadata.tunnel.pid))) {
    Write-Warning "Recorded tunnel PID $($metadata.tunnel.pid) belongs to a different process and was not touched."
}

$metadata.status = if ($KeepTunnel -and $metadata.tunnel) { 'devspace-stopped-tunnel-preserved' } else { 'stopped' }
$metadata | Add-Member -NotePropertyName stoppedAtUtc -NotePropertyValue ([DateTime]::UtcNow.ToString('o')) -Force
$metadata | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $paths.Metadata -Encoding UTF8

if ($stopped.Count -eq 0) {
    Write-Output 'Recorded processes were already stopped; metadata was updated.'
} else {
    Write-Output ("Stopped: " + ($stopped -join ', ') + '.')
}
if ($KeepTunnel -and $metadata.tunnel) { Write-Output "Tunnel PID $($metadata.tunnel.pid) was intentionally preserved." }
