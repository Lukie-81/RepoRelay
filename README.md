<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/reporelay-logo-dark.png">
    <img src="docs/assets/reporelay-logo.png" width="440" alt="RepoRelay">
  </picture>
</p>

<p align="center"><b>Give AI access to your repository &mdash; not your machine.</b></p>

<p align="center">RepoRelay lets ChatGPT safely inspect one local repository
without giving it control of the rest of your computer.</p>

<p align="center">
  <a href="https://github.com/Lukie-81/RepoRelay/actions/workflows/ci.yml"><img src="https://github.com/Lukie-81/RepoRelay/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license"></a>
  <a href="#requirements-and-platform-support"><img src="https://img.shields.io/badge/node-%3E%3D22.19%20%3C27-green.svg" alt="Node.js >=22.19 <27"></a>
  <img src="https://img.shields.io/badge/protocol-MCP-6e5494.svg" alt="Model Context Protocol">
</p>

<p align="center">
  <img src="docs/assets/reporelay-hero.png" width="720" alt="RepoRelay architecture: an authenticated AI reviewer reaches the loopback bridge, which exposes bounded read and search access to one approved repository and optional fixed handoff writers for a separate implementer.">
</p>

<p align="center"><b>ChatGPT Web &rarr; Secure MCP Tunnel &rarr; tunnel-client &rarr; RepoRelay &rarr; one approved repository</b></p>

<p align="center"><b>Read safe files &middot; Search code &middot; One approved repository &middot; No shell &middot; No Git &middot; No arbitrary writes</b></p>

<p align="center">
  <a href="#start-here">Quick Start</a> &middot;
  <a href="#connect-chatgpt-web">Connect ChatGPT Web</a> &middot;
  <a href="#switch-repositories">Switch Repositories</a> &middot;
  <a href="#security-summary">Security</a>
</p>

## Start here

Follow these steps in order:

1. Install the one-time prerequisites on your PC.
2. Install RepoRelay.
3. Start RepoRelay for one repository.
4. Create an OpenAI Secure MCP Tunnel.
5. Run `tunnel-client` on your computer.
6. Add the tunnel to ChatGPT Web.
7. Scan the RepoRelay tools.
8. Start a new ChatGPT chat.
9. Ask ChatGPT to inspect the approved repository.

## First-time setup

The detailed first-time path below is normally done once:

- install RepoRelay once (from npm, a ZIP download, or a Git clone);
- install and configure `tunnel-client` with protected local credentials;
- create or select an OpenAI Secure MCP Tunnel;
- create the ChatGPT developer-mode MCP app.

The app and tunnel setup are controlled by OpenAI and your ChatGPT workspace.
Their labels and permissions can change, so use the linked official guides for
those steps.

### On your PC

#### 1. Install the one-time prerequisites

Every command in this guide is typed into PowerShell. To open it: press the
Windows key, type `powershell`, and press Enter.

> **On macOS or Linux?** Use Terminal instead of PowerShell. Every command in
> this guide is the same — only the repository paths change (for example
> `/Users/you/my-app`). The only Windows-only part is the optional lifecycle
> scripts in [OPERATIONS.md](OPERATIONS.md); nothing in this guide needs them.

Install these free tools once, accepting their default options, then close and
reopen PowerShell:

- **Node.js LTS** from <https://nodejs.org> — any release from 22.19 through
  26.x works. npm is included with it.
- **Git for Windows** from <https://git-scm.com/download/win> — optional; skip
  it if you download RepoRelay as a ZIP in the next step.

Check that everything is ready:

```powershell
node --version
git --version
```

Each command should print a version number. If it prints an error instead,
that tool is not installed yet — install it, close and reopen PowerShell, and
try again.

#### 2. Get RepoRelay

**Option A — install from npm (recommended):**

```powershell
npm install -g reporelay-mcp@latest
```

Check that it installed:

```powershell
reporelay --version
```

Prefer not to install anything? In every command below, replace `reporelay`
with `npx reporelay-mcp@latest` to run it on demand.

**Option B — download a ZIP (no npm needed).** On
<https://github.com/Lukie-81/RepoRelay>, click **Code** → **Download ZIP**,
then unzip it. To open PowerShell directly in the unzipped `RepoRelay-main`
folder: open the folder in File Explorer, type `powershell` in the address
bar, and press Enter. Then build once (this can take a few minutes):

```powershell
npm ci
npm run build
```

**Option C — clone with Git:**

```powershell
git clone https://github.com/Lukie-81/RepoRelay.git
cd RepoRelay
npm ci
npm run build
```

> **Which command do I type?** This guide says `reporelay ...` everywhere.
> That is the command after Option A. If you used Option B or C, run the same
> commands as `node dist/cli.js ...` from the RepoRelay folder instead, and
> keep that folder — every command runs from it.

If nothing printed an error, RepoRelay is installed and ready.

#### 3. Start RepoRelay for one repository

Pick ONE repository. For example:

```text
C:\Projects\my-app
```

Start RepoRelay for that repository:

```powershell
reporelay quickstart "C:\Projects\my-app"
```

Replace `C:\Projects\my-app` with the full path of the one repository folder
you want ChatGPT to inspect. Keep the quotation marks — they are required
when a path contains spaces.

RepoRelay now:

- approves `C:\Projects\my-app`;
- starts the local authenticated MCP server;
- enables loopback-only access;
- verifies the MCP tools;
- prepares the optional coding-agent handoff files.

A successful start prints a checklist ending with `Ready.`, followed by your
local MCP URL and bridge-secret file path. If it stops with an error instead,
see [Troubleshooting](#troubleshooting).

The command above uses the default Quickstart surface:

Default Quickstart: 7 tools. Read-only mode (`--no-handoff-writes`): 4 tools.

The default surface includes the four read-only tools plus the three fixed
handoff writers. For the read-only four-tool surface, use:

```powershell
reporelay quickstart "C:\Projects\my-app" --no-handoff-writes
```

Quickstart still prepares the handoff layout in read-only mode. If `AGENTS.md`
already exists without the RepoRelay marker, quickstart stops rather than
overwrites it. Follow the printed instruction to rerun with
`--append-agent-instructions` only after reviewing the safe backup behavior.

> **Keep this terminal running.** Press Ctrl+C to stop RepoRelay cleanly.

Quickstart prints a local MCP URL such as:

```text
http://127.0.0.1:7676/mcp
```

This works for MCP clients running on your computer. ChatGPT Web runs on
OpenAI's servers, so it cannot connect directly to your PC's `127.0.0.1`.
That's why the next section connects ChatGPT Web through an OpenAI
Secure MCP Tunnel.

The bridge secret stays in protected local file-backed storage. Configure
`tunnel-client` to send it as `X-RepoRelay-Bridge-Secret`; never paste the
secret value into ChatGPT, source control, logs, or handoff files.

### Connect ChatGPT Web

Your goal is to make RepoRelay appear as an app that ChatGPT can use.

There are three things to connect:

1. **RepoRelay** — runs on your PC and safely exposes one repository.
2. **Secure MCP Tunnel** — connects your PC to OpenAI without opening RepoRelay
   to the public internet.
3. **ChatGPT app** — tells ChatGPT which tunnel to use.

```text
PC                                      OpenAI / ChatGPT

Your repository
      ↑
RepoRelay :7676
      ↑
tunnel-client  ───── Secure MCP Tunnel ─────→  ChatGPT app
```

If RepoRelay is already showing `Ready.`, Step 1 is finished.

ChatGPT Web runs on OpenAI's servers, so it cannot connect directly to your
PC's `127.0.0.1`. An OpenAI **Secure MCP Tunnel** carries the traffic instead.
**The tunnel does not replace RepoRelay — it only connects ChatGPT Web to
RepoRelay.**

```text
ChatGPT Web
      ↓
Secure MCP Tunnel
      ↓
tunnel-client on your PC
      ↓
http://127.0.0.1:7676/mcp
      ↓
RepoRelay
```

You will use two PowerShell windows and one browser:

- **PowerShell window 1:** the RepoRelay quickstart window from the previous
  section. Keep it open.
- **PowerShell window 2:** the `tunnel-client` window. Keep it open too.
- **Browser:** OpenAI Platform to create the tunnel, then ChatGPT Web to create
  the MCP app.

There are three connection stages. Each stage has a checkpoint below; do not
move on until the current checkpoint passes:

| Part | Where | You end up with |
| --- | --- | --- |
| 1. Start RepoRelay | Your PC | A running bridge and a printed local MCP URL |
| 2. Create and run the tunnel | OpenAI Platform + your PC | A `tunnel_id` and a healthy, running `tunnel-client` |
| 3. Create the ChatGPT app | ChatGPT Web | An MCP app whose tools passed **Scan Tools** |

#### Step 1 — Make sure RepoRelay is running

If you have not started it yet, run this in PowerShell window 1 from the
RepoRelay folder:

```powershell
node dist/cli.js quickstart "C:\Projects\my-app"
```

Replace `C:\Projects\my-app` with the repository you want ChatGPT to inspect.
If you installed RepoRelay globally, use `reporelay quickstart ...` instead.
Leave this PowerShell window open.

Look for output like this:

```text
Ready.
Local MCP: http://127.0.0.1:7676/mcp
Health check: http://127.0.0.1:7676/healthz
Bridge secret file: <protected local file path>
```

Before continuing, you should have:

- [ ] RepoRelay says `Ready.`
- [ ] the RepoRelay PowerShell window is still open;
- [ ] the local MCP URL;
- [ ] the **bridge-secret file path**, not the secret value.

Open the health-check URL in a browser on the same PC. It should return
`{"ok":true,"name":"reporelay"}`.

The bridge secret must never be pasted into ChatGPT, OpenAI Platform, a Git
repository, or a tunnel profile as literal text. The tunnel client reads it
from the protected file on your PC.

#### Step 2 — Understand the four values

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

#### Step 3 — Create and run the tunnel

Now you are leaving RepoRelay temporarily and setting up the OpenAI side.

**In the OpenAI Platform** (a few minutes in the browser):

1. Open OpenAI's current [Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels), then open **Platform tunnel settings**.
2. Create or select a tunnel.
3. Associate the tunnel with the ChatGPT workspace where you will create the
   app. A tunnel associated only with a Platform organization may not appear
   in ChatGPT.
4. Create or obtain a runtime API key for `tunnel-client`. Save it in a
   protected file outside every repository.
5. Write down the tunnel's `tunnel_id`.

✅ **Checkpoint:** you have the `tunnel_id`, a protected runtime API-key file,
and permission to use the target ChatGPT workspace. Creating/editing tunnels
requires Platform tunnel-management permission; running or selecting one
requires tunnel-use permission.

**On your PC**, download the current `tunnel-client` from the OpenAI guide or
the [official releases](https://github.com/openai/tunnel-client/releases/latest).
Open a second PowerShell window and leave the RepoRelay window running.

The following Windows commands keep both secrets in files. Replace the four
placeholder values before running them:

You only need to replace the four values at the top. Leave the doctor and run commands themselves unchanged.

```powershell
$TunnelId = "tunnel_replace_with_your_tunnel_id"
$McpUrl = "http://127.0.0.1:7676/mcp"
$BridgeSecretFile = "C:\Users\YOUR_NAME\AppData\Local\RepoRelay\reporelay-bridge-secret.txt"
$RuntimeApiKeyFile = "C:\Users\YOUR_NAME\Documents\RepoRelay\openai-control-plane-api-key.txt"
$BridgeHeader = "X-RepoRelay-Bridge-Secret: file:$BridgeSecretFile"

tunnel-client doctor `
  --control-plane.tunnel-id $TunnelId `
  --control-plane.api-key "file:$RuntimeApiKeyFile" `
  --mcp.server-url $McpUrl `
  --mcp.extra-headers $BridgeHeader `
  --mcp.discovery-extra-headers $BridgeHeader `
  --explain
```

The doctor command must pass before you continue. It checks the tunnel
configuration and local MCP reachability. If Windows says that
`tunnel-client` is not recognized, run the same command with the full path to
`tunnel-client.exe`.

After doctor passes, start the client and leave this window open:

```powershell
tunnel-client run `
  --control-plane.tunnel-id $TunnelId `
  --control-plane.api-key "file:$RuntimeApiKeyFile" `
  --mcp.server-url $McpUrl `
  --mcp.extra-headers $BridgeHeader `
  --mcp.discovery-extra-headers $BridgeHeader
```

`--mcp.extra-headers` sends the RepoRelay header with normal MCP requests.
`--mcp.discovery-extra-headers` sends it during discovery and startup probes.
The `file:` values tell `tunnel-client` to read the secrets locally; do not
replace them with the actual secret text.

✅ **Tunnel checkpoint:**

- [ ] RepoRelay is still running;
- [ ] `tunnel-client` is running on your PC;
- [ ] `tunnel-client doctor` passed and `tunnel-client run` remains open;
- [ ] you have a `tunnel_id`;
- [ ] the OpenAI runtime credential is stored safely;
- [ ] `tunnel-client` forwards to the local MCP URL;
- [ ] `tunnel-client` loads the RepoRelay bridge secret from its file.

At this point the network path exists, but ChatGPT still does not know about
RepoRelay. The next step creates the ChatGPT app.

If the tunnel client prints a local health or readiness URL, confirm that it
reports healthy, ready, and polling.

> **Full tunnel setup → [`docs/chatgpt-web.md`](docs/chatgpt-web.md)**

#### Step 4 — Create the RepoRelay app in ChatGPT

Now switch to ChatGPT Web in your browser:

1. Open **Apps** in ChatGPT Web and choose **Create**. Depending on your plan,
   this may be under **Workspace Settings → Apps → Create** or **Settings →
   Apps → Create**.
2. Enable Developer Mode, or ask the workspace administrator to grant you
   access. If you cannot see **Create**, this is a ChatGPT permission issue,
   not a RepoRelay issue.
3. Choose a custom MCP app and select **Tunnel** under **Connection**.
4. Select the tunnel you created, or paste its `tunnel_id`.
5. If ChatGPT asks for an endpoint, do not enter `127.0.0.1` or `localhost`.
   The tunnel selection supplies the remote endpoint.
6. Do **not** paste the RepoRelay bridge secret into ChatGPT. The local
   `tunnel-client` supplies that header on the PC.
7. Click **Scan Tools** and wait for the scan to finish.
8. Review the returned tools, then click **Create**. If the app appears under
   **Drafts**, publish or enable it as required by your workspace.
9. Start a **new** chat, open the tools menu, and select the RepoRelay app.

For current ChatGPT app labels, permissions, and availability, use OpenAI's
[Developer mode and MCP apps in ChatGPT](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt) guide.

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

If you see shell, Git, process execution, generic file editing, delete tools,
or any unexpected tool, stop and investigate before using the app.

✅ **Checkpoint:** **Scan Tools** lists exactly the expected tools above —
nothing more, nothing fewer. If the tunnel is not listed, check that it is
associated with the target ChatGPT workspace and that you have tunnel-use
permission. If scanning fails, keep both PowerShell windows open and rerun the
full `tunnel-client doctor` command from Step 3 before trying again.

#### Step 5 — Confirm RepoRelay is connected

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

Then test the security boundary:

```text
Try to read .env.
```

Expected result:

```text
BLOCKED
```

If the sensitive-file request succeeds, or the tool list is unexpected, stop
and run the audit before continuing.

#### Can't see RepoRelay in ChatGPT?

Check the connection in this order:

1. **Does RepoRelay still say `Ready.`?** If not, restart RepoRelay.
2. **Is `tunnel-client` running and healthy?** If not, rerun the full doctor
   command from Step 3 and restart it.
3. **Is the ChatGPT app using the correct tunnel or `tunnel_id`?** If not,
   correct the app connection.
4. **Did Scan Tools return the expected RepoRelay tools?** If not, check the
   local MCP URL and both RepoRelay authentication header options.
5. **Did scanning succeed but the app is not in the chat?** Start a new chat
   and select or enable the app using the current ChatGPT workspace flow.

If the tool list is unexpected, stop and run the audit before continuing. If
ChatGPT cannot connect at all, the usual causes are a stopped RepoRelay
terminal or an unhealthy `tunnel-client`.

#### Next time

You do **not** recreate the tunnel or ChatGPT app every time. Normally:

1. Start RepoRelay.
2. Confirm `tunnel-client` is running.
3. Open a new ChatGPT chat.
4. Select the RepoRelay app.
5. Start working.

The README explains which values go where and what success looks like. The
[ChatGPT Web runbook](docs/chatgpt-web.md) contains the detailed local tunnel
configuration. OpenAI's [Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
owns current tunnel commands and credentials; OpenAI's [Developer mode and
MCP apps guide](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt)
owns current ChatGPT UI and workspace permissions.

## How it works

MCP (Model Context Protocol) is the standard that lets ChatGPT call tools.
ChatGPT is the MCP client. RepoRelay is the local MCP server and security
boundary: it decides what ChatGPT may access and exposes exactly one approved
repository at a time. `tunnel-client` is only the secure networking pipe.

| Component | Job |
| --- | --- |
| ChatGPT | MCP client — chooses RepoRelay tools. |
| Secure MCP Tunnel | Carries traffic from ChatGPT to your computer. |
| `tunnel-client` | Local network forwarder; points the tunnel at RepoRelay. |
| RepoRelay | MCP server + security boundary; enforces authentication and allowed access. |
| Repository | The one directory ChatGPT is allowed to inspect. |

## You're connected — now what?

Use prompts like these:

### Inspect the repo

```text
Open the approved repository and list its top-level files.
```

### Read something

```text
Read README.md and explain how this project starts.
```

### Search

```text
Search the repository for "authentication".
```

### Test the boundary

```text
Try to read .env.
```

The last request should be blocked.

## Normal daily use

You do **not** repeat the tunnel or ChatGPT app creation every time. For a
repository that already has a configured tunnel and app:

1. Start RepoRelay if it is not already running:

   ```powershell
   reporelay quickstart "C:\Projects\my-app"
   ```

   (From a ZIP or clone, open PowerShell in the RepoRelay folder first.)

2. Make sure the configured `tunnel-client` profile is running and healthy.
   If it is managed or autostarted, confirm its status instead of starting a
   second copy.
3. Open ChatGPT Web.
4. Start a new chat and select the RepoRelay app.
5. Ask ChatGPT to inspect the repository.

Keep the RepoRelay terminal and `tunnel-client` running while you use the app.
If you stopped either process between uses, start it again using the saved
configuration.

## Switch repositories

**RepoRelay exposes one repository at a time.**

### Quickstart path

1. Press Ctrl+C in the current RepoRelay terminal.
2. Start RepoRelay again for the new repository:

   ```powershell
   reporelay quickstart "C:\Projects\another-repo"
   ```

3. Keep `tunnel-client` running. If it uses the same port and protected
   bridge-secret file, it can reconnect to the restarted RepoRelay process.
4. Start a new ChatGPT conversation and select the RepoRelay app.
5. Ask ChatGPT to open the new repository.

Do not rescan tools just because the approved repository changed. Rescan only
if the tool definitions changed, ChatGPT asks you to, or you recreated the app.

### Advanced / managed Windows setup

For the managed lifecycle, run this from the RepoRelay source checkout:

```powershell
.\ops\Restart-RepoRelay.ps1 -WorkspaceRoot "C:\Projects\another-repo"
```

The target must already have the required handoff files and the managed
tunnel/secret layout. See [OPERATIONS.md](OPERATIONS.md) for the full lifecycle.

## Local MCP clients

If your MCP client runs on the same computer as RepoRelay, you do not need
Secure MCP Tunnel:

```text
Local MCP client
      ↓
127.0.0.1:7676/mcp
      ↓
RepoRelay
      ↓
one approved repository
```

The client must support:

- Streamable HTTP MCP;
- the RepoRelay authentication header, `X-RepoRelay-Bridge-Secret`.

Use the MCP URL printed by quickstart; `7676` is the default port. See
[advanced configuration](docs/configuration.md) for local client settings.

## Optional coding-agent handoff

Handoff files coordinate separate local work; they do not run code remotely:

```text
ChatGPT plans/reviews
      ↓
NEXT_TASK.md
      ↓
Codex / Claude implements locally
      ↓
RESULT.md
      ↓
ChatGPT reviews
```

The default quickstart enables these fixed writers:

| Tool | Fixed target |
| --- | --- |
| `write_next_task` | `.ai-handoff/NEXT_TASK.md` |
| `write_review` | `.ai-handoff/REVIEW.md` |
| `update_handoff_state` | `.ai-handoff/STATE.json` |

The targets must already exist and cannot be selected by the caller. The separate
local implementer owns `.ai-handoff/RESULT.md`. RepoRelay does not run Codex or
Claude. Use [`docs/handoff-cycle.md`](docs/handoff-cycle.md) and the
[handoff examples](examples/) for the detailed coordination rules.

## Verify your setup

Open PowerShell in the RepoRelay folder and run:

```powershell
reporelay audit "C:\Projects\my-app"
reporelay audit "C:\Projects\my-app" --json
```

If you used `--no-handoff-writes` for quickstart, add that flag to both audit
commands.

Audit tests RepoRelay's actual authenticated security boundary: the approved
root, loopback and authentication settings, tool surface, sensitive-file
blocking, containment checks, and fixed handoff restrictions. It uses disposable
fixtures and does not modify the approved repository.

It does not test ChatGPT Web or the external tunnel. See [SECURITY.md](SECURITY.md).

## Troubleshooting

The most common problems and their fixes:

| You see | Fix |
| --- | --- |
| `'node' is not recognized` or `'git' is not recognized` | That tool is not installed, or PowerShell was opened before the install finished. Install it, close and reopen PowerShell, and try again. |
| `RepoRelay requires Node.js >=22.19 and <27` | Install the Node.js LTS release from <https://nodejs.org>, reopen PowerShell, and check `node --version`. |
| `'reporelay' is not recognized` | The npm install did not finish or PowerShell was opened before it finished. Re-run `npm install -g reporelay-mcp@latest`, close and reopen PowerShell, and try `reporelay --version`. If you installed from a ZIP or clone instead, run the commands as `node dist/cli.js ...` from the RepoRelay folder. |
| `Cannot find module ... dist\cli.js` | You are in the wrong folder for a ZIP or clone install. In PowerShell, `cd` into the `RepoRelay` (or `RepoRelay-main`) folder, and run `npm run build` if you have not built yet. |
| `Port 7676 is already in use` | RepoRelay or another program is already listening there. Press Ctrl+C in its window to stop it, or rerun quickstart with a different `--port` and point the tunnel at the new port. |
| Quickstart stops about an existing `AGENTS.md` | The repository already has an `AGENTS.md` without the RepoRelay marker. Review the printed instructions before using `--append-agent-instructions`. |
| **Scan Tools** fails or returns no tools | Keep both PowerShell windows open. Confirm the quickstart health check works, rerun the full `tunnel-client doctor` command from Step 3, and verify the client uses the printed local MCP URL plus both file-backed `X-RepoRelay-Bridge-Secret` header options. Then rescan. |
| ChatGPT cannot connect or cannot open the repository | The RepoRelay terminal or `tunnel-client run` stopped. Restart the missing process, confirm both checkpoints pass, then try again in a **new** chat. |
| ChatGPT offers no tools / the app is missing | Confirm the tunnel is associated with the target ChatGPT workspace, you have tunnel-use permission, and the app is enabled or published instead of remaining in Drafts. |
| **Scan Tools** lists unexpected tools | Stop and investigate before using the app: run the audit command above and confirm the expected tool list. |

For anything else, run `reporelay doctor`. It
prints configuration and security status without printing secret values.

## Security summary

RepoRelay's enforced boundary includes:

- loopback-only binding and authentication required;
- exactly one existing canonical approved root;
- sensitive paths blocked, including `.env`, VCS metadata, credential stores,
  and private-key formats;
- traversal, absolute outside-root paths, symlink/junction/reparse escapes, and
  hard-link bypasses blocked;
- bounded reads, searches, results, and handoff content;
- no shell, PowerShell, Git, process, generic write, patch, delete, artifact,
  worktree, skill, subagent, or local-agent tool;
- optional handoffs limited to the three fixed pre-existing targets.

RepoRelay is a least-privilege application boundary, not an operating-system
sandbox against malicious software already running as the same local user. An
external Secure MCP Tunnel is a separate security boundary and must be secured
independently. Choose the approved repository carefully.

## Requirements and platform support

- Node.js `>=22.19 <27` (npm is included);
- Git for the clone-based quick start — optional if you download the ZIP
  instead.

The quick start in this README works on Windows, macOS, and Linux. The core
Node test suite runs in CI on all three. Windows 10/11 is the fully validated
lifecycle and operational platform, including the PowerShell scripts and
tunnel-managed runbook.

## Limitations

- One approved repository is exposed at a time.
- RepoRelay is not an operating-system sandbox.
- ChatGPT Web needs external OpenAI Secure MCP Tunnel infrastructure to reach a
  private local bridge.
- Windows is the fully validated lifecycle platform; other platforms do not
  have identical PowerShell/tunnel operations.
- Codex, Claude, and other coding agents are separate local applications, not
  components of RepoRelay.

## Documentation

- [ChatGPT Web setup](docs/chatgpt-web.md)
- [Security model](SECURITY.md)
- [Configuration](docs/configuration.md)
- [Windows operations](OPERATIONS.md)
- [Setup notes](docs/setup.md)
- [Handoff cycle](docs/handoff-cycle.md)
- [Handoff examples](examples/)
- [Contributing](CONTRIBUTING.md)

## Advanced configuration

Most users should not need environment variables before their first successful
connection. When you need them, use:

- [Configuration](docs/configuration.md) — `REPORELAY_*` variables, bridge
  authentication, ports, logging, and handoff mode;
- [Windows operations](OPERATIONS.md) — lifecycle scripts, secret-file
  handling, tunnel-client profiles, diagnostics, and autostart;
- [`.env.example`](.env.example) — placeholder configuration only. Never put a
  real bridge secret or tunnel credential in it.

For configuration and security status without printing secret values, run:

```powershell
reporelay doctor
```

## License and project lineage

RepoRelay 1.2.0 is released under the [MIT License](LICENSE). The project keeps
its required upstream attribution and does not bundle the SDKs or runtimes of
Codex, Claude, or other implementers.

## Development

```powershell
npm ci
npm run typecheck
npm test
npm run verify:release
npm audit --audit-level=low
npm pack --dry-run --json
git diff --check
```
