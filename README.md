<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/reporelay-logo-dark.png">
    <img src="docs/assets/reporelay-logo.png" width="440" alt="RepoRelay">
  </picture>
</p>

<p align="center"><b>Give AI access to your repository &mdash; not your machine.</b></p>

RepoRelay lets ChatGPT safely inspect one local code repository without giving
it shell access, Git, process execution, arbitrary file writes, or access to
the rest of your computer.

## What ChatGPT can and cannot do

| ChatGPT can | ChatGPT cannot |
| --- | --- |
| Read safe files | Run shell or PowerShell |
| Search code | Use Git |
| List directories | Run processes |
| Access one approved repository | Browse the rest of your computer |
| Use optional fixed handoff writes | Arbitrarily edit or delete files |

`.env`, `.git`, private keys, credential stores, outside-root paths,
symlink/junction escapes, and similar sensitive paths are blocked.

## How it works

MCP (Model Context Protocol) is the standard that lets ChatGPT call tools.
ChatGPT is the MCP client. RepoRelay is the local MCP server and security
boundary: it decides what ChatGPT may access and exposes exactly one approved
repository at a time. `tunnel-client` is only the secure networking pipe.

```text
ChatGPT Web
      ↓
OpenAI Secure MCP Tunnel
      ↓
tunnel-client
      ↓
RepoRelay
      ↓
one approved local repository
```

| Component | Job |
| --- | --- |
| ChatGPT | MCP client — chooses RepoRelay tools. |
| Secure MCP Tunnel | Carries traffic from ChatGPT to your computer. |
| `tunnel-client` | Local network forwarder; points the tunnel at RepoRelay. |
| RepoRelay | MCP server + security boundary; enforces authentication and allowed access. |
| Repository | The one directory ChatGPT is allowed to inspect. |

## Start here

Follow these steps in order:

1. Install the one-time prerequisites on your PC.
2. Download or build RepoRelay.
3. Start RepoRelay for one repository.
4. Create an OpenAI Secure MCP Tunnel.
5. Run `tunnel-client` on your computer.
6. Add the tunnel to ChatGPT Web.
7. Scan the RepoRelay tools.
8. Start a new ChatGPT chat.
9. Ask ChatGPT to inspect the approved repository.

## First-time setup

The detailed first-time path below is normally done once:

- download or clone RepoRelay and build it once;
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

Until RepoRelay is published to npm, get it from GitHub. Either option works:

**Option A — download a ZIP (no Git needed).** On
<https://github.com/Lukie-81/RepoRelay>, click **Code** → **Download ZIP**,
then unzip it. To open PowerShell directly in the unzipped `RepoRelay-main`
folder: open the folder in File Explorer, type `powershell` in the address
bar, and press Enter.

**Option B — clone with Git:**

```powershell
git clone https://github.com/Lukie-81/RepoRelay.git
cd RepoRelay
```

Whichever option you chose, install and build (this can take a few minutes):

```powershell
npm ci
npm run build
```

If neither command prints an error, RepoRelay is installed. Keep the folder —
every RepoRelay command in this guide runs from it.

#### 3. Start RepoRelay for one repository

Pick ONE repository. For example:

```text
C:\Projects\my-app
```

Start RepoRelay for that repository:

```powershell
node dist/cli.js quickstart "C:\Projects\my-app"
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

The command above uses the default handoff mode, which exposes the four
read-only tools plus the three fixed handoff writers. For the read-only
four-tool surface, use:

```powershell
node dist/cli.js quickstart "C:\Projects\my-app" --no-handoff-writes
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
That's why the next step uses OpenAI Secure MCP Tunnel.

The bridge secret stays in protected local file-backed storage. Configure
`tunnel-client` to send it as `X-RepoRelay-Bridge-Secret`; never paste the
secret value into ChatGPT, source control, logs, or handoff files.

### Secure MCP Tunnel

**The tunnel does not replace RepoRelay. It only connects ChatGPT Web to
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

#### A. Create a tunnel

1. Open OpenAI's current [Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels).
2. In Platform tunnel settings, create or select a tunnel.
3. Record its `tunnel_id`.

#### B. Run `tunnel-client`

Install `tunnel-client` by following the OpenAI guide above, then configure it
to:

- use the `tunnel_id`;
- forward to the local MCP URL printed by quickstart;
- use its protected runtime API key;
- send `X-RepoRelay-Bridge-Secret` from protected local file-backed storage.

Keep the configured `tunnel-client` process running and healthy while you
create or test the ChatGPT app. Do not put RepoRelay's bridge secret into
ChatGPT.

> **Full tunnel setup → [`docs/chatgpt-web.md`](docs/chatgpt-web.md)**

### In ChatGPT Web

Keep these steps separate from the terminal steps above:

1. Enable Developer Mode if required, or ask your workspace administrator for
   access.
2. Create a developer-mode MCP app. The current flow is under Apps → Create
   or the equivalent developer-mode app screen.
3. Under **Connection**, choose **Tunnel**.
4. Select your tunnel or enter its `tunnel_id`.
5. Click **Scan Tools**.
6. Confirm that the returned tools match one of the lists below.
7. Click **Create**. If your workspace places the app in Drafts, enable or
   select it using the current workspace flow.
8. Start a **new** chat.
9. Select the RepoRelay app.

For current ChatGPT app labels, permissions, and availability, use OpenAI's
[Developer mode and MCP apps in ChatGPT](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt) guide.

**Read-only quickstart** (`--no-handoff-writes`):

```text
open_workspace
list_files
read_file
search_files
```

**Default quickstart with handoff writes:**

```text
open_workspace
list_files
read_file
search_files
write_next_task
write_review
update_handoff_state
```

If you see shell, Git, process execution, generic file editing, delete tools,
or any unexpected tool, stop and investigate before using the app.

### First test

In the new chat, ask:

```text
Open the approved repository and summarize its architecture.
```

Then test the boundary:

```text
Try to read .env.
```

Expected result:

```text
BLOCKED
```

If the sensitive-file request succeeds, or the tool list is unexpected, stop
and run the audit before continuing.

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

1. Start RepoRelay if it is not already running. Open PowerShell in the
   RepoRelay folder (in File Explorer, type `powershell` in the address bar
   and press Enter), then run:

   ```powershell
   node dist/cli.js quickstart "C:\Projects\my-app"
   ```

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
   node dist/cli.js quickstart "C:\Projects\another-repo"
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

## Full architecture

The setup above is the operating path. This image reinforces the same boundary:

![RepoRelay architecture: an authenticated AI reviewer reaches the loopback bridge, which exposes bounded read and search access to one approved repository and optional fixed handoff writers for a separate implementer.](docs/assets/reporelay-hero.png)

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
node dist/cli.js audit "C:\Projects\my-app"
node dist/cli.js audit "C:\Projects\my-app" --json
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
| `Cannot find module ... dist\cli.js` | You are in the wrong folder. In PowerShell, `cd` into the `RepoRelay` (or `RepoRelay-main`) folder, and run `npm run build` if you have not built yet. |
| `Port 7676 is already in use` | RepoRelay or another program is already listening there. Press Ctrl+C in its window to stop it, or rerun quickstart with a different `--port` and point the tunnel at the new port. |
| Quickstart stops about an existing `AGENTS.md` | The repository already has an `AGENTS.md` without the RepoRelay marker. Review the printed instructions before using `--append-agent-instructions`. |
| **Scan Tools** lists unexpected tools | Stop and investigate before using the app: run the audit command above and confirm the expected tool list. |

For anything else, run `node dist/cli.js doctor` from the RepoRelay folder. It
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

The core Node test suite runs in CI on Ubuntu, macOS, and Windows. Windows 10/11
is the fully validated lifecycle and operational platform, including the
PowerShell scripts and tunnel-managed runbook.

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
node dist/cli.js doctor
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
