[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$TunnelRoot = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'DevSpaceChatGPT\tunnel-client'),
    [Parameter(Mandatory)][string]$ExposedWorkspace
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'DevSpaceChatGPT.Common.ps1')
$sourceRoot = Assert-CanonicalSource
$workspace = Assert-SafeWorkspaceRoot $ExposedWorkspace
$tunnel = [IO.Path]::GetFullPath((Get-Item -LiteralPath $TunnelRoot -Force -ErrorAction Stop).FullName)
if ((Test-PathContains -Parent $workspace -Candidate $tunnel) -or (Test-PathContains -Parent $sourceRoot -Candidate $tunnel)) {
    throw 'Tunnel material must remain outside both the exposed workspace and canonical source tree.'
}

$profile = Join-Path $tunnel "profiles\$script:DevSpaceTunnelProfile.yaml"
$secretDirectory = Join-Path $tunnel 'secrets'
$bridgeSecret = Join-Path $secretDirectory 'devspace-bridge-secret.txt'
$controlPlaneSecret = Join-Path $secretDirectory 'control-plane-api-key.txt'
foreach ($path in @($profile, $bridgeSecret)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Required tunnel file is missing: $path" }
}

$content = [IO.File]::ReadAllText($profile)
$inlinePattern = '(?m)^(\s*api_key:\s*)"([^"\r\n]+)"\s*$'
$environmentPattern = '(?m)^\s*api_key:\s*"\$\{env:CONTROL_PLANE_API_KEY\}"\s*$'
$inlineMatch = [regex]::Match($content, $inlinePattern)
if (-not $inlineMatch.Success -and -not [regex]::IsMatch($content, $environmentPattern)) {
    throw 'Tunnel profile API key must be either one inline quoted value for migration or the CONTROL_PLANE_API_KEY environment reference.'
}

$canonicalBridge = $bridgeSecret.Replace('\', '/')
$updated = [regex]::Replace(
    $content,
    '(?m)^(\s*X-DevSpace-Bridge-Secret:\s*)"?file:[^"\r\n]+"?\s*$',
    "`$1`"file:$canonicalBridge`""
)
if (@([regex]::Matches($updated, [regex]::Escape("file:$canonicalBridge"))).Count -ne 2) {
    throw 'Expected exactly two bridge-secret file references after migration.'
}
if ($inlineMatch.Success) {
    $updated = [regex]::Replace($updated, $inlinePattern, '$1"${env:CONTROL_PLANE_API_KEY}"', 1)
}

if ($PSCmdlet.ShouldProcess($tunnel, 'Protect tunnel credentials and update profile references')) {
    $history = Join-Path (Split-Path -Parent $tunnel) (Join-Path 'history' ([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')))
    New-Item -ItemType Directory -Path $history -Force | Out-Null
    if ($inlineMatch.Success) {
        [IO.File]::WriteAllText($controlPlaneSecret, $inlineMatch.Groups[2].Value, [Text.UTF8Encoding]::new($false))
    } elseif (-not (Test-Path -LiteralPath $controlPlaneSecret -PathType Leaf)) {
        throw 'Protected control-plane API key file is missing.'
    }
    [IO.File]::WriteAllText($profile, $updated, [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $history 'devspace-chatgpt.protected.yaml'), $updated, [Text.UTF8Encoding]::new($false))

    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    foreach ($protectedDirectory in @($tunnel, $history)) {
        & icacls.exe $protectedDirectory '/inheritance:r' '/grant:r' "$identity`:(OI)(CI)(F)" 'SYSTEM:(OI)(CI)(F)' | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Failed to apply the protected directory ACL: $protectedDirectory" }
    }
}

$finalContent = [IO.File]::ReadAllText($profile)
if (-not [regex]::IsMatch($finalContent, $environmentPattern)) { throw 'Control-plane API key was not converted to an environment reference.' }
if (-not (Test-Path -LiteralPath $controlPlaneSecret -PathType Leaf)) { throw 'Protected control-plane API key file is missing after migration.' }
Write-Output "Tunnel credentials are protected outside the exposed workspace: $tunnel"
