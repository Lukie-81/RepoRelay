# ChatGPT Web connection

RepoRelay connects ChatGPT Web to one approved local repository through an
authenticated loopback bridge and the OpenAI Secure MCP Tunnel. The local
workflow is:

```text
ChatGPT Web -> Secure MCP Tunnel -> tunnel-client -> RepoRelay -> repository
```

OpenAI owns the tunnel service, runtime-key permissions, and ChatGPT app UI.
Use the current [Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
and [ChatGPT Developer Mode and MCP apps guide](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt)
when Platform or ChatGPT labels change.

## Before you start

You need:

- RepoRelay installed and a repository selected;
- an OpenAI Secure MCP Tunnel and its `tunnel_id`;
- an OpenAI runtime API key for `tunnel-client`; and
- permission to create or use a custom MCP app in the target ChatGPT workspace.

You do **not** need to download or locate `tunnel-client` yourself. `reporelay
tunnel setup` downloads a RepoRelay-supported, SHA-256-verified `tunnel-client`
into RepoRelay's per-user configuration directory and uses it for doctor and
run automatically. RepoRelay does not use the runtime API key for local MCP
work; that key only authenticates `tunnel-client` to OpenAI. RepoRelay remains
the local MCP server and security boundary.

## 1. Start RepoRelay

The default quickstart port is 7676:

```powershell
reporelay quickstart "C:/Projects/my-app"
```

Keep this terminal open. The normal quickstart has **seven tools**. If you
chose the optional inspection-only mode instead, add `--no-handoff-writes`;
that mode has exactly four tools:

```text
open_workspace
list_files
read_file
search_files
```

If you run RepoRelay on a custom port (`--port 7677`), the managed tunnel
configuration follows it automatically &mdash; quickstart records the live local
endpoint, and `tunnel setup`/`doctor`/`run` all use it.

## 2. Create the OpenAI Secure MCP Tunnel

You need a tunnel and its `tunnel_id` before setup:

1. Open Platform → settings → Secure MCP Tunnels:
   https://platform.openai.com/settings/organization/tunnels
2. **Create a new tunnel**, or select an existing one.
3. **Associate the tunnel** with the ChatGPT workspace (and Platform
   organization) that should be able to use it. A tunnel associated only with
   a Platform organization will not appear in a ChatGPT workspace.
4. Copy the **`tunnel_id`** (it looks like `tunnel_` followed by 32 hex
   characters).

Creating or editing a tunnel needs **Tunnels Read + Manage**; running
`tunnel-client` or selecting the tunnel needs **Tunnels Read + Use**. These
are organization-level permissions granted by your org owner or RBAC admin.
Use the current
[Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
as the source of truth for the exact UI and permission wording.

## 3. Run one-time tunnel setup

Create a runtime API key in OpenAI Platform:

1. Open https://platform.openai.com/settings/organization/api-keys.
2. Click **Create new secret key**.
3. Choose the project you want to use with RepoRelay.
4. Create the key and copy it when OpenAI shows it. You provide it to setup
   below; RepoRelay stores it in a protected file.

Do not use an Admin API key, and never paste any key into ChatGPT.

In a second PowerShell window, run:

```powershell
reporelay tunnel setup
```

Setup automatically detects your OS and CPU, downloads the pinned
RepoRelay-supported `tunnel-client` release, verifies its SHA-256 checksum
before running anything, and stores it under `%LOCALAPPDATA%\RepoRelay`. On a
repeat run it reuses the already-verified installation instead of
redownloading.

If your RepoRelay runs on a custom port, either rely on the automatically
discovered live endpoint or set it explicitly:

```powershell
reporelay tunnel setup --port 7677
```

Setup first prepares the verified `tunnel-client`, then opens the OpenAI
Platform tunnel page so you can create or select a tunnel, and prompts for the
tunnel ID. Next it opens the runtime API-key page and prompts for the key. The
key prompt does not echo input — nothing appears while you paste. The key is
never accepted as an argument, environment value, generated config value, or
user-facing bridge-header variable. Add `--no-open` on headless or SSH systems
so RepoRelay prints the page URLs instead of launching a browser.

Setup preserves an existing bridge secret and runtime-key file. It writes this
per-user layout under `%LOCALAPPDATA%\RepoRelay`:

```text
reporelay-bridge-secret.txt
tunnel\bin\v0.0.11\tunnel-client.exe   (verified, RepoRelay-managed)
tunnel\config.json
tunnel\local-mcp-url.txt
tunnel\profiles\reporelay.yaml
tunnel\secrets\openai-runtime-api-key.txt
```

`config.json` contains the schema version, tunnel ID, profile name, the
resolved tunnel-client path, and the local MCP endpoint (`localMcpUrl`).
Quickstart keeps that endpoint in sync with the actual running RepoRelay port,
so a custom `--port` flows through `tunnel setup`, `tunnel doctor`, and
`tunnel run` without manual YAML editing. The generated profile uses the
official named-profile schema and file references for both credentials:

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

## 4. Check the configuration and connection

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
[ok] Local MCP endpoint: http://127.0.0.1:7676/mcp
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
| `tunnel-client` missing | Rerun `reporelay tunnel setup`; it re-downloads and verifies the managed client. |
| Profile or credential file missing | Rerun `reporelay tunnel setup`; it preserves existing credentials. |
| Runtime credential rejected | Confirm the Platform runtime API key and tunnel ID; do not use an admin key for the daemon. |
| MCP unreachable | Keep the RepoRelay quickstart terminal running on the configured local endpoint (default `127.0.0.1:7676`), then rerun the doctor. |
| Bridge authentication failed | Confirm the canonical RepoRelay bridge-secret file is present and rerun setup. |

## 5. Run the tunnel

After doctor passes, start the foreground client:

```powershell
reporelay tunnel run
```

The wrapper runs the configured `reporelay` profile and leaves `tunnel-client`
in the foreground. Keep both the RepoRelay and tunnel terminals open. Stop the
tunnel with Ctrl+C.

## 6. Create or use the ChatGPT app

In ChatGPT, use the current OpenAI app flow (see the
[developer-mode and MCP apps guide](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt)):

```text
ChatGPT
→ Apps / developer features
→ create custom MCP app
→ connection: Tunnel
→ choose RepoRelay's tunnel
→ authentication: No authentication
→ Scan Tools
→ verify 7 tools
→ create/use the app
→ start a new chat
```

1. Enable Developer Mode, or ask the workspace administrator for access.
2. Create a custom MCP app and choose the **Tunnel** connection.
3. Select the tunnel associated with the target ChatGPT workspace.
4. When ChatGPT asks for authentication, select **No authentication**.
5. Save or create the app. Do not enter `127.0.0.1`, `localhost`, or either
   credential.
6. Run **Scan Tools**, review the returned tools, and verify the expected
   RepoRelay tools appear.
7. In a new chat, select the RepoRelay app.

> **Authentication: No authentication.** RepoRelay already authenticates the
> local bridge through the protected `X-RepoRelay-Bridge-Secret` used by the
> tunnel. Do not configure OAuth or another ChatGPT-side authentication method.

The normal quickstart exposes exactly seven tools (the four read-only tools
above, plus `write_next_task`, `write_review`, and `update_handoff_state`).
Read-only mode exposes exactly four. Stop if Scan Tools shows shell, Git,
process execution, arbitrary file editing, delete, or another unexpected
capability.

## Security notes

- RepoRelay remains loopback-only and continues to enforce one canonical
  repository root and sensitive-path/link/containment checks.
- The bridge secret stays in the protected per-user RepoRelay configuration
  directory. The tunnel profile reads it through a `file:` reference.
- The runtime API key stays in its protected file and is not put on argv.
- Setup downloads only the pinned, SHA-256-verified `tunnel-client` from the
  official OpenAI release and never executes an unverified binary. It does not
  publish a tunnel, create a ChatGPT app, or change external permissions.
- The bridge exposes only its approved review tools; the tunnel is a transport
  layer, not a shell or arbitrary mutation channel.

## Existing Windows operations

The managed Windows scripts in [OPERATIONS.md](../OPERATIONS.md) remain available
for operators who already maintain a separate `tunnel-client` installation.
They are not required for the CLI setup path, which manages its own verified
client.

## Official references

- [OpenAI Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [tunnel-client configuration reference](https://github.com/openai/tunnel-client/blob/master/docs/configuration.md)
- [official tunnel-client releases](https://github.com/openai/tunnel-client/releases/latest)
- [ChatGPT Developer Mode and MCP apps](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt)
