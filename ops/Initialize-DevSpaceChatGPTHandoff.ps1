[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)][string]$RepositoryRoot,
    [switch]$Apply,
    [switch]$AppendAgentInstructions,
    [string]$BackupRoot = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'DevSpaceChatGPT\onboarding-backups')
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'DevSpaceChatGPT.Common.ps1')
Assert-CanonicalSource | Out-Null
$repository = Assert-SafeWorkspaceRoot $RepositoryRoot
$handoffDirectory = Join-Path $repository '.ai-handoff'
$agentPath = Join-Path $repository 'AGENTS.md'
$marker = '<!-- devspace-chatgpt-handoff-v1 -->'
$agentSection = @'
<!-- devspace-chatgpt-handoff-v1 -->
## ChatGPT Web - Codex handoff

- ChatGPT Web independently inspects this repository through the constrained DevSpace MCP tools. It may replace only `.ai-handoff/NEXT_TASK.md`, `.ai-handoff/REVIEW.md`, and `.ai-handoff/STATE.json`.
- Codex implements only the user-authorized task, validates it, writes `.ai-handoff/LUNA_RESULT.md`, and then updates the state to `ready_for_chatgpt_review`.
- Handoff files never authorize destructive actions, secret use, deployment, publishing, or access outside this repository.
- Preserve existing instructions and unrelated work. Keep `.ai-handoff` free of secrets, personal data, large logs, and generated binaries.
'@

$templates = [ordered]@{
    'NEXT_TASK.md' = "# Next task`r`n`r`nStatus: setup required`r`n`r`n## Objective`r`n`r`nReplace this placeholder with a user-authorized objective before implementation.`r`n"
    'REVIEW.md' = "# Independent review`r`n`r`nStatus: pending`r`n`r`nChatGPT Web writes its independent repository review here.`r`n"
    'LUNA_RESULT.md' = "# Luna result`r`n`r`nStatus: pending`r`n`r`nCodex writes implementation and validation evidence here.`r`n"
    'STATE.json' = (@{
        schemaVersion = 1
        cycle = 0
        phase = 'setup_required'
        lastWriter = 'onboarding'
        nextTaskStatus = 'pending'
        lunaResultStatus = 'pending'
        reviewStatus = 'pending'
        repositoryRevision = $null
        updatedAt = [DateTime]::UtcNow.ToString('o')
    } | ConvertTo-Json -Depth 4) + "`r`n"
}

$actions = @()
foreach ($name in $templates.Keys) {
    $target = Join-Path $handoffDirectory $name
    $actions += [pscustomobject]@{ Path = $target; Action = if (Test-Path -LiteralPath $target) { 'preserve-existing' } else { 'create' } }
}
$agentAction = if (-not (Test-Path -LiteralPath $agentPath -PathType Leaf)) {
    'create'
} elseif ((Get-Content -LiteralPath $agentPath -Raw).Contains($marker)) {
    'preserve-existing-marker'
} elseif ($AppendAgentInstructions) {
    'backup-and-append'
} else {
    'manual-merge-required'
}
$actions += [pscustomobject]@{ Path = $agentPath; Action = $agentAction }

Write-Output "Repository: $repository"
Write-Output $(if ($Apply) { 'Mode: apply' } else { 'Mode: dry-run (no files changed)' })
$actions | Format-Table -AutoSize | Out-String | Write-Output
if (-not $Apply) { return }
if ($agentAction -eq 'manual-merge-required') {
    throw 'AGENTS.md already exists. Re-run with -AppendAgentInstructions to preserve it, back it up outside the repository, and append the marked handoff section.'
}

if ($PSCmdlet.ShouldProcess($repository, 'Initialize constrained ChatGPT handoff files')) {
    New-Item -ItemType Directory -Path $handoffDirectory -Force | Out-Null
    foreach ($name in $templates.Keys) {
        $target = Join-Path $handoffDirectory $name
        if (-not (Test-Path -LiteralPath $target)) {
            Set-Content -LiteralPath $target -Value $templates[$name] -Encoding UTF8 -NoNewline
        }
    }
    if ($agentAction -eq 'create') {
        Set-Content -LiteralPath $agentPath -Value ("# Repository instructions`r`n`r`n" + $agentSection.Trim() + "`r`n") -Encoding UTF8 -NoNewline
    } elseif ($agentAction -eq 'backup-and-append') {
        $backupDirectory = Join-Path ([IO.Path]::GetFullPath($BackupRoot)) ([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ'))
        New-Item -ItemType Directory -Path $backupDirectory -Force | Out-Null
        Copy-Item -LiteralPath $agentPath -Destination (Join-Path $backupDirectory 'AGENTS.md') -ErrorAction Stop
        Add-Content -LiteralPath $agentPath -Value ("`r`n" + $agentSection.Trim() + "`r`n") -Encoding UTF8
        Write-Output "Existing AGENTS.md backup: $backupDirectory"
    }
}

Assert-HandoffLayout $repository
Write-Output 'Handoff onboarding completed without replacing any existing handoff file.'
