# ChatGPT Web connection

ChatGPT Web does not call a private developer machine's `localhost` directly.
ChatGPT uses the OpenAI-hosted Secure MCP Tunnel endpoint, while the local
tunnel client forwards requests to RepoRelay:

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

   When installed as a package, use `npx reporelay-mcp@latest quickstart ...`
   instead.

2. Keep the printed local MCP URL and the protected bridge-secret file path.
   The quickstart summary also prints a health-check URL (for example
   `http://127.0.0.1:7676/healthz`); opening it in a browser on the same PC
   should print `{"ok":true,"name":"reporelay"}`. Use it to confirm the bridge
   is still running while you wire up the tunnel.
   The secret value must stay in protected local storage. RepoRelay never
   prints it and it must not be copied into ChatGPT, Git, a handoff file, or a
   tunnel profile as inline text. On POSIX systems the quickstart file uses
   restrictive owner-only mode; on Windows the quickstart applies a file ACL
   that removes inherited broad read access and grants read access only to the
   current user and `SYSTEM`.

3. In OpenAI Platform tunnel settings, create or select a tunnel and record its
   `tunnel_id`. Configure the current `tunnel-client` to use that identity, its
   protected runtime API key, and the local RepoRelay MCP URL. Configure the
   local client/profile to send `X-RepoRelay-Bridge-Secret` from protected
   file-backed storage for discovery and runtime requests. The tunnel client
   and its control-plane credentials are external operator-managed
   dependencies; RepoRelay does not download or store them.

See OpenAI's [Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
for the current tunnel-client setup, permissions, and release guidance. Keep
the runbook pointed at OpenAI's current documentation rather than a pinned
client version or guessed UI labels.

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

The exact labels and permissions depend on the ChatGPT plan and workspace. The
current OpenAI instructions are in [Developer mode and MCP apps in ChatGPT](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt).

1. Enable developer mode or obtain the workspace permission required to create
   a custom MCP app.
2. Create a developer-mode app, choose **Tunnel** under **Connection**, and
   select an available tunnel or paste the valid `tunnel_id`. Do not enter
   `127.0.0.1` or `localhost` as a ChatGPT-hosted endpoint. If the current app
   flow asks for metadata, authentication, or **Scan Tools**, complete those
   steps and review the discovered surface before creating or enabling the app.
   RepoRelay's expected surface is exactly four tools by default, or seven when
   fixed handoff writes are explicitly enabled:
   `open_workspace`, `list_files`, `read_file`, `search_files`, and optionally
   `write_next_task`, `write_review`, `update_handoff_state`.
3. Start a new chat, select the enabled app, and test `open_workspace`, list,
   read, and literal search operations.
4. Confirm that `.env`, `.git`, outside-root paths, redirecting links, and
   arbitrary write requests are rejected. If the tool list changes, stop and
   re-run `reporelay audit <repository> --json` before refreshing the app.

RepoRelay intentionally has no `connect chatgpt` command. The tunnel client,
control-plane key, and ChatGPT workspace credentials belong to the operator;
automating their ownership would make the security boundary less clear.
