# RepoRelay security policy

## Supported versions

Security fixes are applied to the latest release on the default branch. Older
tags are retained for engineering provenance but are not supported public
deployments.

## Report a vulnerability

Do not open a public issue for a suspected vulnerability or include secrets,
private repository content, tunnel credentials, or exploit details in public
discussion.

Use GitHub's private vulnerability reporting for
`Lukie-81/reporelay`. If private reporting is unavailable, open a
minimal issue asking the maintainer to enable a private channel without
including technical details.

Include:

- the affected version or commit;
- the operating system and Node.js version;
- the exposed MCP profile and authentication mode;
- reproduction steps using non-sensitive fixtures;
- expected and observed behavior;
- the security impact and any known mitigation.

## Security boundary

The public-safe deployment is `DEVSPACE_TOOL_MODE=chatgpt-review` on loopback.
For ChatGPT Web through a tunnel, enable bridge authentication and inject the
dedicated `X-DevSpace-Bridge-Secret` header from protected local storage.

That profile exposes four repository inspection tools. When handoff writes are
enabled, it adds three fixed-target writers under `.ai-handoff`. It does not
register shell, process, Git, generic write/edit/delete, patch, worktree,
artifact, skill, subagent, or widget tools.

The legacy `minimal`, `full`, and `codex` modes are privileged local coding
surfaces. They are not the security boundary documented for this project and
must never be exposed through the unauthenticated bridge configuration.

See [README.md](README.md#security-model) and
[docs/chatgpt-review-hardening.md](docs/chatgpt-review-hardening.md) for the
complete threat model and operational limitations.

## Secrets

- Keep bridge and tunnel credentials outside repositories and command history.
- Do not expose a repository containing credentials the reviewer should not
  receive.
- The review profile denies common credential paths and private-key formats,
  but this is defense in depth rather than a general secret scanner.
- Rotate any credential that may have been disclosed before reporting it.
