# ChatGPT Web connection

RepoRelay connects ChatGPT Web to one approved local repository through an
authenticated loopback bridge and the OpenAI Secure MCP Tunnel. The local
workflow is:

```text
ChatGPT Web -> Secure MCP Tunnel -> tunnel-client -> RepoRelay -> repository
```

OpenAI owns the tunnel service, runtime-key permissions, and ChatGPT app UI.
Use the current [Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
and [ChatGPT Developer Mode and MCP apps guide](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt)
when Platform or ChatGPT labels change.

## Before you start

You need:

- RepoRelay installed and a repository selected;
- an OpenAI Secure MCP Tunnel and its `tunnel_id`;
- an OpenAI runtime API key for `tunnel-client`;
- the official `tunnel-client` executable downloaded locally; and
- permission to create or use a custom MCP app in the target ChatGPT workspace.

RepoRelay does not use the runtime API key for local MCP work. RepoRelay also
does not download or install `tunnel-client`. It is OpenAI's separate local
transport binary: it carries the Secure MCP Tunnel traffic to the RepoRelay
bridge, while RepoRelay remains the local MCP server and security boundary.
Download the current official release from
https://github.com/openai/tunnel-client/releases/latest, choose the build for
your operating system, and extract it before setup.

## 1. Start RepoRelay

Use the default quickstart port so setup can configure the local MCP URL without
extra values:

```powershell
reporelay quickstart "C:/Projects/my-app"
```

Keep this terminal open. A read-only bridge uses:

```powershell
reporelay quickstart "C:/Projects/my-app" --no-handoff-writes
```

The default quickstart has seven tools. Read-only mode has exactly four:

```text
open_workspace
list_files
read_file
search_files
```

## 2. Run one-time tunnel setup

First create the runtime API key in OpenAI Platform:

1. Open https://platform.openai.com/settings/organization/api-keys.
2. Click **Create new secret key**.
3. Choose the project you want to use with RepoRelay.
4. Create the key and copy it when OpenAI shows it. You provide it to setup
   below; RepoRelay stores it in a protected file.

Separately, your OpenAI Platform account needs the **Tunnels Read + Use**
organization permission to run or select the tunnel. That is an
organization-level permission your org owner or RBAC admin grants, not a
setting on the API key itself. Creating or editing a tunnel needs **Tunnels
Read + Manage**; **Tunnels Read + Use** is enough to run `tunnel-client` and
select the tunnel. Do not use an Admin API key, and never paste any key into
ChatGPT.

Put the extracted `tunnel-client` executable on PATH, or keep its full path
ready. RepoRelay does not download it for you. In a second PowerShell window,
run:

```powershell
reporelay tunnel setup
```

On a cold start, setup first explains the OpenAI `tunnel-client` step and asks
for its path only when it is not already on PATH or stored in valid RepoRelay
configuration. Then it prompts for the tunnel ID and the runtime API key. The
key prompt does not echo input. The key is never accepted as an argument,
environment value, generated config value, or user-facing bridge-header
variable.

Setup preserves an existing bridge secret and runtime-key file. It writes this
per-user layout under `%LOCALAPPDATA%\RepoRelay`:

```text
reporelay-bridge-secret.txt
tunnel\config.json
tunnel\profiles\reporelay.yaml
tunnel\secrets\openai-runtime-api-key.txt
```

`config.json` contains only the schema version, tunnel ID, profile name, and the
resolved tunnel-client path selected during setup. The generated profile uses
the official named-profile schema and file references for both credentials:

```yaml
config_version: 1
control_plane:
  tunnel_id: tunnel_0123456789abcdef0123456789abcdef
  api_key: 'file:<protected-runtime-key-file>'
mcp:
  server_urls:
    - channel: main
      url: 'http://127.0.0.1:7676/mcp'
  extra_headers:
    X-RepoRelay-Bridge-Secret: 'file:<protected-bridge-secret-file>'
  discovery_extra_headers:
    X-RepoRelay-Bridge-Secret: 'file:<protected-bridge-secret-file>'
```

Do not replace the `file:` references with literal secrets. Do not copy the
runtime key or bridge secret into ChatGPT, Git, logs, or handoff files.

## 3. Check the configuration and connection

Run:

```powershell
reporelay tunnel doctor
```

The RepoRelay wrapper runs the equivalent of:

```text
tunnel-client doctor --profile reporelay --profile-dir <RepoRelay tunnel profiles> --explain
```

A successful check ends with:

```text
RepoRelay tunnel doctor
[ok] tunnel-client found
[ok] tunnel-client profile configured
[ok] Tunnel configuration valid
[ok] OpenAI runtime credential accepted
[ok] RepoRelay reachable
[ok] Bridge authentication working
Ready.
Next:
  reporelay tunnel run
```

Failures are intentionally concise. Use `reporelay tunnel doctor --verbose` for
redacted diagnostics, then correct the indicated layer:

| Failure | Check |
| --- | --- |
| `tunnel-client` missing | Download the official client, put it on PATH or rerun setup with its executable path. |
| Profile or credential file missing | Rerun `reporelay tunnel setup`; it preserves existing credentials. |
| Runtime credential rejected | Confirm the Platform runtime API key and tunnel ID; do not use an admin key for the daemon. |
| MCP unreachable | Keep the RepoRelay quickstart terminal running on `127.0.0.1:7676`. |
| Bridge authentication failed | Confirm the canonical RepoRelay bridge-secret file is present and rerun setup. |

## 4. Run the tunnel

After doctor passes, start the foreground client:

```powershell
reporelay tunnel run
```

The wrapper runs the configured `reporelay` profile and leaves `tunnel-client`
in the foreground. Keep both the RepoRelay and tunnel terminals open. Stop the
tunnel with Ctrl+C.

## 5. Create or use the ChatGPT app

In ChatGPT Web, use the current OpenAI app flow:

1. Open **Apps** and choose **Create**, if your workspace exposes that action.
2. Enable Developer Mode or ask the workspace administrator for access.
3. Create a custom MCP app and choose the tunnel connection.
4. Select the tunnel associated with the target ChatGPT workspace.
5. Do not enter `127.0.0.1`, `localhost`, or either credential.
6. Run **Scan Tools**, review the returned tools, and create the app.
7. In a new chat, select the RepoRelay app.

Expected tools are the four read-only tools above, plus the three fixed handoff
writers when quickstart handoff writes are enabled. Stop if Scan Tools shows
shell, Git, process execution, arbitrary file editing, delete, or another
unexpected capability.

## Security notes

- RepoRelay remains loopback-only and continues to enforce one canonical
  repository root and sensitive-path/link/containment checks.
- The bridge secret stays in the protected per-user RepoRelay configuration
  directory. The tunnel profile reads it through a `file:` reference.
- The runtime API key stays in its protected file and is not put on argv.
- Setup and run do not download software, publish a tunnel, create a ChatGPT
  app, or change external permissions.
- The bridge exposes only its approved review tools; the tunnel is a transport
  layer, not a shell or arbitrary mutation channel.

## Existing Windows operations

The managed Windows scripts in [OPERATIONS.md](../OPERATIONS.md) remain available
for operators who already maintain a separate tunnel-client installation. They
are not required for the CLI setup path.

## Official references

- [OpenAI Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [tunnel-client configuration reference](https://github.com/openai/tunnel-client/blob/master/docs/configuration.md)
- [official tunnel-client releases](https://github.com/openai/tunnel-client/releases/latest)
- [ChatGPT Developer Mode and MCP apps](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt)
