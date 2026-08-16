[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)][ValidateSet('Status', 'Enable', 'Disable', 'Run', 'Remove')][string]$Action,
    [string]$TaskName = 'DevSpace ChatGPT MCP'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'DevSpaceChatGPT.Common.ps1')
Assert-CanonicalSource | Out-Null
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($Action -eq 'Status') {
    if (-not $task) { Write-Output "Autostart task is not installed: $TaskName"; return }
    $info = Get-ScheduledTaskInfo -TaskName $TaskName
    [pscustomobject]@{ TaskName = $TaskName; State = $task.State; LastRunTime = $info.LastRunTime; LastTaskResult = $info.LastTaskResult; NextRunTime = $info.NextRunTime }
    return
}
if (-not $task) { throw "Autostart task is not installed: $TaskName" }
if ($PSCmdlet.ShouldProcess($TaskName, $Action)) {
    switch ($Action) {
        'Enable' { Enable-ScheduledTask -TaskName $TaskName | Out-Null }
        'Disable' { Disable-ScheduledTask -TaskName $TaskName | Out-Null }
        'Run' { Start-ScheduledTask -TaskName $TaskName }
        'Remove' { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
    }
    Write-Output "$Action completed for autostart task: $TaskName"
}
