# RepoRelay setup

The supported public setup is the hardened `chatgpt-review` bridge described in
the [project README](../README.md). Start there for the complete walkthrough.

## Quick checklist

1. Install Node.js 22.19-26, npm, Git for Windows, and PowerShell 5.1 or newer
   (PowerShell 7 is recommended).
2. Run `npm ci` and `npm run verify:release` from the repository checkout.
3. Use `.env.example` as a reference; pass real values through protected
   process environment or the lifecycle-script parameters.
4. Set `DEVSPACE_ALLOWED_ROOTS` to exactly one absolute repository path.
5. Keep `DEVSPACE_TOOL_MODE=chatgpt-review` and bridge authentication enabled.
6. Run `ops/Initialize-DevSpaceChatGPTHandoff.ps1 -RepositoryRoot
   "C:\path\to\approved-repository" -Apply`.
7. Start locally with `ops/Start-DevSpaceChatGPT.ps1 -WorkspaceRoot
   "C:\path\to\approved-repository" -BridgeSecretFile
   "C:\path\outside-repositories\bridge-secret.txt" -SkipTunnel`, or follow
   the authenticated tunnel procedure in the README.

The bridge refuses to start if the root or authentication configuration is
unsafe. Do not work around those checks.

If Windows PowerShell blocks the `npm.ps1` shim, use `npm.cmd` for the npm
commands. `node dist/cli.js doctor` reports the active Node, Git, SQLite,
tool-mode, authentication, handoff, root, and host configuration without
printing secret values.

## Privileged compatibility modes

The source retains older generic modes for upstream compatibility. They can
include mutation and command-execution tools and are not part of the hardened
public workflow. Do not expose them to ChatGPT or an untrusted MCP client.
