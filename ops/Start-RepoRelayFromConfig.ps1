[CmdletBinding()]
param(
    [string]$ConfigPath = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'RepoRelay\operator-config.json')
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'RepoRelay.Common.ps1')
Assert-CanonicalSource | Out-Null
$configItem = Get-Item -LiteralPath $ConfigPath -Force -ErrorAction Stop
if ($configItem.PSIsContainer) { throw "Operator config is not a file: $ConfigPath" }
$config = Get-Content -LiteralPath $configItem.FullName -Raw | ConvertFrom-Json
foreach ($required in @('workspaceRoot', 'tunnelRoot', 'runtimeRoot', 'bridgeSecretFile', 'controlPlaneApiKeyFile')) {
    if (-not ($config.PSObject.Properties.Name -contains $required) -or [string]::IsNullOrWhiteSpace([string]$config.$required)) {
        throw "Operator config is missing '$required'."
    }
}
& (Join-Path $PSScriptRoot 'Start-RepoRelay.ps1') `
    -WorkspaceRoot ([string]$config.workspaceRoot) `
    -TunnelRoot ([string]$config.tunnelRoot) `
    -RuntimeRoot ([string]$config.runtimeRoot) `
    -BridgeSecretFile ([string]$config.bridgeSecretFile) `
    -ControlPlaneApiKeyFile ([string]$config.controlPlaneApiKeyFile)
