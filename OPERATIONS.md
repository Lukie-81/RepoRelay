# RepoRelay operations

These Windows PowerShell scripts manage the hardened `chatgpt-review` bridge.
They derive the source checkout from their own location and do not require a
machine-specific installation path.

## Before starting

From the repository root:

```powershell
npm ci
npm run verify:release
```

The approved repository must be an existing canonical directory narrower than
the Windows user profile. It must contain these regular files:

```text
.ai-handoff/NEXT_TASK.md
.ai-handoff/REVIEW.md
.ai-handoff/STATE.json
.ai-handoff/LUNA_RESULT.md
```

Preview or apply the handoff layout with
`Initialize-DevSpaceChatGPTHandoff.ps1` as documented in `README.md`.

Keep the bridge secret, tunnel control-plane key, tunnel binary, and tunnel
profile outside every repository. The default protected runtime location is
`%LOCALAPPDATA%\DevSpaceChatGPT`.

## Local validation

Start without a tunnel on an isolated port:

```powershell
.\ops\Start-DevSpaceChatGPT.ps1 `
  -WorkspaceRoot "C:\path\to\approved-repository" `
  -BridgeSecretFile "C:\path\outside-repositories\bridge-secret.txt" `
  -SkipTunnel `
  -Port 7677
```

The bridge-secret file must contain at least 32 random characters. The script
does not print the value.

Validate the recorded process and security surface:

```powershell
.\ops\Test-DevSpaceChatGPT.ps1 `
  -WorkspaceRoot "C:\path\to\approved-repository"
```

## Tunnel-backed start

The OpenAI Secure MCP Tunnel client is not bundled. Follow OpenAI's current
secure-tunnel documentation, then supply its external paths:

```powershell
.\ops\Start-DevSpaceChatGPT.ps1 `
  -WorkspaceRoot "C:\path\to\approved-repository" `
  -TunnelRoot "C:\path\outside-repositories\tunnel-client" `
  -BridgeSecretFile "C:\path\outside-repositories\bridge-secret.txt" `
  -ControlPlaneApiKeyFile "C:\path\outside-repositories\control-plane-key.txt"
```

The tunnel profile must forward to `127.0.0.1:7676`, inject the same bridge
secret for discovery and runtime requests, and keep its administration
listener on loopback. The scripts require both shallow health and successful
control-plane polling; `/readyz` alone is not acceptance evidence.

`Protect-DevSpaceChatGPTTunnel.ps1` can migrate an older inline key into a
protected file. It requires the exposed workspace explicitly:

```powershell
.\ops\Protect-DevSpaceChatGPTTunnel.ps1 `
  -TunnelRoot "C:\path\outside-repositories\tunnel-client" `
  -ExposedWorkspace "C:\path\to\approved-repository" `
  -WhatIf
```

Review `-WhatIf` output before allowing changes.

## Stop and restart

```powershell
.\ops\Stop-DevSpaceChatGPT.ps1
```

Stop validates the recorded PID, executable, start time, command line, and
listener ownership. It does not enumerate and kill generic Node processes.

```powershell
.\ops\Restart-DevSpaceChatGPT.ps1 `
  -WorkspaceRoot "C:\path\to\another-approved-repository" `
  -BridgeSecretFile "C:\path\outside-repositories\bridge-secret.txt"
```

Restart validates the replacement before stopping the current bridge and
attempts to restore the prior healthy workspace if replacement fails.

## Diagnostics

```powershell
.\ops\Get-DevSpaceChatGPTDiagnostics.ps1
.\ops\Test-DevSpaceChatGPT.ps1
```

Diagnostics print selected status fields and sanitized events only. They do
not print raw headers, request bodies, bridge secrets, control-plane keys, or
full tunnel profiles.

If the connector lists cached tools but cannot open a workspace, verify:

1. the local bridge process and loopback listener;
2. unauthenticated rejection and authenticated tool enumeration;
3. tunnel probe status;
4. control-plane authentication and polling;
5. whether a new local MCP event reached the machine.

Do not weaken bridge authentication to compensate for a tunnel failure.

## Runtime records

Non-secret PID, process identity, workspace, log path, and health metadata are
stored under `%LOCALAPPDATA%\DevSpaceChatGPT` by default. Every start uses a
distinct run directory. Credential values are not stored in runtime metadata.

## Optional logon task

Autostart is never installed implicitly. Preview the exact task first:

```powershell
.\ops\Install-DevSpaceChatGPTAutostart.ps1 `
  -WorkspaceRoot "C:\path\to\approved-repository" `
  -ControlPlaneApiKeyFile "C:\path\outside-repositories\control-plane-key.txt" `
  -WhatIf
```

The task runs per-user with limited privileges and stores only path references,
not credential values, in its configuration.

## Operations regression tests

```powershell
.\ops\Test-DevSpaceChatGPTOperations.ps1
```

Fixtures are preserved by default. If your environment provides a recoverable
Recycle Bin helper, pass it through `-RecycleScript` or set
`CHATGPT_CODEX_MCP_RECYCLE_SCRIPT`.
