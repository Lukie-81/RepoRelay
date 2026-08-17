[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)][string]$WorkspaceRoot,
    [Parameter(Mandatory)][string]$ControlPlaneApiKeyFile,
    [string]$TunnelRoot = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'RepoRelay\tunnel-client'),
    [string]$RuntimeRoot = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'RepoRelay'),
    [string]$BridgeSecretFile = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'RepoRelay\tunnel-client\secrets\reporelay-bridge-secret.txt'),
    [string]$TaskName = 'RepoRelay MCP',
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'RepoRelay.Common.ps1')
$sourceRoot = Assert-CanonicalSource
$workspace = Assert-SafeWorkspaceRoot $WorkspaceRoot
Assert-HandoffLayout $workspace
$keyItem = Get-Item -LiteralPath $ControlPlaneApiKeyFile -Force -ErrorAction Stop
if ($keyItem.PSIsContainer -or (Get-Content -LiteralPath $keyItem.FullName -Raw).Trim().Length -lt 16) {
    throw 'Control-plane API key file is missing, empty, or too short.'
}
$keyPath = [IO.Path]::GetFullPath($keyItem.FullName)
if ((Test-PathContains -Parent $workspace -Candidate $keyPath) -or (Test-PathContains -Parent $sourceRoot -Candidate $keyPath)) {
    throw 'The control-plane API key file must be outside both the approved repository and the RepoRelay source tree.'
}
$unsafeAcl = @((Get-Acl -LiteralPath $keyPath).Access | Where-Object {
    $_.AccessControlType -eq 'Allow' -and
    [string]$_.IdentityReference -match '(?i)(Everyone|BUILTIN\\Users|Authenticated Users)' -and
    ([int]$_.FileSystemRights -band [int][Security.AccessControl.FileSystemRights]::ReadData)
})
if ($unsafeAcl.Count -gt 0) { throw 'The control-plane API key file ACL permits broad read access. Tighten it before installing autostart.' }

$runtimePaths = Get-RuntimePaths $RuntimeRoot
New-Item -ItemType Directory -Path $runtimePaths.Root -Force | Out-Null
$configPath = Join-Path $runtimePaths.Root 'operator-config.json'
$existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (($existingTask -or (Test-Path -LiteralPath $configPath)) -and -not $Force) {
    throw 'Autostart configuration already exists. Re-run with -Force only after reviewing the current task and config.'
}
if ($Force) {
    $history = Join-Path $runtimePaths.Root (Join-Path 'history' ([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')))
    New-Item -ItemType Directory -Path $history -Force | Out-Null
    if (Test-Path -LiteralPath $configPath -PathType Leaf) { Copy-Item -LiteralPath $configPath -Destination (Join-Path $history 'operator-config.json') }
    if ($existingTask) { Export-ScheduledTask -TaskName $TaskName | Set-Content -LiteralPath (Join-Path $history 'scheduled-task.xml') -Encoding UTF8 }
}

$config = [ordered]@{
    schemaVersion = 1
    workspaceRoot = $workspace
    tunnelRoot = [IO.Path]::GetFullPath((Get-Item -LiteralPath $TunnelRoot -Force).FullName)
    runtimeRoot = $runtimePaths.Root
    bridgeSecretFile = [IO.Path]::GetFullPath((Get-Item -LiteralPath $BridgeSecretFile -Force).FullName)
    controlPlaneApiKeyFile = $keyPath
}
$powerShell = Join-Path $PSHOME 'powershell.exe'
$launcher = Join-Path $PSScriptRoot 'Start-RepoRelayFromConfig.ps1'
$action = New-ScheduledTaskAction -Execute $powerShell -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$launcher`" -ConfigPath `"$configPath`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User ([Environment]::UserName)
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$task = New-ScheduledTask -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Starts the loopback-only hardened RepoRelay MCP stack for the current user.'

if ($PSCmdlet.ShouldProcess($TaskName, 'Write operator config and register per-user logon task')) {
    $config | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $configPath -Encoding UTF8
    Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null
    Write-Output "Autostart installed for the current user: $TaskName"
    Write-Output "Operator config (paths only; no secret values): $configPath"
}
