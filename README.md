<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/reporelay-logo-dark.png">
    <img src="docs/assets/reporelay-logo.png" width="440" alt="RepoRelay">
  </picture>
</p>

<p align="center"><b>Give AI access to your repository &mdash; not your machine.</b></p>

RepoRelay is a local-first MCP bridge for reviewing one explicitly approved
repository. It gives ChatGPT a small set of safe repository tools instead of a
terminal: the bridge binds to loopback, requires authentication, and exposes
bounded repository read/search tools with optional fixed `.ai-handoff` writers.

| AI gets | AI does not get |
| --- | --- |
| Read files | Shell |
| Search files | Git |
| List directories | Process execution |
| Fixed handoff writes when enabled | Arbitrary writes |

![RepoRelay architecture: an authenticated AI reviewer reaches the loopback bridge, which exposes bounded read and search access to one approved repository and optional fixed handoff writers for a separate implementer.](docs/assets/reporelay-hero.png)

## Quick start

Requirements: Node.js `>=22.19 <27` and npm. Windows PowerShell is the
validated lifecycle environment.

```powershell
npm ci
npm run build
node dist/cli.js quickstart "C:\path\to\approved-repository"
```

Quickstart validates the canonical repository root, creates the four
pre-existing handoff files, generates a protected CLI quickstart bridge secret at
`%LOCALAPPDATA%\RepoRelay\reporelay-bridge-secret.txt`, starts the authenticated
loopback bridge, and self-tests the four/seven-tool surface. Use
`--no-handoff-writes` for read-only mode. Stop with Ctrl+C.

For a source checkout, use `node dist/cli.js` in place of `reporelay`.
`reporelay doctor` reports configuration and security status without printing
secret values.

After quickstart, run the independent local audit whenever you want a fresh
security check:

```powershell
node dist/cli.js audit "C:\path\to\approved-repository"
node dist/cli.js audit "C:\path\to\approved-repository" --json
```

The audit starts a temporary authenticated loopback listener, exercises the
real MCP surface, and uses a disposable adversarial fixture for containment and
fixed-handoff checks. It does not publish, deploy, or write to the approved
repository.

When RepoRelay is installed as a package, the equivalent commands are
`npx reporelay quickstart ...` and `npx reporelay audit ...`.

The MCP client must send `X-RepoRelay-Bridge-Secret` with the value loaded from
the protected secret file. Never put that value in source, command history,
logs, handoff files, or tickets.

## Public MCP surface

Read-only mode exposes exactly four tools:

| Tool | Purpose |
| --- | --- |
| `open_workspace` | Open an existing repository inside the one approved root. |
| `list_files` | List a contained real directory. Links are blocked. |
| `read_file` | Read one bounded, non-sensitive regular file. |
| `search_files` | Search bounded repository text with a literal query. |

With `REPORELAY_HANDOFF_WRITES=1`, exactly three pathless writers are added:

| Tool | Fixed target |
| --- | --- |
| `write_next_task` | `.ai-handoff/NEXT_TASK.md` |
| `write_review` | `.ai-handoff/REVIEW.md` |
| `update_handoff_state` | `.ai-handoff/STATE.json` |

Writer schemas accept only `workspaceId` and `content`. Targets must already
exist as regular files. `.ai-handoff/RESULT.md` is written by the separate
implementer and is not writable through RepoRelay.

RepoRelay contains no active public path for shell or process execution, Git
operations, arbitrary writes or patches, deletes, artifacts, worktrees,
local-agent execution, agent SDK orchestration, bundled skills/subagents, OAuth
routes, database-backed workspace persistence, or a React UI workspace.

## Handoff cycle

```text
AI reviewer
    ↓
NEXT_TASK.md + STATE.json
    ↓
Codex or Claude implementer
    ↓
RESULT.md + STATE.json
    ↓
AI reviewer reads the implementation
    ↓
REVIEW.md + STATE.json
```

The reviewer may inspect the repository and, when enabled, update only the
three fixed coordination files. The implementer is a separate local actor with
its own authorization; a handoff file never grants it permissions.

See the provider-neutral examples in [`examples/`](examples/) and the
[sample handoff cycle](examples/sample-handoff-cycle/README.md).

## Configuration

The bridge is intentionally small. The important environment variables are:

```text
REPORELAY_HOST=127.0.0.1
REPORELAY_PORT=7676
REPORELAY_ALLOWED_ROOTS=<one absolute repository path>
REPORELAY_BRIDGE_AUTH=1
REPORELAY_BRIDGE_SECRET=<32+ characters from protected storage>
REPORELAY_HANDOFF_WRITES=0
REPORELAY_PUBLIC_BASE_URL=http://127.0.0.1:7676
REPORELAY_ALLOWED_HOSTS=127.0.0.1
REPORELAY_LOG_LEVEL=info
REPORELAY_LOG_FORMAT=json
REPORELAY_LOG_REQUESTS=1
REPORELAY_LOG_TOOL_CALLS=1
```

See [`.env.example`](.env.example) and [docs/configuration.md](docs/configuration.md).
Remote review requires an independently secured HTTPS tunnel that forwards to
the loopback listener and injects the same header. The tunnel is not bundled
with RepoRelay.

## ChatGPT Web / Secure MCP Tunnel

ChatGPT Web connects to remote MCP servers; it does not connect directly to a
developer machine's `localhost`. For a private local RepoRelay bridge, use an
OpenAI Secure MCP Tunnel:

```text
ChatGPT Web
    ↓
OpenAI Secure MCP Tunnel
    ↓
local tunnel client
    ↓
127.0.0.1:<RepoRelay port>/mcp
    ↓
RepoRelay
    ↓
approved repository
```

The first-time flow is:

1. Run `quickstart` and keep the local bridge running.
2. In OpenAI Platform tunnel settings, create or select a tunnel and note its
   `tunnel_id`. Run the current `tunnel-client` inside the same local boundary,
   configure it to reach the printed MCP URL, and supply the
   `X-RepoRelay-Bridge-Secret` header from protected local file-backed storage.
   Keep the tunnel runtime API key protected as well; never paste either value
   into ChatGPT, source, or tracked configuration.
3. Use the existing Windows lifecycle scripts to verify the local side and the
   tunnel client. They run the tunnel client's `doctor --explain` checks, keep
   administration listeners on loopback, and test the exact RepoRelay tool
   surface. See [`docs/chatgpt-web.md`](docs/chatgpt-web.md).
4. In ChatGPT Web, enable developer mode if your workspace requires it, create
   a developer-mode custom app, choose **Tunnel** under **Connection**, and
   select the available tunnel or enter its `tunnel_id`. Follow the current
   app flow for required metadata/authentication and tool scanning. Do not
   enter `127.0.0.1` or `localhost` as a ChatGPT-hosted endpoint. Review the
   returned tools before creating the app; the expected surface is listed above
   and in [`SECURITY.md`](SECURITY.md).
5. Start a new chat, select the enabled app, and confirm safe list/read/search
   operations. Re-scan after any server change.

Read OpenAI's [Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
and [current developer-mode and MCP app instructions](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt)
for tunnel permissions, plan availability, and UI details that RepoRelay cannot
control. RepoRelay does not add a `connect chatgpt` command: the tunnel client
and ChatGPT workspace credentials remain operator-managed, so automating them
would add state and secret ownership without improving the security boundary.

## Windows lifecycle scripts

The scripts use the source checkout as their authority and keep runtime records
under `%LOCALAPPDATA%\RepoRelay` by default. Their managed lifecycle bridge
secret defaults to `%LOCALAPPDATA%\RepoRelay\tunnel-client\secrets\reporelay-bridge-secret.txt`,
which is intentionally distinct from the CLI quickstart secret path above:

```powershell
.\ops\Initialize-RepoRelayHandoff.ps1 -RepositoryRoot "C:\path\to\approved-repository" -Apply
.\ops\Start-RepoRelay.ps1 -WorkspaceRoot "C:\path\to\approved-repository" -BridgeSecretFile "C:\path\outside\reporelay-bridge-secret.txt" -SkipTunnel
.\ops\Test-RepoRelay.ps1 -WorkspaceRoot "C:\path\to\approved-repository"
.\ops\Stop-RepoRelay.ps1
```

The optional scheduled task is named `RepoRelay MCP`. Review `-WhatIf` output
before installing or changing it. See [OPERATIONS.md](OPERATIONS.md).

## Security

RepoRelay fails closed on unsafe configuration and enforces:

- loopback binding and a non-wildcard host allowlist;
- one existing canonical approved root, excluding drive roots and the user home
  directory or its ancestors;
- traversal, absolute escapes, symlinks, junctions/reparse points, and hard-link
  bypasses rejected during read and fixed-write resolution;
- sensitive-path blocking for `.env`, VCS metadata, credential stores, and
  private-key formats;
- bounded reads, searches, results, and handoff content;
- missing, incorrect, or duplicate bridge headers rejected before body parsing;
- constant-time secret comparison;
- no OAuth routes in the bridge;
- fixed-target handoff writers with no destination argument.

RepoRelay is not an operating-system sandbox for malicious software already
running as the same user. Choose the approved repository carefully and secure
any external tunnel separately. See [SECURITY.md](SECURITY.md).

## Development

```powershell
npm ci
npm run typecheck
npm test
npm run verify:release
npm audit --audit-level=low
npm pack --dry-run --json
```

The project is MIT-licensed. It retains appropriate upstream attribution and
does not bundle the SDKs or runtimes of Codex, Claude, or other implementers.
