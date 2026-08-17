# RepoRelay configuration

RepoRelay starts only as an authenticated loopback bridge. Configuration is
environment-based so secrets can come from protected operator storage without
being persisted in the repository.

| Variable | Required | Meaning |
| --- | --- | --- |
| `REPORELAY_HOST` | no | Must be `127.0.0.1`; defaults to it. |
| `REPORELAY_PORT` | no | Loopback port; defaults to `7676`. |
| `REPORELAY_ALLOWED_ROOTS` | yes in practice | Exactly one existing approved repository directory. |
| `REPORELAY_BRIDGE_AUTH` | no | Must be `1`; unauthenticated mode does not exist. |
| `REPORELAY_BRIDGE_SECRET` | yes | At least 32 characters. |
| `REPORELAY_HANDOFF_WRITES` | no | `1` enables the three fixed writers; default `0`. |
| `REPORELAY_PUBLIC_BASE_URL` | no | Local URL by default; non-loopback values must use HTTPS. |
| `REPORELAY_ALLOWED_HOSTS` | no | Explicit comma-separated host allowlist; wildcards are rejected. |
| `REPORELAY_LOG_LEVEL` | no | `silent`, `error`, `warn`, `info`, or `debug`. |
| `REPORELAY_LOG_FORMAT` | no | `json` or `pretty`. |
| `REPORELAY_LOG_REQUESTS` | no | Request logging; default `1`. |
| `REPORELAY_LOG_TOOL_CALLS` | no | Tool-call logging; default `1`. |
| `REPORELAY_CONFIG_DIR` | no | Optional location used by quickstart for the protected secret file. |

The header name is `X-RepoRelay-Bridge-Secret`. Header count is checked from
the raw request, so duplicate values are rejected. The secret is never printed
by the CLI or stored in runtime metadata.

The server does not load OAuth, database, agent, skill, artifact, or UI
configuration. Those inherited systems are not part of RepoRelay.
