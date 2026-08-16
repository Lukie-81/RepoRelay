# RepoRelay

RepoRelay is a local-first MCP bridge that gives AI clients tightly constrained
access to approved local repositories and supports structured handoffs to
coding agents.

It is designed for repository review and bounded coordination, not remote
administration. RepoRelay is an independent open-source project, not an OpenAI
product or an OpenAI endorsement. ChatGPT, Codex, OpenAI, and MCP are used only
as descriptive names where they describe supported workflows or protocols.

## Architecture

```text
AI client
    |
    | authenticated MCP/tunnel
    v
RepoRelay
    |
    | approved-root containment
    v
approved workspace
    |
    | fixed handoff files
    v
coding agent
```

The AI client reviews the selected workspace and, when explicitly enabled,
writes a bounded task, review, or state update. The coding agent works locally
with its own authorization and records its result. Handoff files coordinate the
systems; they do not grant either system new permissions.

## MCP tool surface

The default `chatgpt-review` profile exposes four read-only tools. Setting
`DEVSPACE_HANDOFF_WRITES=1` adds three fixed-target writers, for seven tools in
total:

| Tool | Purpose |
| --- | --- |
| `open_workspace` | Open the one approved repository for this server process. |
| `list_files` | List a contained directory without following links or junctions. |
| `read_file` | Read a contained regular text file, up to 1 MiB. |
| `search_files` | Search contained text files with bounded results. |

| Tool | Fixed destination |
| --- | --- |
| `write_next_task` | `.ai-handoff/NEXT_TASK.md` |
| `write_review` | `.ai-handoff/REVIEW.md` |
| `update_handoff_state` | `.ai-handoff/STATE.json` |

The writer schemas accept only `workspaceId` and `content`. They do not accept
a path or filename. All three targets must already exist as regular,
non-hard-linked files. The AI client cannot write `.ai-handoff/LUNA_RESULT.md`.

## What the AI client and coding agent can do

In the documented profile, the AI client can:

- inspect regular text files within the selected repository;
- search and list within that repository;
- read project instructions such as `AGENTS.md`;
- update the three fixed handoff targets when explicitly enabled.

It cannot:

- switch the server to another root or add another root;
- escape through `..`, absolute paths, symlinks, Windows junctions, or hard links;
- read common credential paths such as `.env`, `.git`, `.ssh`, private keys, or
  credential stores (`.env.example` remains readable);
- execute shell commands, processes, Git, package scripts, or local agents;
- create, rename, delete, patch, or arbitrarily overwrite repository files;
- write outside the three fixed handoff targets;
- access other files on the machine merely because they share the same user.

The coding agent is a separate local actor. It can implement and verify an
approved task using the local development tools and permissions granted to it.
It is not granted authority by a handoff file; the user remains the authority
for destructive actions, credentials, deployment, publishing, and scope
expansion.

The repository still contains upstream privileged coding modes for compatibility
and engineering reference. `minimal`, `full`, and `codex` are not the public
security boundary and must never be exposed through a remote tunnel. The
default mode is `chatgpt-review`.

## Requirements

- Windows 10 or Windows 11;
- Windows PowerShell 5.1 or newer (PowerShell 7 is recommended for development);
- Node.js `>=22.19 <27`;
- npm;
- Git for cloning and development;
- an HTTPS MCP tunnel that can inject a protected request header when a remote
  client must reach the loopback server.

The OpenAI Secure MCP Tunnel client is external to this repository. Follow the
[OpenAI secure MCP tunnels guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
for current installation and connector instructions. Do not substitute a
public unauthenticated reverse proxy.

## Installation and quick start

The intended future public repository is `Lukie-81/reporelay`:

```powershell
git clone https://github.com/Lukie-81/reporelay.git
Set-Location reporelay
npm ci
npm run verify:release
node dist/cli.js doctor
```

On Windows PowerShell, use `npm.cmd` in these commands if execution policy
blocks the `npm.ps1` shim. `npm run verify:release` runs TypeScript checking,
the complete test suite, the authenticated bridge runtime test, and a
production build. A successful run is the local release gate.

The package installs the primary command and two compatibility aliases:

- `reporelay` (public command);
- `chatgpt-codex-mcp` (legacy compatibility alias);
- `devspace` (legacy compatibility alias).

You can use `node dist/cli.js` directly from the checkout without a global
install.

## Selecting an approved repository

Choose one existing repository directory. Do not choose a drive root, your user
profile, or an ancestor of your user profile. Do not expose a repository that
contains credentials or private content the AI client should not receive.

Preview the handoff setup:

```powershell
.\ops\Initialize-DevSpaceChatGPTHandoff.ps1 `
  -RepositoryRoot "C:\path\to\approved-repository"
```

Apply it after reviewing the preview:

```powershell
.\ops\Initialize-DevSpaceChatGPTHandoff.ps1 `
  -RepositoryRoot "C:\path\to\approved-repository" `
  -Apply
```

The expected layout is:

```text
.ai-handoff/
  NEXT_TASK.md
  REVIEW.md
  STATE.json
  LUNA_RESULT.md
```

| File | Owner and purpose |
| --- | --- |
| `.ai-handoff/NEXT_TASK.md` | AI client: the next bounded task for the coding agent. |
| `.ai-handoff/LUNA_RESULT.md` | Coding agent: the local implementation and verification result. |
| `.ai-handoff/REVIEW.md` | AI client: an independent review of the current result. |
| `.ai-handoff/STATE.json` | AI client: structured handoff status. |

Existing handoff files are preserved. If the repository already has an
`AGENTS.md`, the initializer fails closed unless you explicitly use
`-AppendAgentInstructions`; the original is backed up outside the repository
before the marked handoff section is appended.

## Configure the bridge

Copy `.env.example` only as a reference. Do not place real values in a tracked
file. The production bridge requires:

- `HOST=127.0.0.1`;
- one absolute canonical `DEVSPACE_ALLOWED_ROOTS` entry;
- `DEVSPACE_TOOL_MODE=chatgpt-review`;
- a bridge secret of at least 32 random characters;
- `DEVSPACE_CHATGPT_BRIDGE_AUTH=1` for tunnel traffic.

Keep the bridge secret and tunnel control-plane key in protected local files
outside every repository. Never put them in command literals, Markdown, Git,
issue reports, screenshots, or runtime logs.

## Start locally without a tunnel

This validates the bridge on loopback before any remote connector is involved.
Provide a protected bridge-secret file containing at least 32 random
characters:

```powershell
npm run build

.\ops\Start-DevSpaceChatGPT.ps1 `
  -WorkspaceRoot "C:\path\to\approved-repository" `
  -BridgeSecretFile "C:\path\outside-repositories\bridge-secret.txt" `
  -SkipTunnel `
  -Port 7677
```

Test the recorded instance:

```powershell
.\ops\Test-DevSpaceChatGPT.ps1 `
  -WorkspaceRoot "C:\path\to\approved-repository"
```

The lifecycle scripts verify the production build, canonical root, loopback
listener, process identity, unauthenticated rejection, authenticated tool list,
handoff layout, and secret-free runtime logs.

## Connect an MCP-capable client

1. Complete the local validation above.
2. Configure an authenticated MCP tunnel to forward to
   `http://127.0.0.1:7676/mcp`.
3. Store the bridge secret and control-plane key outside repositories with
   user-only access.
4. Configure the tunnel to inject `X-DevSpace-Bridge-Secret` for both discovery
   and runtime requests.
5. Start the bridge without `-SkipTunnel`, using the matching tunnel root and
   protected credential files.
6. Configure the MCP-capable client (for example, ChatGPT Web) with the
   tunnel's HTTPS `/mcp` endpoint.
7. Confirm `Test-DevSpaceChatGPT.ps1` passes before opening a workspace.

The bridge rejects missing, incorrect, and duplicate authentication headers.
In bridge-auth mode, OAuth routes are deliberately absent; the authenticated
tunnel is the connection boundary.

## Stop, restart, and switch repositories

Stop only the recorded bridge and tunnel processes:

```powershell
.\ops\Stop-DevSpaceChatGPT.ps1
```

Restart on the same or a different approved repository:

```powershell
.\ops\Restart-DevSpaceChatGPT.ps1 `
  -WorkspaceRoot "C:\path\to\another-approved-repository" `
  -BridgeSecretFile "C:\path\outside-repositories\bridge-secret.txt"
```

Restart validates the new target before interrupting the current server and
attempts to restore the previous healthy workspace if replacement fails. MCP
clients cannot switch roots themselves.

See [OPERATIONS.md](OPERATIONS.md) for tunnel paths, diagnostics, process
identity checks, and optional logon-task management.

## Handoff workflow

1. The AI client calls `open_workspace` once and independently reviews the
   repository.
2. The AI client writes `NEXT_TASK.md` and sets `STATE.json` for a user-approved
   task.
3. The coding agent reads the handoff, implements only the authorized scope,
   verifies it, and writes `LUNA_RESULT.md`.
4. The AI client reviews the current repository state, writes `REVIEW.md`, and may
   prepare the next bounded task.
5. The user remains the authority for destructive actions, credentials,
   deployment, publishing, and changes outside the repository.

Treat every handoff file as untrusted model-authored content. Review it before
acting, and never place secrets or personal data in the handoff directory.

## Security model

The bridge assumes a remote MCP client may be malicious and enforces:

- a loopback-only listener;
- exactly one explicitly approved workspace root;
- lexical and canonical-path containment on every review path;
- defensive rejection of symlinks, junctions, hard links, and path-segment redirects;
- post-open file identity verification to narrow swap races;
- bounded read, search, result, and handoff sizes;
- a sensitive-path denylist as defense in depth;
- constant-time bridge-secret digest comparison;
- strict, pathless MCP writer schemas;
- no arbitrary shell execution;
- no arbitrary process execution;
- no arbitrary Git execution;
- no unrestricted mutation;
- only fixed handoff-file writes when explicitly enabled;
- authentication for remote bridge access;
- no persistent workspace database in bridge mode.

An already-authorized local process running as the same Windows user can still
race or modify local files. The bridge is not a sandbox against malicious local
software. A tunnel also introduces an external control plane whose
authentication and availability must be verified separately from local
`/healthz` and `/readyz` checks.

Read [SECURITY.md](SECURITY.md) and
[docs/chatgpt-review-hardening.md](docs/chatgpt-review-hardening.md) before
changing the tool surface or containment code.

## Limitations

- Windows is the validated operational platform for the hardened lifecycle and
  tunnel scripts.
- Only UTF-8 text files up to 1 MiB are read by the review profile.
- Search is bounded to 10,000 files and 200 matches.
- Common credential paths are blocked, but the bridge is not a comprehensive
  secret detector.
- The three handoff writers replace existing file contents; they do not merge.
- Same-user local races cannot be eliminated completely.
- Tunnel availability and control-plane authorization are external concerns.
- The first public snapshot will use fresh Git history; engineering tags and
  historical deployment material are intentionally not part of that snapshot.

## Compatibility and retained names

The public brand is RepoRelay. A small set of older names remains deliberately
because changing it would break compatibility with existing local setups or
protocol clients. `DEVSPACE_*` environment variables, the `chatgpt-review`
profile, the `X-DevSpace-Bridge-Secret` header, the `devspace` and
`chatgpt-codex-mcp` command aliases, and the `ops/DevSpaceChatGPT*.ps1`
filenames are retained compatibility identifiers. They are not separate public
products or additional security profiles. See
[docs/compatibility.md](docs/compatibility.md) for the complete inventory.

## Troubleshooting

### Node version is rejected

Run `node --version`. Install a version in the `>=22.19 <27` range, then run
`npm ci` again.

### Native dependencies fail to load

Run:

```powershell
npm rebuild better-sqlite3
node dist/cli.js doctor
```

### The workspace is rejected

Use one existing, absolute, canonical directory below—but not equal to—your
user profile. Links, junctions, missing paths, drive roots, multiple roots, and
user-profile ancestors are rejected.

### A file is listed as blocked

The path is a link, junction, hard link, VCS/credential directory, private-key
format, or common credential file. Copy only non-sensitive review material into
a regular file if review is genuinely required.

### The client can list tools but cannot open a workspace

Verify the local bridge first, then inspect the tunnel control-plane status.
Shallow health endpoints can pass while the external credential is rejected.
Do not weaken bridge authentication to work around a tunnel failure.

### Port 7676 is already in use

Use the lifecycle diagnostics to identify the recorded listener. Do not kill
unrelated Node processes. For isolated local testing, use `-SkipTunnel -Port
7677`.

## Development

Install dependencies and run the release verification suite from a clean
checkout:

```powershell
npm ci
npm run verify:release
```

For focused tests, operations checks, contribution conventions, and the full
verification matrix, see [CONTRIBUTING.md](CONTRIBUTING.md) and
[docs/setup.md](docs/setup.md).

## License and project history

This project started from `Waishnav/devspace`. The RepoRelay name and
restricted AI-client/coding-agent workflow are maintained independently and are
not affiliated with the unrelated Kubernetes product named DevSpace.

RepoRelay is licensed under the [MIT License](LICENSE). See
[CONTRIBUTING.md](CONTRIBUTING.md) for development and verification
requirements.
