# RepoRelay

**Give AI access to your repository — not your machine.**

[![CI](https://github.com/Lukie-81/RepoRelay/actions/workflows/ci.yml/badge.svg)](https://github.com/Lukie-81/RepoRelay/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.19%20%3C27-339933)](https://github.com/Lukie-81/RepoRelay/blob/main/package.json)

RepoRelay is a security-focused MCP bridge that lets an AI client such as
ChatGPT inspect one explicitly approved local repository — without exposing a
shell, Git access, process execution, unrestricted filesystem access, or
arbitrary writes. When you want changes made, the AI prepares a bounded task in
a fixed handoff file, a separate local coding agent implements it with its own
permissions, and the AI reviews the result.

RepoRelay is a substantially modified, security-focused derivative of DevSpace
v1.0.5 (`Waishnav/devspace`), adapted around a narrower AI-review and
coding-agent handoff model. See
[Upstream and project history](#upstream-and-project-history).

RepoRelay is an independent open-source project. ChatGPT, Codex, and MCP are
used only as descriptive names for supported clients and protocols.

## Why RepoRelay?

Most ways to connect an AI to local code give the agent a shell, a Git binary,
and the whole filesystem. RepoRelay takes the opposite approach: the AI client
gets a deliberately narrow tool surface over one repository you explicitly
approve.

| The AI client can                                          | The AI client cannot                       |
| ---------------------------------------------------------- | ------------------------------------------ |
| Read files inside the approved repository                  | Run shell commands                         |
| Search and list repository content                         | Execute Git or other processes             |
| Read project instructions such as `AGENTS.md`              | Browse files anywhere else on the machine  |
| Update three fixed `.ai-handoff` files — only if you enable it | Create, edit, delete, or patch arbitrary files |

Handoff writes are **optional and off by default**. When enabled
(`DEVSPACE_HANDOFF_WRITES=1`), the three writers accept only content — never a
destination path — and target three pre-existing files under `.ai-handoff/`.

Three parties hold different authority:

- The **AI client** is limited to the narrow tool surface above. RepoRelay
  assumes it may be malicious.
- The **coding agent** is a separate local program with whatever permissions
  you grant it directly. RepoRelay neither constrains nor empowers it — a
  handoff file coordinates work, it does not grant permissions.
- **You** remain the authority for destructive actions, credentials,
  deployment, publishing, and expanding what is exposed.

## How it works

```text
AI / MCP client (e.g. ChatGPT Web)
      |
      |  authenticated MCP: loopback + optional HTTPS tunnel
      v
 RepoRelay (chatgpt-review bridge)
      |
      |-- read/search ------------------->  the one approved repository
      |
      |-- optional fixed writes ---------->  .ai-handoff/
      |                                       NEXT_TASK / REVIEW / STATE
      |                                             |
      |                                             v
      |                                     coding agent (separate local actor)
      |                                             |
      |                                             |  implements + verifies,
      |                                             |  writes LUNA_RESULT.md
      |                                             v
      |                                     AI reviews the result
```

- RepoRelay sits between the AI client and the approved repository and exposes
  a deliberately narrow tool surface: four read tools, plus three optional
  fixed writers.
- The coding agent works locally with its own authorization and records its
  result. RepoRelay never executes it — or any shell, Git, or process.
- `.ai-handoff` files coordinate the loop; they never grant either side new
  permissions.

## Quick start

Windows 10/11 with PowerShell is the validated platform for the lifecycle
scripts below; the test suite also runs on Linux and macOS in CI. If your
execution policy blocks `npm.ps1`, use `npm.cmd`.

### 1. Install and verify

```powershell
git clone https://github.com/Lukie-81/RepoRelay.git
Set-Location RepoRelay
npm ci
npm run verify:release
node dist/cli.js doctor
```

`npm run verify:release` runs type checking, the full test suite, the
authenticated bridge runtime test, and a production build.

### 2. Prepare the approved repository

Choose one existing repository directory — never a drive root, your user
profile, or anything containing credentials the AI should not read. Preview the
handoff layout, then apply it:

```powershell
.\ops\Initialize-DevSpaceChatGPTHandoff.ps1 `
  -RepositoryRoot "C:\path\to\approved-repository"

.\ops\Initialize-DevSpaceChatGPTHandoff.ps1 `
  -RepositoryRoot "C:\path\to\approved-repository" `
  -Apply
```

This creates the four fixed `.ai-handoff` files. If the repository already has
an `AGENTS.md`, the script fails closed unless you explicitly pass
`-AppendAgentInstructions`.

### 3. Create a bridge secret

Generate a random value of at least 32 characters and store it in a protected
file outside every repository, for example
`C:\path\outside-repositories\bridge-secret.txt`. Never commit it or paste it
into command history, logs, or issues.

### 4. Start and validate locally

```powershell
.\ops\Start-DevSpaceChatGPT.ps1 `
  -WorkspaceRoot "C:\path\to\approved-repository" `
  -BridgeSecretFile "C:\path\outside-repositories\bridge-secret.txt" `
  -SkipTunnel `
  -Port 7677

.\ops\Test-DevSpaceChatGPT.ps1 `
  -WorkspaceRoot "C:\path\to\approved-repository"
```

The test verifies the recorded process, loopback listener, unauthenticated
rejection, authenticated tool list, handoff layout, and secret-free runtime
logs.

### 5. Connect a remote MCP client

For a remote client such as ChatGPT Web, put an authenticated HTTPS MCP tunnel
in front of the loopback bridge and configure it to inject the
`X-DevSpace-Bridge-Secret` header on every request. The tunnel client is
external to this repository; see the
[OpenAI secure MCP tunnels guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
and [OPERATIONS.md](OPERATIONS.md) for the full tunnel lifecycle. Do not
substitute a public unauthenticated proxy.

For the configuration checklist, every setting, and operational edge cases,
see [docs/setup.md](docs/setup.md), [docs/configuration.md](docs/configuration.md),
and [OPERATIONS.md](OPERATIONS.md).

## The constrained tool surface

The public profile is `chatgpt-review`. It registers four read-only tools:

| Tool            | Purpose                                                        |
| --------------- | -------------------------------------------------------------- |
| `open_workspace` | Open the one approved repository for this server process.     |
| `list_files`    | List a contained directory; links and junctions are not followed. |
| `read_file`     | Read a contained regular text file, up to 1 MiB.               |
| `search_files`  | Search contained text files with bounded results.              |

Setting `DEVSPACE_HANDOFF_WRITES=1` adds exactly three fixed-target writers —
seven tools in total:

| Tool                  | Fixed destination             |
| --------------------- | ----------------------------- |
| `write_next_task`     | `.ai-handoff/NEXT_TASK.md`    |
| `write_review`        | `.ai-handoff/REVIEW.md`       |
| `update_handoff_state` | `.ai-handoff/STATE.json`     |

The writer schemas accept only `workspaceId` and `content`. There is no path
parameter; the destination is fixed in server code, and all three targets must
already exist as regular files. `.ai-handoff/LUNA_RESULT.md` is reserved for
the coding agent and has no AI writer.

The review profile registers no shell, process, Git, generic write/edit/delete,
patch, worktree, artifact, skill, subagent, or widget tools. Older privileged
modes (`minimal`, `full`, `codex`) remain in the source for compatibility; they
are local engineering surfaces, must never be exposed through a tunnel, and are
not the public security boundary. Details:
[docs/chatgpt-review-hardening.md](docs/chatgpt-review-hardening.md).

## Structured coding-agent handoffs

| File                        | Author       | Purpose                                        |
| --------------------------- | ------------ | ---------------------------------------------- |
| `.ai-handoff/NEXT_TASK.md`  | AI client    | The next bounded task for the coding agent.    |
| `.ai-handoff/LUNA_RESULT.md` | Coding agent | The local implementation and verification result. |
| `.ai-handoff/REVIEW.md`     | AI client    | An independent review of the current result.   |
| `.ai-handoff/STATE.json`    | AI client    | Structured handoff status.                     |

1. The AI client opens the workspace and independently reviews the repository.
2. For a task you approve, it writes `NEXT_TASK.md` and updates `STATE.json`.
3. The coding agent implements only the authorized scope, verifies it locally,
   and writes `LUNA_RESULT.md`.
4. The AI client reviews the changed repository, writes `REVIEW.md`, and may
   prepare the next bounded task.

Treat every handoff file as untrusted model-authored content: review it before
acting on it, and never place secrets or personal data in the handoff
directory. See [docs/chatgpt-coding-workflow.md](docs/chatgpt-coding-workflow.md).

## Security model

The bridge assumes the remote MCP client may be malicious, and fails closed at
startup unless its configuration is safe. It enforces:

- a loopback-only listener (`HOST=127.0.0.1`);
- exactly one approved root, addressed by its canonical path — drive roots, the
  user profile, and its ancestors are rejected;
- containment on every path: traversal and absolute-escape rejection,
  per-segment `lstat` checks, symlink and junction rejection, hard-link
  rejection, and post-open file-identity verification;
- a sensitive-path denylist (`.env`, `.git`, `.ssh`, private keys, credential
  stores) as defense in depth — `.env.example` stays readable;
- bounded read, search, result, and handoff sizes;
- constant-time comparison of the bridge secret: missing, incorrect, or
  duplicate headers are rejected, and OAuth routes are absent in bridge-auth
  mode;
- pathless, fixed-destination writer schemas, only when explicitly enabled.

Honest limits: RepoRelay is **not** a sandbox against malicious software
already running locally as the same user; same-user filesystem races are
narrowed but not eliminated; a tunnel is an external control plane that must be
secured and verified separately; and the denylist is not a comprehensive secret
scanner. RepoRelay also does not make an arbitrary repository safe to disclose —
choose the approved root carefully.

Full details: [SECURITY.md](SECURITY.md) and
[docs/chatgpt-review-hardening.md](docs/chatgpt-review-hardening.md).

## Requirements

- Windows 10 or 11 — the validated platform for the hardened lifecycle and
  tunnel scripts (tests also run on Linux and macOS in CI);
- Windows PowerShell 5.1 or newer (PowerShell 7 recommended for development);
- Node.js `>=22.19 <27` and npm;
- Git;
- for remote clients, an HTTPS MCP tunnel that can inject a protected request
  header (not bundled).

## Documentation

| Document                                                       | Purpose                                            |
| -------------------------------------------------------------- | -------------------------------------------------- |
| [docs/setup.md](docs/setup.md)                                 | Installation and configuration checklist           |
| [docs/configuration.md](docs/configuration.md)                 | Configuration reference for the hardened bridge    |
| [OPERATIONS.md](OPERATIONS.md)                                 | Start, stop, diagnostics, tunnel lifecycle         |
| [SECURITY.md](SECURITY.md)                                     | Security policy and vulnerability reporting        |
| [docs/chatgpt-review-hardening.md](docs/chatgpt-review-hardening.md) | The detailed AI-review containment model       |
| [docs/chatgpt-coding-workflow.md](docs/chatgpt-coding-workflow.md) | The review → handoff → implement → review cycle |
| [docs/compatibility.md](docs/compatibility.md)                 | Retained legacy identifiers                        |
| [docs/gotchas.md](docs/gotchas.md)                             | Troubleshooting                                    |
| [CONTRIBUTING.md](CONTRIBUTING.md)                             | Development and verification requirements          |

## Limitations

- Windows is the validated operational platform; the lifecycle scripts are
  PowerShell.
- The review tools read UTF-8 text files up to 1 MiB; binary files are not
  readable.
- Search is bounded to 10,000 files and 200 matches.
- Credential-path blocking is defense in depth, not a universal secret
  detector.
- The three handoff writers replace entire file contents; they do not merge.
- Authorized same-user local processes can still race or modify files.
- Tunnel availability and control-plane authorization are external concerns.

## Compatibility

The public brand is RepoRelay, but older identifiers are deliberately retained
so existing local setups keep working: `DEVSPACE_*` environment variables, the
`chatgpt-review` profile name, the `X-DevSpace-Bridge-Secret` header, the
`devspace` and `chatgpt-codex-mcp` command aliases, and the
`ops/DevSpaceChatGPT*.ps1` script names. They are compatibility identifiers,
not separate products or additional security profiles. See
[docs/compatibility.md](docs/compatibility.md).

## Upstream and project history

RepoRelay is a substantially modified, security-focused derivative of
`Waishnav/devspace`. The lineage traces to approximately DevSpace v1.0.5,
carried through a previous engineering repository; the public repository starts
from fresh Git history. DevSpace is the upstream project — current upstream
development is independent and may differ substantially from that baseline.

Added on top of that baseline, RepoRelay's own direction includes:

- the constrained `chatgpt-review` profile with a four-read / optional
  seven-tool AI-facing surface;
- fixed, pathless `.ai-handoff` writers;
- sensitive-file blocking and canonical-path containment, including defenses
  against links, junctions, and hard links;
- bridge authentication and tunnel/runtime hardening;
- the structured AI-client → coding-agent → review workflow;
- Windows lifecycle tooling, diagnostics, and release verification.

RepoRelay is maintained independently and is not affiliated with the unrelated
Kubernetes product named DevSpace. The [MIT License](LICENSE) preserves the
required upstream notices.

## Contributing

Contributions must preserve the narrow review boundary. From a clean checkout:

```powershell
npm ci
npm run verify:release
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for change requirements and the full
verification matrix.

## License

[MIT](LICENSE). The license file preserves the upstream DevSpace copyright
notice alongside the RepoRelay contributors notice.
