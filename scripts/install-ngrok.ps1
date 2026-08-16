[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

function Get-NgrokCommand {
  return Get-Command ngrok -ErrorAction SilentlyContinue
}

$ngrokCommand = Get-NgrokCommand
if ($ngrokCommand) {
  Write-Host "ngrok is already available at $($ngrokCommand.Source)."
  & $ngrokCommand.Source version
  exit 0
}

if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
  throw "ngrok is not on PATH and winget is unavailable. Install ngrok from https://ngrok.com/download, then reopen PowerShell."
}

Write-Host "Installing the official ngrok package with winget..."
& winget install --id ngrok.ngrok --exact --source winget `
  --accept-source-agreements --accept-package-agreements
if ($LASTEXITCODE -ne 0) {
  throw "winget could not install ngrok (exit code $LASTEXITCODE)."
}

$ngrokCommand = Get-NgrokCommand
if ($ngrokCommand) {
  Write-Host "ngrok installation completed."
  & $ngrokCommand.Source version
  exit 0
}

$candidatePaths = @(
  (Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Links\ngrok.exe"),
  (Join-Path $env:ProgramFiles "ngrok\ngrok.exe")
)
foreach ($candidatePath in $candidatePaths) {
  if (Test-Path -LiteralPath $candidatePath -PathType Leaf) {
    Write-Warning "ngrok was installed at $candidatePath. Restart PowerShell so PATH changes take effect."
    exit 0
  }
}

throw "ngrok was installed by winget, but the executable is not visible yet. Restart PowerShell and run 'ngrok version'."
