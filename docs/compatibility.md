# Compatibility names

RepoRelay is the public brand for this release. The exported snapshot retains
the following older identifiers because they are part of existing local
configuration, scripts, or protocol behavior:

| Retained identifier | Why it remains |
| --- | --- |
| `DEVSPACE_*` environment variables | Existing configuration and fail-closed profile checks use these names. |
| `devspace` and `chatgpt-codex-mcp` command aliases | Existing local launch commands should continue to work; `reporelay` is the primary command. |
| `chatgpt-review` profile | This is the established security-profile value used by configuration and tests. |
| `X-DevSpace-Bridge-Secret` | Remote connectors and tunnel configuration depend on the established header name. |
| `ops/DevSpaceChatGPT*.ps1` filenames and function names | PowerShell scripts may be referenced by existing operator configuration and task definitions. |
| `devspace-local-artifacts` package identifier | The local-agent PATH guard recognizes this older package name when filtering its own `.bin` directory. |
| Internal `DevSpace` and `chatgpt` source identifiers | They describe compatibility code, protocol clients, fixtures, or non-public legacy modes. |

These names do not create additional public products, roots, tools, or
permissions. The documented public security boundary remains the authenticated
`chatgpt-review` profile with one approved canonical root and, optionally,
three fixed handoff writers.

The stale engineering repository name, old GitHub URLs, personal paths, tunnel
credentials, and deployment state are not retained in the public metadata.
