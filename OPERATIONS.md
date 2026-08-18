# RepoRelay operations

RepoRelay's Windows scripts manage the authenticated loopback bridge. They use
the checkout containing the script as the source of truth and default runtime
records to `%LOCALAPPDATA%\RepoRelay`.

## Prepare and verify

```powershell
npm ci
npm run verify:release
```

The approved repository must be an existing canonical directory narrower than
the Windows user profile and must contain these regular files:

```text
.ai-handoff/NEXT_TASK.md
.ai-handoff/REVIEW.md
.ai-handoff/RESULT.md
.ai-handoff/STATE.json
```

Preview or apply the layout with:

```powershell
.\ops\Initialize-RepoRelayHandoff.ps1 -RepositoryRoot "C:\path\to\approved-repository" -WhatIf
.\ops\Initialize-RepoRelayHandoff.ps1 -RepositoryRoot "C:\path\to\approved-repository" -Apply
```

An existing `AGENTS.md` is preserved; pass `-AppendAgentInstructions` only
after reviewing the external backup behavior.

Keep bridge secrets, tunnel credentials, tunnel binaries, and tunnel profiles
outside every repository. RepoRelay intentionally has separate runtime layouts:

- CLI quickstart uses `%LOCALAPPDATA%\RepoRelay\reporelay-bridge-secret.txt`.
- CLI tunnel setup adds `%LOCALAPPDATA%\RepoRelay\tunnel\config.json`, the
  `profiles\reporelay.yaml` profile, and the protected
  `secrets\openai-runtime-api-key.txt` file.
- Managed Windows and tunnel lifecycle scripts default to
  `%LOCALAPPDATA%\RepoRelay\tunnel-client\secrets\reporelay-bridge-secret.txt`.

When a lifecycle script is given `-BridgeSecretFile`, that explicit path is
used instead of its managed-lifecycle default.

For the CLI tunnel path, use `reporelay tunnel setup`, then
`reporelay tunnel doctor`, then `reporelay tunnel run`. Setup downloads a
RepoRelay-supported, SHA-256-verified `tunnel-client` into
`%LOCALAPPDATA%\RepoRelay\tunnel\bin\<version>` and never accepts a runtime
key on argv.

Quickstart records its live local endpoint (`tunnel/local-mcp-url.txt` and the
`localMcpUrl` field in `tunnel/config.json`), so a custom quickstart
`--port` flows through `tunnel setup`, `tunnel doctor`, and `tunnel run`
automatically. `reporelay tunnel setup --port <port>` sets it explicitly.
The endpoint must be a loopback `http://127.0.0.1:<port>/mcp` URL; remote
URLs are rejected.

## Local loopback validation

```powershell
.\ops\Start-RepoRelay.ps1 `
  -WorkspaceRoot "C:\path\to\approved-repository" `
  -BridgeSecretFile "C:\path\outside\reporelay-bridge-secret.txt" `
  -SkipTunnel `
  -Port 7677

.\ops\Test-RepoRelay.ps1 -WorkspaceRoot "C:\path\to\approved-repository"
```

The secret file must contain at least 32 random characters. The scripts verify
loopback ownership, unauthenticated rejection, the exact seven-tool surface,
and that recorded logs do not contain the secret.

## Optional HTTPS tunnel (managed scripts)

The managed Windows scripts use a separately installed external secure MCP
tunnel client (they do not bundle or download one). Configure it to forward
to `127.0.0.1:7676`, inject `X-RepoRelay-Bridge-Secret` for discovery and
runtime requests, and keep its administration listener on loopback. Verify
health, readiness, probe status, and control-plane polling before treating a
tunnel as operational.

```powershell
.\ops\Start-RepoRelay.ps1 `
  -WorkspaceRoot "C:\path\to\approved-repository" `
  -TunnelRoot "C:\path\outside\tunnel-client" `
  -BridgeSecretFile "C:\path\outside\reporelay-bridge-secret.txt" `
  -ControlPlaneApiKeyFile "C:\path\outside\control-plane-key.txt"

.\ops\Protect-RepoRelayTunnel.ps1 `
  -TunnelRoot "C:\path\outside\tunnel-client" `
  -ExposedWorkspace "C:\path\to\approved-repository" `
  -WhatIf
```

Review `-WhatIf` output before applying tunnel credential migration. Never
weaken bridge authentication to compensate for tunnel discovery failures.

## Stop, restart, and diagnostics

```powershell
.\ops\Stop-RepoRelay.ps1
.\ops\Restart-RepoRelay.ps1 `
  -WorkspaceRoot "C:\path\to\another-approved-repository" `
  -BridgeSecretFile "C:\path\outside\reporelay-bridge-secret.txt"
.\ops\Get-RepoRelayDiagnostics.ps1
```

Stop and restart validate recorded process identity, executable, start time,
command line, and listener ownership. They do not enumerate or kill generic
Node processes. Diagnostics print selected sanitized status only.

## Scheduled task

Autostart is never installed implicitly. Preview the exact task first:

```powershell
.\ops\Install-RepoRelayAutostart.ps1 `
  -WorkspaceRoot "C:\path\to\approved-repository" `
  -ControlPlaneApiKeyFile "C:\path\outside\control-plane-key.txt" `
  -WhatIf
```

The default task name is `RepoRelay MCP`. It runs per-user with limited
privileges and stores paths, not credential values. Use
`Manage-RepoRelayAutostart.ps1` to inspect or manage it.

## Operations regression test

```powershell
.\ops\Test-RepoRelayOperations.ps1
```

Fixtures are preserved by default. If a recoverable Recycle Bin helper is
available, pass it through `-RecycleScript` or `REPORELAY_RECYCLE_SCRIPT`.
