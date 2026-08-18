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

RepoRelay gives an AI reviewer bounded access to one approved repository through an
authenticated loopback MCP bridge. ChatGPT Web reaches it through an OpenAI
Secure MCP Tunnel:

```text
ChatGPT Web -> Secure MCP Tunnel -> tunnel-client -> RepoRelay -> one repository
```

### Install and start RepoRelay

You need Node.js 22.19 through 26.x and one repository to review.

```powershell
npm install -g reporelay-mcp@latest
reporelay quickstart "C:/Projects/my-app"
```

Replace the example path with the repository you want to expose. Keep this
PowerShell window open. The default quickstart listens at
`http://127.0.0.1:7676/mcp`. For a read-only four-tool surface, add
`--no-handoff-writes`.

If you are working from a source checkout, use `npm ci`, `npm run build`, and
replace `reporelay` with `node dist/cli.js`.

### Connect ChatGPT Web

ChatGPT Web cannot connect directly to your PC's `127.0.0.1`. The tunnel
client makes that local bridge reachable without exposing RepoRelay publicly.
RepoRelay does not need an OpenAI API key for local use. The OpenAI runtime
API key is used by `tunnel-client` to authenticate to OpenAI; it is not used by
RepoRelay. See the current [OpenAI Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
for Platform permissions and tunnel terminology.

You need:

- an OpenAI Secure MCP Tunnel and its `tunnel_id`;
- an OpenAI runtime API key;
- the official `tunnel-client` downloaded locally; RepoRelay does not
  download it; and
- access to create a custom MCP app in the target ChatGPT workspace.

#### 1. Create the tunnel

In OpenAI Platform, create or select a tunnel and associate it with the
ChatGPT workspace that will use it. Keep the resulting `tunnel_id`. The
runtime API key is created separately in the Platform runtime-key settings.

#### 2. Run RepoRelay setup

Install the official tunnel client and put it on PATH, or keep its executable
path ready. In a second PowerShell window, run:

```powershell
reporelay tunnel setup
```

RepoRelay prompts for the tunnel ID and then prompts for the runtime API key
with input hidden. It finds `tunnel-client` on PATH or asks for its executable
path. The key is never accepted as a command-line argument.

Setup preserves the existing bridge secret and runtime-key file, then writes the
client profile using file references:

```text
%LOCALAPPDATA%\RepoRelay\
  reporelay-bridge-secret.txt
  tunnel\
    config.json
    profiles\reporelay.yaml
    secrets\openai-runtime-api-key.txt
```

The generated profile targets RepoRelay's default local MCP URL and sends the
bridge header from the protected bridge-secret file. Do not copy either
credential into ChatGPT, source control, or a profile as literal text.

#### 3. Check the connection

```powershell
reporelay tunnel doctor
```

Wait for `Ready.` The doctor checks the named `reporelay` profile, runtime
credential, local reachability, and bridge authentication. Add
`--verbose` only when you need redacted diagnostics.

#### 4. Run the tunnel

```powershell
reporelay tunnel run
```

Keep this window open while ChatGPT uses RepoRelay. RepoRelay's quickstart
window must remain open as well. `tunnel-client` stays in the foreground.

#### 5. Add the app in ChatGPT

Follow the current [ChatGPT Developer Mode and MCP apps guide](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt).
Create a custom MCP app, choose the tunnel connection, select the tunnel, and
run **Scan Tools**. A default quickstart should expose seven tools; with
`--no-handoff-writes`, it should expose exactly four:

```text
open_workspace
list_files
read_file
search_files
```

Stop if the scan shows shell, Git, process execution, arbitrary file editing,
or any unexpected capability.

### Connection troubleshooting

| Symptom | Next check |
| --- | --- |
| Setup cannot find `tunnel-client` | Download the official client, put it on PATH or rerun setup with its path. |
| Setup says the bridge secret is missing | Start RepoRelay with `reporelay quickstart` and use the default config directory. |
| Doctor cannot reach MCP | Keep quickstart running on port 7676, then rerun `reporelay tunnel doctor`. |
| Doctor reports bridge authentication failure | Do not paste a secret. Confirm quickstart is using the canonical bridge-secret file, then rerun setup. |
| ChatGPT cannot list the tunnel or create the app | Check tunnel association and ChatGPT workspace permissions in the current OpenAI guides. |
| Scan Tools shows unexpected tools | Stop and run `reporelay audit <repository> --json` before continuing. |

For the deeper connection reference, see
[docs/chatgpt-web.md](docs/chatgpt-web.md). The [OpenAI tunnel-client
configuration reference](https://github.com/openai/tunnel-client/blob/master/docs/configuration.md)
owns the client profile schema and flags.

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

## Daily use

After setup, do not recreate the tunnel or ChatGPT app. Start the two local
processes, then select the existing app:

1. `reporelay quickstart "C:/Projects/my-app"`
2. `reporelay tunnel run`
3. Open a new ChatGPT chat and select the RepoRelay app.

Keep both terminals open while you use the app. Run `reporelay tunnel doctor`
again if the connection stops working.

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
| `Port 7676 is already in use` | RepoRelay or another program is already listening there. Press Ctrl+C in its window to stop it; the generated CLI profile targets the default 7676 MCP port. |
| Quickstart stops about an existing `AGENTS.md` | The repository already has an `AGENTS.md` without the RepoRelay marker. Review the printed instructions before using `--append-agent-instructions`. |
| **Scan Tools** fails or returns no tools | Keep both PowerShell windows open. Confirm the quickstart health check works, run `reporelay tunnel doctor`, and rescan only after it reports `Ready.` |
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
