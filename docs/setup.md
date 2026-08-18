# RepoRelay setup

## Install from a checkout

```powershell
npm ci
npm run build
```

After a global or local npm install, the public command is `reporelay`. In a
checkout, `node dist/cli.js` is equivalent.

## Quickstart

The recommended default is the 7-tool handoff surface:

```powershell
reporelay quickstart "C:\path\to\approved-repository"
```

The command requires a real repository directory narrower than the operator's
home directory. It creates missing `.ai-handoff` targets without replacing
existing ones, generates a 32-byte bridge secret, starts the loopback server,
and checks missing/wrong authentication plus the exact tool surface.

The default quickstart exposes exactly 7 tools (4 inspection + 3 fixed handoff
writers). The optional inspection-only mode exposes exactly 4 tools and leaves
the repository unchanged:

```powershell
reporelay quickstart "C:\path\to\approved-repository" --no-handoff-writes
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

```powershell
reporelay audit "C:\path\to\approved-repository"
reporelay audit "C:\path\to\approved-repository" --json
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
