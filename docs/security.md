# RepoRelay security notes

The security boundary is the source path in `src/server.ts`,
`src/config.ts`, `src/workspaces.ts`, and `src/review-files.ts`. The server
registers only the four read/search tools and, when explicitly enabled, the
three fixed handoff writers.

Containment is defense in depth: lexical containment is followed by canonical
root checks, per-segment link checks, sensitive-path checks, hard-link checks,
and an open-handle identity check. Writers resolve only fixed pre-existing
targets and normalize `STATE.json` as an object.

Authentication runs before MCP body parsing. The bridge rejects missing,
incorrect, and duplicate `X-RepoRelay-Bridge-Secret` headers. The listener is
loopback-only and wildcard host configuration is rejected. OAuth routes are not
registered.

The test evidence is intentionally split by concern:

- `src/config.test.ts` covers safe startup configuration;
- `src/review-files.test.ts` covers traversal, sensitive paths, links,
  hard-links, bounded search, and fixed writes;
- `src/mcp-tools.test.ts` covers exact four/seven-tool registration and writer
  schemas;
- `src/bridge-auth.test.ts` covers HTTP authentication order and OAuth absence.

RepoRelay does not claim to sandbox another same-user process or to discover
every secret in an arbitrary repository. Secure the approved root and any
external tunnel as separate operator responsibilities.
