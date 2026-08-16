# Configuration reference

Copy [`.env.example`](../.env.example) to an untracked `.env` file. The
PowerShell operations scripts also accept equivalent parameters.

## Hardened bridge settings

| Variable | Required value or rule |
| --- | --- |
| `HOST` | `127.0.0.1` |
| `DEVSPACE_ALLOWED_ROOTS` | Exactly one absolute, existing repository path |
| `DEVSPACE_TOOL_MODE` | `chatgpt-review` |
| `DEVSPACE_CHATGPT_BRIDGE_AUTH` | `1` |
| `DEVSPACE_CHATGPT_BRIDGE_SECRET` | A unique random value of at least 32 characters |
| `DEVSPACE_HANDOFF_WRITES` | `1` to enable the three fixed handoff writers; otherwise `0` |
| `DEVSPACE_PUBLIC_BASE_URL` | The exact HTTPS tunnel origin when a tunnel is used |
| `DEVSPACE_ALLOWED_HOSTS` | The tunnel hostname, not `*` |
| `DEVSPACE_WIDGETS` | `off` for the review bridge |
| `DEVSPACE_ARTIFACTS` | `0` for the review bridge |
| `DEVSPACE_SKILLS` | `0` for the review bridge |
| `DEVSPACE_SUBAGENTS` | `0` for the review bridge |

Do not commit `.env`. The committed `.env.example` contains placeholders only.

## Tool modes

`chatgpt-review` is the default and the only public-safe profile documented for
ChatGPT. It exposes four read-only repository tools and, when explicitly
enabled, three writers restricted to `.ai-handoff`.

Other modes (`minimal`, `full`, and `codex`) are privileged compatibility
surfaces. Depending on mode, they can expose generic writes or command/process
execution. They are outside the hardened bridge security claim and must not be
made available to an untrusted client.

## Workspace selection

The approved root is fixed when the server starts. `open_workspace` can select
only that root; it cannot add a new root or escape it. To change repositories,
stop the service, update the approved root, initialize that repository's
handoff directory, and restart.

See [Security](../SECURITY.md) and
[Review hardening](chatgpt-review-hardening.md) for the enforced invariants.
