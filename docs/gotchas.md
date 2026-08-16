# Troubleshooting and gotchas

## The server refuses to start

This is usually a deliberate fail-closed check. Confirm that:

- the host is `127.0.0.1`;
- exactly one absolute repository is configured;
- the root exists and resolves canonically;
- `DEVSPACE_TOOL_MODE` is `chatgpt-review`;
- bridge authentication is enabled; and
- the secret is unique and at least 32 characters.

## ChatGPT receives 401 or 403

Verify the connector sends one `X-DevSpace-Bridge-Secret` header whose value
matches the server. Missing, duplicated, or incorrect credentials are rejected.
Also check the configured public origin and host allowlists.

## A repository file is rejected

The review tools intentionally reject paths outside the approved root,
symlinks/junctions, multi-linked files, special files, and sensitive metadata
such as `.git`, `.env`, private keys, and credential files. `.env.example` is
the safe exception for documenting placeholders.

## A handoff write is rejected

Only these fixed files may be written:

- `.ai-handoff/NEXT_TASK.md`
- `.ai-handoff/REVIEW.md`
- `.ai-handoff/STATE.json`

Run `ops/Initialize-DevSpaceChatGPTHandoff.ps1` once for the approved root and
do not replace `.ai-handoff` with a link or junction.

## A privileged tool appears

Stop the server. The public bridge should expose four read tools plus at most
three fixed handoff writers. Shell, process, Git, generic write/edit, artifact,
widget, skill, and subagent tools indicate the wrong profile.

## Tunnel connectivity fails

Test the loopback service first. Then verify the tunnel process, public URL,
hostname allowlists, and connector header. Tunnel-provider access controls are
an additional layer; they do not replace the bridge secret.

See [OPERATIONS.md](../OPERATIONS.md) for commands and log locations.
