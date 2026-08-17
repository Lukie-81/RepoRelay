# ChatGPT Web connection

This walkthrough takes you from a running RepoRelay bridge to a working MCP
app in ChatGPT Web. It uses two PowerShell windows and a browser. Follow the
checkpoints in order; if one fails, fix it before continuing.

Your goal is to make RepoRelay appear as an app that ChatGPT can use.

There are three things to connect:

1. **RepoRelay** — runs on your PC and safely exposes one repository.
2. **Secure MCP Tunnel** — connects your PC to OpenAI.
3. **ChatGPT app** — tells ChatGPT which tunnel to use.

```text
PC                                      OpenAI / ChatGPT

Your repository
      ↑
RepoRelay :7676
      ↑
tunnel-client  ───── Secure MCP Tunnel ─────→  ChatGPT app
```

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

## 1. Start RepoRelay on your PC

If RepoRelay is already showing `Ready.`, this step is finished. Otherwise,
open PowerShell window 1 in the RepoRelay folder and run:

```powershell
node dist/cli.js quickstart "C:\path\to\approved-repository"
```

If you installed RepoRelay globally, use `reporelay quickstart ...` instead.

Leave the PowerShell window open. Look for output like this:

```text
Ready.
Local MCP: http://127.0.0.1:7676/mcp
Health check: http://127.0.0.1:7676/healthz
Bridge secret file: <protected local file path>
```

Before continuing, you should have:

- [ ] RepoRelay says `Ready.`
- [ ] the RepoRelay terminal is still open;
- [ ] the local MCP URL;
- [ ] the **bridge-secret file path**, not the secret value.

Open the printed health-check URL in a browser on the same PC. It should print:

```json
{"ok":true,"name":"reporelay"}
```

The bridge secret must stay in protected local storage. It must not be copied
into ChatGPT, Git, a handoff file, or a tunnel profile as inline text. On POSIX
systems quickstart uses owner-only permissions; on Windows it removes inherited
broad read access and grants access only to the current user and `SYSTEM`.

**Checkpoint 1:** RepoRelay is still running, the health check returns the
expected JSON, and you have the printed local MCP URL plus secret-file path.

## 2. Understand the four values

These values have different owners and different jobs:

| Thing | Comes from | Used for |
| --- | --- | --- |
| `tunnel_id` | OpenAI Secure MCP Tunnel | Identifies which OpenAI tunnel ChatGPT should use |
| OpenAI runtime API credential | OpenAI | Authenticates `tunnel-client` to OpenAI |
| RepoRelay bridge-secret file | RepoRelay quickstart | Authenticates `tunnel-client` to RepoRelay locally |
| Local MCP URL | RepoRelay quickstart | Tells `tunnel-client` where RepoRelay is running |

The OpenAI tunnel credential and the RepoRelay bridge secret are **not the same
thing**:

```text
OpenAI runtime credential
        ↓
authenticates tunnel-client → OpenAI

RepoRelay bridge secret
        ↓
authenticates tunnel-client → RepoRelay
```

You use the two file paths in the local `tunnel-client` command. You never
paste either secret into ChatGPT.

## 3. Create and associate an OpenAI tunnel

Now you are leaving RepoRelay temporarily and setting up the OpenAI side.
In the browser, open OpenAI's [Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
and open **Platform tunnel settings**.

1. Create or select a tunnel.
2. Associate it with the ChatGPT workspace where you will create the app. A
   tunnel associated only with a Platform organization may not appear in
   ChatGPT.
3. Create or obtain a runtime API key for `tunnel-client` and save it in a
   protected file outside every repository.
4. Copy the tunnel's `tunnel_id`.

You need Platform tunnel-management permission to create or edit a tunnel, and
tunnel-use permission to run or select it. ChatGPT Developer Mode is a
separate workspace permission. If either option is missing, ask the relevant
Platform organization owner or ChatGPT workspace administrator.

**Checkpoint 2:** you have the `tunnel_id`, the path to a protected runtime
API-key file, and access to the target ChatGPT workspace.

## 4. Run tunnel-client on your PC

Open PowerShell window 2. Download the current `tunnel-client` from the OpenAI
guide or the [official releases](https://github.com/openai/tunnel-client/releases/latest).
The commands below assume `tunnel-client` is on your PATH. If Windows says it
is not recognized, replace `tunnel-client` with the full path to
`tunnel-client.exe`.

Replace the four placeholder values in this block. The runtime API key and
bridge secret remain in files; they are never pasted into these commands:

You only need to replace the four values at the top. Leave the doctor and run commands themselves unchanged.

```powershell
$TunnelId = "tunnel_replace_with_your_tunnel_id"
$McpUrl = "http://127.0.0.1:7676/mcp"
$BridgeSecretFile = "C:\Users\YOUR_NAME\AppData\Local\RepoRelay\reporelay-bridge-secret.txt"
$RuntimeApiKeyFile = "C:\Users\YOUR_NAME\Documents\RepoRelay\openai-control-plane-api-key.txt"
$BridgeHeader = "X-RepoRelay-Bridge-Secret: file:$BridgeSecretFile"
```

Run a local preflight first:

```powershell
tunnel-client doctor `
  --control-plane.tunnel-id $TunnelId `
  --control-plane.api-key "file:$RuntimeApiKeyFile" `
  --mcp.server-url $McpUrl `
  --mcp.extra-headers $BridgeHeader `
  --mcp.discovery-extra-headers $BridgeHeader `
  --explain
```

The preflight must pass. It checks that the client can authenticate to the
OpenAI control plane and reach RepoRelay locally. The two MCP header options
are both required: one covers normal MCP requests and the other covers
discovery and startup probes.

Then start the client and leave this PowerShell window open:

```powershell
tunnel-client run `
  --control-plane.tunnel-id $TunnelId `
  --control-plane.api-key "file:$RuntimeApiKeyFile" `
  --mcp.server-url $McpUrl `
  --mcp.extra-headers $BridgeHeader `
  --mcp.discovery-extra-headers $BridgeHeader
```

The `file:` prefix tells `tunnel-client` to read the value locally. Do not
replace it with the actual API key or bridge secret. If the client provides a
local health/readiness URL, confirm that it reports healthy, ready, and
polling.

**Checkpoint 3:** RepoRelay is running in window 1, `tunnel-client doctor`
passed, and `tunnel-client run` is still running in window 2.

At this point the network path exists, but ChatGPT still does not know about
RepoRelay. The next step creates the ChatGPT app.

### Advanced: managed Windows lifecycle

Skip this section if you are following the direct commands above. For a managed
Windows setup, the existing scripts can validate the same local and
tunnel-client arrangement after the client/profile is installed:

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

## 5. In ChatGPT Web — create the RepoRelay app

Open ChatGPT Web in the browser. The current OpenAI instructions are in
[Developer mode and MCP apps in ChatGPT](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt).

1. Open **Apps** and choose **Create**. Depending on your plan, this may be
   under **Workspace Settings → Apps → Create** or **Settings → Apps → Create**.
2. Enable Developer Mode, or ask the workspace administrator to grant access.
   If **Create** is missing, stop here and resolve the workspace permission.
3. Choose a custom MCP app and select **Tunnel** under **Connection**.
4. Select the tunnel you created, or paste its `tunnel_id`.
5. If ChatGPT asks for an endpoint, do not enter `127.0.0.1` or `localhost`.
   The tunnel selection supplies the remote endpoint.
6. Do not paste the RepoRelay bridge secret into ChatGPT. The local
   `tunnel-client` supplies that header to RepoRelay.
7. Click **Scan Tools** and wait for the scan to finish.
8. Review the returned tools and click **Create**. If the app appears under
   **Drafts**, publish or enable it as required by the workspace.
9. Start a new chat, open the tools menu, and select the RepoRelay app.

Default Quickstart: 7 tools. Read-only mode (`--no-handoff-writes`): 4 tools.

**Default Quickstart: 7 tools**

```text
open_workspace
list_files
read_file
search_files
write_next_task
write_review
update_handoff_state
```

**Read-only mode (`--no-handoff-writes`): 4 tools**

```text
open_workspace
list_files
read_file
search_files
```

**Checkpoint 4:** Scan Tools lists exactly the expected tools — nothing more,
nothing fewer.

## 6. RepoRelay is connected

Success means all five of these are true:

- [ ] RepoRelay is running locally;
- [ ] `tunnel-client` is healthy and still running;
- [ ] the ChatGPT app exists;
- [ ] **Scan Tools** showed the expected RepoRelay tools;
- [ ] RepoRelay can be selected in a new ChatGPT conversation.

In that new chat, ask:

```text
Open the approved repository, list the top-level files, and read README.md.
```

Then test the boundary:

```text
Try to read .env.
```

The first request should work. The second request must be blocked. Also stop
if Scan Tools shows shell, Git, process execution, arbitrary file editing,
delete, or any other unexpected capability.

## Can't see RepoRelay in ChatGPT?

Check the connection in this order:

1. **Does RepoRelay still say `Ready.`?** If not, restart RepoRelay.
2. **Is `tunnel-client` running and healthy?** If not, rerun the full doctor
   command from Step 4 and restart it.
3. **Is the ChatGPT app using the correct tunnel or `tunnel_id`?** If not,
   correct the app connection.
4. **Did Scan Tools return the expected RepoRelay tools?** If not, check the
   local MCP URL and both RepoRelay authentication header options.
5. **Did scanning succeed but the app is not in the chat?** Start a new chat
   and select or enable the app using the current ChatGPT workspace flow.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Developer Mode or **Apps → Create** is missing | Ask the ChatGPT workspace administrator for developer-mode access. |
| The tunnel is not listed in ChatGPT | Associate the tunnel with the target ChatGPT workspace and confirm tunnel-use permission. |
| `tunnel-client` says the API key or tunnel ID is missing | Check the protected key file path and `$TunnelId`; do not put the secret directly in the command. |
| `tunnel-client doctor` cannot reach MCP | Confirm RepoRelay is still running and `$McpUrl` is exactly the Local MCP URL printed by quickstart. |
| Scan Tools fails or returns no tools | Keep both PowerShell windows open, rerun the full `tunnel-client doctor` command from Step 4, then try the scan again. |
| Scan Tools shows unexpected tools | Stop. Run `reporelay audit <repository> --json` and investigate before creating or refreshing the app. |

RepoRelay intentionally has no `connect chatgpt` command. The tunnel client,
control-plane key, and ChatGPT workspace permissions belong to the operator;
the steps above connect them without moving those secrets into RepoRelay or
ChatGPT.

## Next time

You do **not** recreate the tunnel or ChatGPT app every time. Normally:

1. Start RepoRelay.
2. Confirm `tunnel-client` is running.
3. Open a new ChatGPT chat.
4. Select the RepoRelay app.
5. Start working.

RepoRelay documents which values go where and what success looks like. OpenAI's
[Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
owns current tunnel commands and credentials. OpenAI's [Developer mode and MCP
apps guide](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt)
owns current ChatGPT UI and workspace permissions.
