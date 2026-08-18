# RepoRelay security policy

## Security boundary

RepoRelay is an authenticated, loopback-only MCP bridge for one explicitly
approved repository. The recommended CLI quickstart exposes exactly seven
tools by default: the four inspection tools `open_workspace`, `list_files`,
`read_file`, and `search_files`, plus the three fixed handoff writers. The
optional inspection-only quickstart (`--no-handoff-writes`) exposes exactly
four read/search tools, does not initialize `.ai-handoff`, and does not create
or modify `AGENTS.md`.

The three handoff writers `write_next_task`, `write_review`, and
`update_handoff_state` are pathless. They can replace only the pre-existing
`.ai-handoff/NEXT_TASK.md`, `.ai-handoff/REVIEW.md`, and
`.ai-handoff/STATE.json` files. `.ai-handoff/RESULT.md` remains implementer-
owned and is not a writer target.

The public server contains no active path for shell or process execution, Git,
arbitrary file creation or edits, patches, deletes, artifacts, worktrees,
local-agent execution, SDK orchestration, skills/subagents, OAuth, database
persistence, or UI workspace management.

## Enforced protections

- `REPORELAY_HOST` must be `127.0.0.1`.
- `REPORELAY_ALLOWED_ROOTS` must name exactly one existing canonical directory;
  drive roots, the user home, and its ancestors are rejected.
- Host allowlists are explicit and wildcard-free.
- The bridge requires `X-RepoRelay-Bridge-Secret`; missing, wrong, and duplicate
  headers are rejected before request-body parsing.
- Secret comparison uses fixed-length SHA-256 digests with constant-time
  comparison.
- Path traversal, absolute escapes, symlink/junction/reparse-point escapes,
  hard-linked files, and sensitive paths are rejected.
- Open-file identity is rechecked before reads and fixed-target writes complete.
- Reads, searches, results, and handoff documents have bounded sizes.
- Handoff targets must already exist and cannot be selected by the caller.
- OAuth discovery and authorization routes are absent.
- Quickstart bridge-secret files use owner-only mode on POSIX systems; on
  Windows quickstart removes inherited broad read access and grants read access
  only to the current user and `SYSTEM`, failing closed if that ACL operation
  cannot be applied.

## `reporelay audit`

`reporelay audit <repository>` is an executable local verification, not a
status banner. It validates the canonical approved root, loopback/authentication
configuration, starts a temporary authenticated loopback listener, checks
missing and incorrect credentials, discovers the actual MCP tools, and rejects
unexpected or dangerous tool capabilities. It also exercises the production
MCP path against a disposable fixture containing sensitive files, traversal,
outside-root, symlink/junction, and hard-link attacks. When handoff writers are
enabled, it verifies their fixed schemas and proves that `.ai-handoff/RESULT.md`
remains unchanged.

`reporelay audit <repository> --json` emits a stable JSON object with a
`schemaVersion`, `passed`, canonical `repository`, and per-check `id`, `area`,
`status`, and `message` fields. Exit code `0` means no check failed; any
failure or inability to establish the required authenticated checks returns a
non-zero exit code. The audit does not inspect or operate ChatGPT Web, an
external tunnel, or a public deployment, and it does not modify the approved
repository.

These checks are covered by the focused tests in `src/config.test.ts`,
`src/review-files.test.ts`, `src/mcp-tools.test.ts`, `src/bridge-auth.test.ts`,
and `src/audit.test.ts`.

## Limitations

RepoRelay is not an operating-system sandbox against malicious software already
running as the same user. Same-user races are narrowed by canonical and handle
identity checks but cannot be eliminated. The sensitive-path list is defense in
depth, not a complete secret scanner. An external HTTPS tunnel is a separate
security boundary and must be authenticated, loopback-restricted, and monitored
independently.

Do not approve a repository containing credentials that the reviewer should not
receive. Never put bridge secrets, tunnel keys, personal paths, or runtime logs
in source, examples, issues, or handoff files.

## Reporting

Do not open a public issue with exploit details or secrets. Use the repository's
private vulnerability reporting channel, including the affected version,
platform, Node version, safe fixture reproduction, expected/observed behavior,
impact, and mitigation.
