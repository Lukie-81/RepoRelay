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
Assert-CanonicalSource | Out-Null

# Complete every target-side safety check before interrupting the current server.
$targetWorkspace = Assert-SafeWorkspaceRoot $WorkspaceRoot
Assert-HandoffLayout $targetWorkspace
Get-Item -LiteralPath $BridgeSecretFile -Force -ErrorAction Stop | Out-Null

$oldMetadata = Read-RuntimeMetadata $RuntimeRoot
$oldWorkspace = if ($oldMetadata) { [string]$oldMetadata.workspaceRoot } else { $null }
$oldWasRunning = [bool]($oldMetadata -and $oldMetadata.status -eq 'running' -and (Test-RecordedProcessIdentity -Record $oldMetadata.devspace -Kind devspace))
$stopScript = Join-Path $PSScriptRoot 'Stop-DevSpaceChatGPT.ps1'
$startScript = Join-Path $PSScriptRoot 'Start-DevSpaceChatGPT.ps1'

if ($oldWasRunning) {
    & $stopScript -RuntimeRoot $RuntimeRoot -KeepTunnel
}

$startParameters = @{
    WorkspaceRoot = $targetWorkspace
    Port = $Port
    TunnelRoot = $TunnelRoot
    RuntimeRoot = $RuntimeRoot
    BridgeSecretFile = $BridgeSecretFile
    SkipTunnel = $SkipTunnel
}
if ($ControlPlaneApiKeyFile) { $startParameters.ControlPlaneApiKeyFile = $ControlPlaneApiKeyFile }

try {
    & $startScript @startParameters
} catch {
    $startFailure = $_
    if ($oldWasRunning -and $oldWorkspace) {
        Write-Warning "Restart failed; restoring the previously recorded workspace from $oldWorkspace."
        $rollbackParameters = $startParameters.Clone()
        $rollbackParameters.WorkspaceRoot = $oldWorkspace
        try {
            & $startScript @rollbackParameters
            Write-Warning 'The previous DevSpace workspace was restored successfully.'
        } catch {
            throw "Restart failed and automatic rollback also failed. Start failure: $($startFailure.Exception.Message) Rollback failure: $($_.Exception.Message)"
        }
    }
    throw $startFailure
}
