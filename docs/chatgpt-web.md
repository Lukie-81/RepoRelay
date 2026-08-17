# ChatGPT Web connection

ChatGPT Web does not call a private developer machine's `localhost` directly.
ChatGPT connects to a remote MCP endpoint. For a RepoRelay bridge that must
remain local, the supported shape is:

```text
ChatGPT Web
    ↓
OpenAI Secure MCP Tunnel
    ↓
local tunnel client
    ↓
http://127.0.0.1:<port>/mcp
    ↓
RepoRelay
    ↓
one approved repository
```

## Local side

1. Build and start RepoRelay:

   ```powershell
   npm ci
   npm run build
   node dist/cli.js quickstart "C:\path\to\approved-repository"
   ```

   When installed as a package, use `npx reporelay quickstart ...` instead.

2. Keep the printed local MCP URL and the protected bridge-secret file path.
   The secret value must stay in protected local storage. RepoRelay never
   prints it and it must not be copied into ChatGPT, Git, a handoff file, or a
   tunnel profile as inline text.

3. Configure the Secure MCP Tunnel to forward to that local MCP URL and inject
   `X-RepoRelay-Bridge-Secret` for discovery and runtime requests. The tunnel
   client and its control-plane credentials are external operator-managed
   dependencies; RepoRelay does not download or store them.

On Windows, the existing lifecycle scripts validate the local side and the
current tunnel-client layout:

```powershell
.\ops\Start-RepoRelay.ps1 `
  -WorkspaceRoot "C:\path\to\approved-repository" `
  -TunnelRoot "C:\path\outside\tunnel-client" `
  -BridgeSecretFile "C:\path\outside\reporelay-bridge-secret.txt" `
  -ControlPlaneApiKeyFile "C:\path\outside\control-plane-key.txt"

.\ops\Test-RepoRelay.ps1 -WorkspaceRoot "C:\path\to\approved-repository"
```

The scripts require the tunnel client/profile to already be installed and
configured outside the repository. They verify the profile's two bridge-secret
references, run `doctor --explain`, keep the tunnel administration listener on
loopback, and check health, readiness, probe status, and control-plane polling.
Use `-SkipTunnel` when validating only the local bridge on an isolated port.

## ChatGPT Web side

The exact labels depend on the ChatGPT plan and workspace settings. The current
OpenAI instructions are in [Developer mode and MCP apps in ChatGPT](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt).

1. Enable developer mode or obtain the workspace permission required to create
   a custom MCP app.
2. Create a custom MCP app and enter the HTTPS endpoint supplied by the Secure
   MCP Tunnel. Do not enter `127.0.0.1` as a ChatGPT-hosted endpoint.
3. Select **Scan Tools** and review the discovered surface before creating or
   enabling the app. RepoRelay's expected surface is exactly four tools by
   default, or seven when fixed handoff writes are explicitly enabled:
   `open_workspace`, `list_files`, `read_file`, `search_files`, and optionally
   `write_next_task`, `write_review`, `update_handoff_state`.
4. Start a new chat, select the enabled app, and test `open_workspace`, list,
   read, and literal search operations.
5. Confirm that `.env`, `.git`, outside-root paths, redirecting links, and
   arbitrary write requests are rejected. If the tool list changes, stop and
   re-run `reporelay audit <repository> --json` before refreshing the app.

RepoRelay intentionally has no `connect chatgpt` command. The tunnel client,
control-plane key, and ChatGPT workspace credentials belong to the operator;
automating their ownership would make the security boundary less clear.
