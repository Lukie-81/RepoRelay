# RepoRelay setup

## Install from a checkout

```bash
npm ci
npm run build
```

npm is the supported global installer (`npm install -g reporelay-mcp@latest`).
After a global or local npm install, the public command is `reporelay`. In a
checkout, `node dist/cli.js` is equivalent. If `reporelay` cannot be found
after installing with another package manager (Bun, pnpm, yarn), that package
manager's global-bin directory is probably not on your `PATH`; fix its PATH
configuration or reinstall with npm.

## Quickstart

The recommended default is the 7-tool handoff surface:

```bash
reporelay quickstart "$HOME/Projects/approved-repository"
```

The command requires a real repository directory narrower than the operator's
home directory. When you omit the repository path, the current directory
becomes the approved repository and the summary says so explicitly; only this
default depends on the current directory, and the tunnel commands work from
any directory once configured. Quickstart creates missing `.ai-handoff`
targets without replacing existing ones, generates a 32-byte bridge secret,
starts the loopback server, and checks missing/wrong authentication plus the
exact tool surface.

The default quickstart exposes exactly 7 tools (4 inspection + 3 fixed handoff
writers). The read-only mode — the recommended starting mode for personal
ChatGPT workspaces where developer mode and Tunnel are available — exposes
exactly 4 tools and leaves the repository unchanged:

```bash
reporelay quickstart "$HOME/Projects/approved-repository" --no-handoff-writes
```

Read-only mode does not create `.ai-handoff`, does not create or modify
`AGENTS.md`, and does not require `--append-agent-instructions`.

Use `--append-agent-instructions` only when an existing `AGENTS.md` has been
reviewed; quickstart backs it up outside the repository before appending. An
existing `AGENTS.md` without the RepoRelay marker stops quickstart with a
clear explanation unless you pass that flag.

Quickstart records its live local endpoint so the managed tunnel configuration
follows it. A custom port (`--port 7677`) therefore flows through
`reporelay tunnel setup`, `reporelay tunnel doctor`, and
`reporelay tunnel run` without manual YAML editing.

After quickstart, run an independent audit. It starts its own temporary
authenticated loopback listener and exercises the real MCP surface plus
disposable containment fixtures:

```bash
reporelay audit "$HOME/Projects/approved-repository"
reporelay audit "$HOME/Projects/approved-repository" --json
```

If you used `--no-handoff-writes` for quickstart, add that flag to the audit
command too.

## Connect a reviewer

Use the printed local MCP URL and load the header value from the protected file:

```text
X-RepoRelay-Bridge-Secret: <value loaded from protected storage>
```

For remote review, use an external authenticated HTTPS MCP tunnel that forwards
to the loopback server and injects this header. Do not expose the local port or
replace the header with a public proxy.

See [ChatGPT Web connection](chatgpt-web.md) for the complete Secure MCP Tunnel
and ChatGPT developer-mode flow. ChatGPT Web cannot connect directly to the
local loopback URL.

## Manual Windows lifecycle

See [OPERATIONS.md](../OPERATIONS.md) for the recoverable handoff initializer,
start/stop/restart, diagnostics, tunnel protection, and optional `RepoRelay MCP`
scheduled task.
