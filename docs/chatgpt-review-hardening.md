# ChatGPT review security design

This document defines the security boundary for the public
`chatgpt-review` profile. The legacy privileged coding modes are not part of
this boundary.

## Threat model

Assume the remote MCP client can send malicious tool names, schemas, paths,
headers, search strings, and handoff content. The bridge protects the rest of
the local filesystem and prevents remote command execution.

The following are outside the remote-MCP adversary model:

- an already-authorized local process running as the same Windows user;
- compromise of the external tunnel or its control plane;
- credentials intentionally stored in ordinary repository files that are not
  covered by the sensitive-path denylist;
- a human or Codex process that executes malicious handoff instructions.

## Startup invariants

Bridge authentication fails closed unless all of these are true:

- `HOST` is exactly `127.0.0.1`;
- `DEVSPACE_TOOL_MODE` is exactly `chatgpt-review`;
- `DEVSPACE_ALLOWED_ROOTS` contains exactly one existing absolute directory;
- the directory is addressed by its canonical filesystem path;
- the root is not a drive/filesystem root, the user profile, or an ancestor of
  the user profile;
- the bridge secret contains at least 32 characters;
- wildcard Host-header allowlisting is disabled.

The invariant is rechecked when the HTTP server is constructed, preventing a
caller from loading a safe config and then widening it programmatically.

## Authentication

The authenticated bridge expects `X-DevSpace-Bridge-Secret` on every MCP
request. Missing, incorrect, and duplicate values are rejected. The server
compares SHA-256 digests with `timingSafeEqual` and never logs the secret.

OAuth routes are not registered in bridge-auth mode. The external tunnel must
inject the bridge header for both discovery and runtime traffic while keeping
the local listener private.

## Filesystem containment

`open_workspace` resolves only the selected approved root or a contained
canonical descendant. Review operations:

1. reject absolute and traversal escapes;
2. walk every existing path segment with `lstat`;
3. reject symbolic links and Windows junctions;
4. resolve the canonical target and recheck containment;
5. reject files with more than one hard link;
6. open the file and verify device/inode identity against a fresh resolution;
7. bound read and search sizes.

The profile also blocks common credential surfaces, including `.env` except
`.env.example`, VCS metadata directories, `.ssh`, `secrets`, `.npmrc`,
`.netrc`, common private-key names, and private-key/store extensions. This is
defense in depth, not a complete secret scanner.

Directory listing may report a protected path as blocked. Recursive search
skips it.

## Tool registration

The server returns immediately after registering the review tools, before any
generic coding tool is registered.

Default tools:

- `open_workspace`
- `list_files`
- `read_file`
- `search_files`

Optional fixed writers:

- `write_next_task`
- `write_review`
- `update_handoff_state`

The optional writer schemas contain only `workspaceId` and `content`. The
destination is selected in server code. Each target must already exist, pass
the same containment/link/identity checks, and remain within `.ai-handoff`.
`LUNA_RESULT.md` has no ChatGPT writer.

Artifacts, widgets, skills, subagents, worktrees, shell, process, Git, generic
write/edit/delete, and patch capabilities are disabled in review mode.

## Handoff integrity

The fixed writers prevent arbitrary filesystem mutation, but handoff content
is still model-authored input. A malicious or mistaken task can influence later
Codex work. Human authorization remains mandatory for destructive operations,
credentials, deployment, publishing, and scope expansion.

## Resource limits

- file reads: 1 MiB;
- handoff Markdown: 1 MiB;
- `STATE.json`: 64 KiB and a JSON object;
- search inventory: 10,000 files;
- search results: 200;
- returned search line: 500 characters.

## Residual limitations

An authorized same-user process can modify a file concurrently. Post-open
identity checks narrow but cannot eliminate every local race. Do not expose a
repository that untrusted local software can rewrite during review.

The tunnel is a separate system. Local health does not prove control-plane
authorization or ChatGPT connectivity. Verify authenticated polling and an
end-to-end MCP probe without logging credential material.

## Required verification

Run:

```powershell
npm run typecheck
npm run test:chatgpt-review
npm run test:chatgpt-release-runtime
npm run build
```

The focused tests cover tool enumeration, writer schemas, missing/wrong/
duplicate bridge headers, exact-root invariants, absolute/traversal paths,
junctions, hard links, sensitive-file denial, fixed writers, missing targets,
and `LUNA_RESULT.md` protection.
