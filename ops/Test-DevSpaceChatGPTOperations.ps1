[CmdletBinding()]
param(
    [string]$RecycleScript = $env:CHATGPT_CODEX_MCP_RECYCLE_SCRIPT
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'DevSpaceChatGPT.Common.ps1')
Assert-CanonicalSource | Out-Null

function Assert-True {
    param([Parameter(Mandatory)][bool]$Condition, [Parameter(Mandatory)][string]$Message)
    if (-not $Condition) { throw "Operations test failed: $Message" }
}
$fixture = Join-Path ([IO.Path]::GetTempPath()) ("DevSpaceChatGPT-ops-test-" + [guid]::NewGuid().ToString('N'))
$backup = Join-Path ([IO.Path]::GetTempPath()) ("DevSpaceChatGPT-ops-backup-" + [guid]::NewGuid().ToString('N'))
$failedRuntimeRoot = $null
New-Item -ItemType Directory -Path $fixture -Force | Out-Null
try {
    Set-Content -LiteralPath (Join-Path $fixture 'AGENTS.md') -Value "# Existing instructions`r`n`r`nPRESERVE-ME`r`n" -Encoding UTF8
    $initializer = Join-Path $PSScriptRoot 'Initialize-DevSpaceChatGPTHandoff.ps1'
    & $initializer -RepositoryRoot $fixture | Out-Null
    Assert-True -Condition (-not (Test-Path -LiteralPath (Join-Path $fixture '.ai-handoff'))) -Message 'dry-run created files'

    $failedClosed = $false
    try { & $initializer -RepositoryRoot $fixture -Apply | Out-Null } catch { $failedClosed = $_.Exception.Message -like '*manual-merge-required*' -or $_.Exception.Message -like '*AGENTS.md already exists*' }
    Assert-True -Condition $failedClosed -Message 'existing AGENTS.md was not protected'

    & $initializer -RepositoryRoot $fixture -Apply -AppendAgentInstructions -BackupRoot $backup | Out-Null
    Assert-HandoffLayout $fixture
    $agents = Get-Content -LiteralPath (Join-Path $fixture 'AGENTS.md') -Raw
    Assert-True -Condition $agents.Contains('PRESERVE-ME') -Message 'existing AGENTS.md content was lost'
    Assert-True -Condition $agents.Contains('devspace-chatgpt-handoff-v1') -Message 'handoff instructions were not appended'
    Assert-True -Condition $agents.Contains('`ready_for_chatgpt_review`') -Message 'Markdown code span was not preserved in handoff instructions'
    Assert-True -Condition (@(Get-ChildItem -LiteralPath $backup -Recurse -Filter 'AGENTS.md').Count -eq 1) -Message 'AGENTS.md backup was not created'

    $hashesBefore = @{}
    foreach ($name in @('NEXT_TASK.md', 'REVIEW.md', 'LUNA_RESULT.md', 'STATE.json')) {
        $path = Join-Path (Join-Path $fixture '.ai-handoff') $name
        $hashesBefore[$name] = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
    }
    & $initializer -RepositoryRoot $fixture -Apply -AppendAgentInstructions -BackupRoot $backup | Out-Null
    foreach ($name in $hashesBefore.Keys) {
        $path = Join-Path (Join-Path $fixture '.ai-handoff') $name
        Assert-True -Condition ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -eq $hashesBefore[$name]) -Message "$name was overwritten on repeat onboarding"
    }

    foreach ($dangerous in @([IO.Path]::GetPathRoot($fixture), [Environment]::GetFolderPath('UserProfile'))) {
        $rejected = $false
        try { Assert-SafeWorkspaceRoot $dangerous | Out-Null } catch { $rejected = $true }
        Assert-True -Condition $rejected -Message "dangerous root was accepted: $dangerous"
    }

    $validTunnelStatus = [pscustomobject]@{
        channels = @([pscustomobject]@{ name = 'main'; probe_status = 'ok' })
        tunnel_metadata_error = $null
    }
    Assert-TunnelStatusPayload -Status $validTunnelStatus
    Assert-TunnelPollMetrics -Content @'
commands_poll_cycles_total{scope="controlplane"} 2
commands_poll_errors_total{scope="controlplane"} 0
commands_poll_last_successful_timestamp_seconds{scope="controlplane"} 1786590000
'@

    Assert-TunnelPollMetrics -Content @'
commands_poll_cycles_total{scope="controlplane"} 1
commands_poll_errors_total{scope="controlplane"} 0
commands_poll_last_successful_timestamp_seconds{scope="controlplane"} 0
'@

    $pollFailureDetected = $false
    try {
        Assert-TunnelPollMetrics -Content @'
commands_poll_cycles_total{scope="controlplane"} 3
commands_poll_errors_total{scope="controlplane"} 3
commands_poll_last_successful_timestamp_seconds{scope="controlplane"} 0
'@
    } catch { $pollFailureDetected = $_.Exception.Message -like '*control-plane polls are failing*' }
    Assert-True -Condition $pollFailureDetected -Message 'failing control-plane polls were accepted'

    $invalidTunnelStatus = [pscustomobject]@{
        channels = @([pscustomobject]@{ name = 'main'; probe_status = 'ok' })
        tunnel_metadata_error = 'controlplane client: unexpected metadata status 401: Unauthorized'
    }
    $controlPlaneFailureDetected = $false
    try { Assert-TunnelStatusPayload -Status $invalidTunnelStatus } catch { $controlPlaneFailureDetected = $_.Exception.Message -like '*control-plane authentication is not operational*' }
    Assert-True -Condition $controlPlaneFailureDetected -Message 'control-plane authentication failure was not detected'

    $missingRuntime = Join-Path ([IO.Path]::GetTempPath()) ("DevSpaceChatGPT-no-runtime-" + [guid]::NewGuid().ToString('N'))
    $stopOutput = & (Join-Path $PSScriptRoot 'Stop-DevSpaceChatGPT.ps1') -RuntimeRoot $missingRuntime
    Assert-True -Condition (($stopOutput -join ' ') -like '*already stopped*') -Message 'stop was not idempotent when metadata was absent'

    $failedRuntimeRoot = Join-Path ([IO.Path]::GetTempPath()) ("DevSpaceChatGPT-failed-runtime-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $failedRuntimeRoot -Force | Out-Null
    [pscustomobject]@{ schemaVersion = 1; status = 'failed'; workspaceRoot = $fixture; port = 7676 } |
        ConvertTo-Json | Set-Content -LiteralPath (Join-Path $failedRuntimeRoot 'runtime.json') -Encoding UTF8
    $diagnosticsOutput = & (Join-Path $PSScriptRoot 'Get-DevSpaceChatGPTDiagnostics.ps1') -RuntimeRoot $failedRuntimeRoot
    Assert-True -Condition (($diagnosticsOutput -join ' ') -like '*Runtime status: failed*PID none*') -Message 'diagnostics did not handle failed startup metadata'

    Write-Output 'RepoRelay operations tests passed.'
} finally {
    foreach ($path in @($fixture, $backup, $failedRuntimeRoot)) {
        if ($path -and (Test-Path -LiteralPath $path)) {
            if ($RecycleScript -and (Test-Path -LiteralPath $RecycleScript -PathType Leaf)) {
                & $RecycleScript -LiteralPath $path | Out-Null
            } else {
                Write-Output "Fixture preserved (set CHATGPT_CODEX_MCP_RECYCLE_SCRIPT to recycle it): $path"
            }
        }
    }
}
